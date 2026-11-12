// R-OWN-22 (E540–E545): the staged deactivation moves the member's open team listings (coming soon, active, pending)
// before it removes them, through the one audited listing-agent writer (workspace/listings.ts setListingAgentInTx).
// Real Postgres as app_user through the real server; the job runs as the worker's system actor; the superuser only
// reads state back and writes fixtures with no application path (an open deal, an MLS row).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { generateAll, marketingWorld, teamListing } from '../marketing/testing.js';
import { draftsOf, reconcile, sellerListing } from '../sellerUpdates/testing.js';
import { silentLogger, memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { type DeactivatePayload, deactivationHandler } from './deactivation.js';
import { call, freshReauth, jobs, leadsWorker, leadsWorld, randomPhone } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agentOf = async (listingId: string): Promise<string> => (await h.su.query('SELECT listing_agent_user_id AS u FROM listings WHERE id = $1', [listingId])).rows[0].u;
const agentAudits = async (listingId: string) =>
  (await h.su.query("SELECT actor_kind, actor_user_id, reason, changes FROM audit_log WHERE action = 'listing.agent_changed' AND entity_id = $1 ORDER BY seq", [listingId])).rows;
const statusOf = async (tenantId: string, userId: string | null): Promise<string> => (await h.su.query('SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])).rows[0].status;

async function addTeamLead(owner: TestClient, members: TestClient[]): Promise<TestClient> {
  const tl = await h.invite(owner, 'team_lead');
  await freshReauth(h, owner);
  const team = await call<{ team: { id: string } }>(owner, 'POST', '/teams', { name: 'Team A' });
  const put = await call(owner, 'PUT', `/teams/${team.body.team.id}/members`, { members: [...members.map((m) => ({ userId: m.userId, isLead: false })), { userId: tl.userId, isLead: true }] });
  if (put.status !== 200) throw new Error(`team: ${put.status} ${JSON.stringify(put.body)}`);
  return tl;
}

async function openDeal(owner: TestClient, ownerUserId: string | null): Promise<string> {
  const id = randomUUID();
  const c = await call<{ contact: { id: string } }>(owner, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Deal Buyer', phones: [randomPhone()] });
  if (c.status !== 201) throw new Error(`contact: ${c.status}`);
  await withTenantTx(owner.actor(), async (tx) => {
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
              VALUES (app.tenant_id(), ${id}::uuid, 'Open purchase', 'buy', 'active', now(), ${c.body.contact.id}::uuid, ${ownerUserId}::uuid)`.execute(tx);
  }, { db: h.database });
  return id;
}

async function suspend(owner: TestClient, tenantId: string, userId: string | null): Promise<void> {
  await freshReauth(h, owner);
  const v = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])).rows[0]!.version;
  const r = await call(owner, 'PATCH', `/members/${userId}`, { status: 'suspended', version: v });
  if (r.status !== 200) throw new Error(`suspend: ${r.status} ${JSON.stringify(r.body)}`);
}

type Deactivation = { owned: number; offered: number; openListings: number; openDeals: number; teamLead: { userId: string } | null; fallbackUserId: string; status: string };

describe('R-OWN-22 deactivation moves open team listings', () => {
  it('R-OWN-22 E540: preview counts open listings and open deals; run moves the 3 open team listings to the Team Lead, one listing.agent_changed each (system, OWNER_DEACTIVATED); sold listing and open deal keep the member; a draft\'s review card moves; the member ends removed', async () => {
    const w = await marketingWorld(h);
    const a = w.agent;
    const tl = await addTeamLead(w.owner, [a]);
    // w.listingId is coming_soon; plus an active and a pending one; a sold one stays
    const open = [w.listingId, await teamListing(a, { status: 'active' }), await teamListing(a, { status: 'pending' })];
    const sold = await teamListing(a, { status: 'sold' });
    const deal = await openDeal(w.owner, a.userId);
    const pieces = Object.values(await generateAll(a, w.listingId)).map((p) => p.id);
    expect(pieces.length).toBeGreaterThan(0);
    const reviewCards = async () =>
      (await h.su.query<{ user_id: string; state: string }>("SELECT user_id, state FROM priority_feed_items WHERE item_type = 'marketing_review' AND subject_id = ANY($1::uuid[]) ORDER BY user_id, state", [pieces])).rows;
    expect((await reviewCards()).filter((c) => c.state === 'open').every((c) => c.user_id === a.userId)).toBe(true);

    await freshReauth(h, w.owner);
    const preview = await call<{ deactivation: Deactivation }>(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'preview', destination: 'default_pond' });
    expect(preview.status).toBe(200);
    expect(preview.body.deactivation).toMatchObject({ openListings: 3, openDeals: 1, teamLead: { userId: tl.userId } });
    for (const id of open) expect(await agentOf(id)).toBe(a.userId); // preview changes nothing

    const run = await call<{ deactivation: Deactivation }>(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status).toBe(202);
    expect(run.body.deactivation.openListings).toBe(3);
    await leadsWorker(h).drain();

    for (const id of open) {
      expect(await agentOf(id)).toBe(tl.userId);
      const au = await agentAudits(id);
      expect(au).toHaveLength(1);
      expect(au[0]).toMatchObject({ actor_kind: 'system', actor_user_id: null, reason: 'OWNER_DEACTIVATED' });
    }
    expect(await agentOf(sold)).toBe(a.userId);
    expect(await agentAudits(sold)).toHaveLength(0);
    expect((await h.su.query('SELECT owner_user_id AS u FROM deals WHERE id = $1', [deal])).rows[0].u).toBe(a.userId);
    // the departed agent's review cards closed and the Team Lead's opened, in the move's transaction
    const cards = await reviewCards();
    expect(cards.filter((c) => c.state === 'open').map((c) => c.user_id)).toEqual(pieces.map(() => tl.userId));
    expect(cards.filter((c) => c.user_id === a.userId).every((c) => c.state !== 'open')).toBe(true);
    expect(await statusOf(w.tenantId, a.userId)).toBe('removed');
  });

  it('R-OWN-22 E541: with no Team Lead an Admin\'s run moves them to the Admin; if the Admin is suspended before the job, to the Owner', async () => {
    const w = await leadsWorld(h, { agents: 2, others: ['admin'], push: false });
    const admin = w.others[0]!;
    const [a, b] = w.agents as [TestClient, TestClient];
    const la = await teamListing(a, { status: 'active' });
    const lb = await teamListing(b, { status: 'active' });

    await freshReauth(h, admin);
    const ra = await call<{ deactivation: Deactivation }>(admin, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(ra.status).toBe(202);
    expect(ra.body.deactivation).toMatchObject({ teamLead: null, fallbackUserId: admin.userId, openListings: 1 });
    await leadsWorker(h).drain();
    expect(await agentOf(la)).toBe(admin.userId);

    await freshReauth(h, admin);
    const rb = await call(admin, 'POST', `/members/${b.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(rb.status).toBe(202);
    await suspend(w.owner, w.tenantId, admin.userId); // before the job runs
    await leadsWorker(h).drain();
    expect(await agentOf(lb)).toBe(w.owner.userId);
    expect(await statusOf(w.tenantId, b.userId)).toBe('removed');
  });

  it('R-OWN-22 E542: zero leads, two open listings: PATCH removal is 409 MEMBER_HAS_LISTINGS', async () => {
    const w = await leadsWorld(h, { agents: 1, rule: false, push: false });
    const a = w.agents[0]!;
    await teamListing(a, { status: 'active' });
    await teamListing(a, { status: 'coming_soon' });
    await freshReauth(h, w.owner);
    const v = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, a.userId])).rows[0]!.version;
    const r = await call<{ error: { details: unknown } }>(w.owner, 'PATCH', `/members/${a.userId}`, { status: 'removed', version: v });
    expect([r.status, r.code]).toEqual([409, 'MEMBER_HAS_LISTINGS']);
    expect(JSON.stringify(r.body)).toContain('"openListings":2');
    expect(await statusOf(w.tenantId, a.userId)).toBe('active');
  });

  it('R-PERM-15 E543: making the listing agent of an open listing a TC is 409 MEMBER_HAS_LISTINGS', async () => {
    const w = await leadsWorld(h, { agents: 1, rule: false, push: false });
    const a = w.agents[0]!;
    await teamListing(a, { status: 'pending' });
    await freshReauth(h, w.owner);
    const v = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, a.userId])).rows[0]!.version;
    const r = await call(w.owner, 'PATCH', `/members/${a.userId}`, { role: 'tc', version: v });
    expect([r.status, r.code]).toEqual([409, 'MEMBER_HAS_LISTINGS']);
    expect((await h.su.query('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, a.userId])).rows[0].role).toBe('agent');
  });

  it('R-OWN-22 E544: a listing the member created after stage 1 is moved before removal', async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true, push: false });
    const a = w.agents[0]!;
    await freshReauth(h, w.owner);
    const run = await call(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status).toBe(202);
    // an insert by the member that was already in flight when stage 1 committed (their sessions are revoked now)
    const late = randomUUID();
    await withTenantTx(a.actor(), (tx) =>
      sql`INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id)
          VALUES (app.tenant_id(), ${late}::uuid, 'team', 'active', '12 Example Ct', 'Charleston', 'SC', '29401', ${a.userId}::uuid)`.execute(tx), { db: h.database });
    await leadsWorker(h).drain();
    expect(await agentOf(late)).toBe(w.teamLead!.userId);
    expect(await statusOf(w.tenantId, a.userId)).toBe('removed');
  });

  it("R-OWN-22 E545: an Owner's PATCH /listings/:id/agent committed during the job wins; the job's write is a fenced no-op, no second audit", async () => {
    const w = await leadsWorld(h, { agents: 2, teamLead: true, push: false });
    const [a, b] = w.agents as [TestClient, TestClient];
    const l = await teamListing(a, { status: 'active' });
    await freshReauth(h, w.owner);
    const run = await call(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status).toBe(202);
    const job = (await jobs(h, w.tenantId, 'leads.deactivate'))[0]!;
    const handler = deactivationHandler();
    const actor = systemActor(w.tenantId, 'worker');
    let calls = 0;
    const ctx = {
      actor,
      now: Date.now() as never,
      providers: h.providers,
      job: { id: 1n, kind: handler.kind, queue: handler.queue, attempts: 1 },
      log: silentLogger,
      alerts: memoryAlerts(),
      withTx: async <T>(fn: (tx: never, now: never) => Promise<T>) => {
        calls += 1;
        if (calls === 2) {
          // the job listed the listing; the Owner hands it to another agent before the job's move runs
          const p = await call(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: b.userId });
          expect(p.status).toBe(200);
        }
        return withTenantTx(actor, fn as never, { db: h.database }) as Promise<T>;
      },
    };
    await handler.run(ctx as never, job.payload as DeactivatePayload);
    expect(await agentOf(l)).toBe(b.userId);
    const au = await agentAudits(l);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ actor_kind: 'user', actor_user_id: w.owner.userId });
    expect(await statusOf(w.tenantId, a.userId)).toBe('removed');
  });

  it("R-OWN-22 R-SELL-1 E540: the moved listing's seller-update card closes on the next reconcile and the period is drafted for the new agent", async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true, push: false });
    const a = w.agents[0]!;
    const sl = await sellerListing(a);
    await reconcile(h, w.tenantId);
    const [first] = await draftsOf(h, sl.listingId);
    expect(first).toMatchObject({ status: 'proposed', owner_user_id: a.userId });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' })).status).toBe(202);
    await leadsWorker(h).drain();
    expect(await agentOf(sl.listingId)).toBe(w.teamLead!.userId);

    await reconcile(h, w.tenantId);
    const drafts = await draftsOf(h, sl.listingId);
    expect(drafts.find((d) => d.id === first!.id)!.status).toBe('invalidated');
    expect(drafts.filter((d) => d.status === 'proposed').map((d) => d.owner_user_id)).toEqual([w.teamLead!.userId]);
    const open = (await h.su.query<{ user_id: string }>("SELECT user_id FROM priority_feed_items WHERE item_type = 'seller_update' AND subject_id = $1 AND state = 'open'", [sl.listingId])).rows;
    expect(open.map((c) => c.user_id)).toEqual([w.teamLead!.userId]);
  });
});
