// b7 ownership-data/F2 (R-PERM-1, R-OWN-22, R-MKT-4): a listing keeps its agent when the member is removed, so an
// Owner/Admin changes it (PATCH /listings/:id/agent, listing.reassign, audited), and the marketing review card of a
// listing with no active agent goes to the Owners/Admins instead of the removed agent.
// Real Postgres as app_user through the real server; deactivation is the staged API flow plus its job (R-OWN-22).
import { randomUUID } from 'node:crypto';
import { ROLES, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { assistantWorld } from '../assistant/testing.js';
import { call, freshReauth, leadsWorker } from '../leads/testing.js';
import { generateAll, marketingWorld, teamListing } from '../marketing/testing.js';
import { mlsConnection } from '../mls/testing.js';
import { reconcile } from '../sellerUpdates/testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** The staged deactivation through the API, then its job, until the membership is 'removed' (R-OWN-22). */
async function removeMember(owner: TestClient, tenantId: string, member: TestClient): Promise<void> {
  await freshReauth(h, owner);
  const run = await call(owner, 'POST', `/members/${member.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
  if (run.status !== 202) throw new Error(`deactivate: ${run.status} ${JSON.stringify(run.body)}`);
  await leadsWorker(h).drain();
  const st = (await h.su.query('SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, member.userId])).rows[0]?.status;
  if (st !== 'removed') throw new Error(`membership still ${st}`);
}

const agentOf = async (listingId: string): Promise<string | null> => (await h.su.query('SELECT listing_agent_user_id AS u FROM listings WHERE id = $1', [listingId])).rows[0].u;
const audits = async (listingId: string) =>
  (await h.su.query("SELECT actor_kind, actor_user_id, actor_role, entity_type, changes FROM audit_log WHERE action = 'listing.agent_changed' AND entity_id = $1 ORDER BY seq", [listingId])).rows;

describe('R-PERM-1 b7 ownership-data/F2: changing a listing agent', () => {
  it("R-PERM-1 b7 ownership-data/F2: PATCH /listings/:id/agent role x route matches can('listing.reassign')", async () => {
    const w = await assistantWorld(h, { agents: 3, teamLead: true, others: ['admin', 'isa', 'tc'], push: false });
    const [a0, a1, gone] = w.agents as [TestClient, TestClient, TestClient];
    const [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
    const by: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: w.teamLead!, agent: a0, isa, tc };
    await removeMember(w.owner, w.tenantId, gone);

    const got: Record<string, number> = {};
    const want: Record<string, number> = {};
    const listingOfRole: Partial<Record<Role, string>> = {};
    for (const role of ROLES) {
      const c = by[role];
      const listingId = await teamListing(a0, {});
      listingOfRole[role] = listingId;
      const actor = { kind: 'user' as const, userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 's' };
      // denials are 404 (R-PERM-5), as every authorize() refusal
      want[role] = can(actor as never, 'listing.reassign', { own: c.userId === a0.userId }).ok ? 200 : 404;
      const r = await call<{ listing: { listingAgentUserId: string } }>(c, 'PATCH', `/listings/${listingId}/agent`, { listingAgentUserId: a1.userId });
      got[role] = r.status;
      if (r.status === 200) expect(r.body.listing.listingAgentUserId).toBe(a1.userId);
    }
    expect(got).toEqual(want);
    expect(want).toEqual({ owner: 200, admin: 200, team_lead: 404, agent: 404, isa: 404, tc: 404 });

    // each change is audited once, by the member who made it; a refused one changes nothing and audits nothing
    for (const role of ROLES) {
      const id = listingOfRole[role]!;
      if (want[role] === 200) {
        expect(await agentOf(id)).toBe(a1.userId);
        const rows = await audits(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_kind: 'user', actor_user_id: by[role].userId, actor_role: role, entity_type: 'listing' });
      } else {
        expect(await agentOf(id)).toBe(a0.userId);
        expect(await audits(id)).toHaveLength(0);
      }
    }

    // ineligible targets: a removed member, a TC (may not own leads), an id that is no member; for Owner and Admin
    const target = await teamListing(a0, {});
    const nobody = '01a1ce00-0000-7000-8000-000000000000';
    for (const c of [w.owner, admin]) {
      for (const t of [gone.userId, tc.userId, nobody]) {
        const r = await call(c, 'PATCH', `/listings/${target}/agent`, { listingAgentUserId: t });
        expect([r.status, r.code]).toEqual([422, 'ASSIGNEE_NOT_ELIGIBLE']);
      }
    }
    expect(await agentOf(target)).toBe(a0.userId);
    expect(await audits(target)).toHaveLength(0);
    // the same agent again is a no-op: 200, nothing audited
    expect((await call(w.owner, 'PATCH', `/listings/${target}/agent`, { listingAgentUserId: a0.userId })).status).toBe(200);
    expect(await audits(target)).toHaveLength(0);
    // a Team Lead may not do it even for a member of their own team (core: Owner/Admin only)
    expect((await call(w.teamLead!, 'PATCH', `/listings/${target}/agent`, { listingAgentUserId: a1.userId })).status).toBe(404);
    // an unknown listing is 404 for the Owner too
    expect((await call(w.owner, 'PATCH', `/listings/${nobody}/agent`, { listingAgentUserId: a1.userId })).status).toBe(404);
  });
  it('R-PERM-1: the MLS listing agent change is 404 and audits nothing', async () => {
    const w = await assistantWorld(h, { agents: 1, push: false });
    const a1 = w.agents[0]!;
    // R-PERM-1: an MLS listing has no listing agent of ours: 404 for the Owner, nothing changed, nothing audited
    // (an MLS row has no application write path: the superuser writes it as the feed would)
    const mls = '01a1ce00-0000-7000-8000-0000000000aa';
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query(
      `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, mls_connection_id, mls_modified_at, listing_brokerage_name)
       VALUES ($1, $2, 'mls', 'MLS-TEST-1', 'active', '1 Example Way', 'Charleston', 'SC', '29401', $3, now(), 'Example Brokerage')`,
      [w.tenantId, mls, conn],
    );
    const onMls = await call(w.owner, 'PATCH', `/listings/${mls}/agent`, { listingAgentUserId: a1.userId });
    expect(onMls.status).toBe(404);
    expect(await agentOf(mls)).toBeNull();
    expect(await audits(mls)).toHaveLength(0);
  });
});

// b11 review api-ui/F8: the route skipped the writer when the listing had no agent and still answered 200. A team listing
// cannot be without one (listings_check), so there is no first agent to set; the route now refuses rather than answer 200.
describe('b11 review api-ui/F8: PATCH /listings/:id/agent never answers 200 for a write that did not happen', () => {
  const NO_AGENT = { code: '23514', constraint: 'listings_check' };

  it('R-SELL-1 b11 review api-ui/F8: a team listing always has an agent: listings_check refuses one without on insert and update, even for the superuser, and the route cannot clear it', async () => {
    const w = await assistantWorld(h, { agents: 1, push: false });
    const a = w.agents[0]!;
    const l = await teamListing(a, {});
    // the superuser bypasses RLS, not CHECK constraints
    await expect(h.su.query('UPDATE listings SET listing_agent_user_id = NULL WHERE id = $1', [l])).rejects.toMatchObject(NO_AGENT);
    await expect(
      h.su.query(
        `INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code)
         VALUES ($1, $2, 'team', 'active', '2 Example Way', 'Charleston', 'SC', '29401')`,
        [w.tenantId, randomUUID()],
      ),
    ).rejects.toMatchObject(NO_AGENT);
    // the agent FK is NO ACTION (a membership is never deleted from under its listings), not SET NULL
    const fk = await h.su.query<{ del: string }>(
      `SELECT confdeltype AS del FROM pg_constraint WHERE conrelid = 'listings'::regclass AND contype = 'f' AND conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'listings'::regclass AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'listings'::regclass AND attname = 'listing_agent_user_id')]::int2[]`,
    );
    expect(fk.rows.map((x) => x.del)).toEqual(['a']);
    const clear = await call(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: null });
    expect([clear.status, clear.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(await agentOf(l)).toBe(a.userId);
    expect(await audits(l)).toHaveLength(0);
  });

  it('R-OWN-22 b11 review api-ui/F8: were listings_check ever relaxed, an agentless team listing is refused 500 INTERNAL_ERROR, never 200; nothing written, nothing audited', async () => {
    const w = await assistantWorld(h, { agents: 2, push: false });
    const [a0, a1] = w.agents as [TestClient, TestClient];
    const l = await teamListing(a0, {});
    // this file's own database only (createTestDb): break the invariant the route relies on, then put it back
    await h.su.query('ALTER TABLE listings DROP CONSTRAINT listings_check');
    try {
      await h.su.query('UPDATE listings SET listing_agent_user_id = NULL WHERE id = $1', [l]);
      const r = await call(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: a1.userId });
      expect([r.status, r.code]).toEqual([500, 'INTERNAL_ERROR']);
      expect(await agentOf(l)).toBeNull();
      expect(await audits(l)).toHaveLength(0);
    } finally {
      await h.su.query('UPDATE listings SET listing_agent_user_id = $2 WHERE id = $1', [l, a0.userId]);
      await h.su.query(`ALTER TABLE listings ADD CONSTRAINT listings_check CHECK (source = 'mls' OR listing_agent_user_id IS NOT NULL)`);
    }
    // with the invariant back, the same change is written and audited once
    const ok = await call<{ listing: { listingAgentUserId: string } }>(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: a1.userId });
    expect(ok.status).toBe(200);
    expect(ok.body.listing.listingAgentUserId).toBe(a1.userId);
    expect(await agentOf(l)).toBe(a1.userId);
    expect(await audits(l)).toHaveLength(1);
  });

  // b11 merge review F1: the converse does not hold. The change and its audit commit in the caller's transaction; the
  // new agent's review cards are written after it, as the system, in a transaction of their own. A failure there still
  // answers 500, with the change saved, so a 500 does not say "nothing was saved" (the web says it could not confirm the
  // change and shows the refetched agent: apps/web ListingAgent.test.tsx).
  it('R-OWN-22 b11 merge review F1: a 500 can come after the change committed (the review-card sync after it failed): the listing has the new agent and one audit, so a 500 is not "nothing was saved"', async () => {
    const w = await assistantWorld(h, { agents: 2, push: false });
    const [a0, a1] = w.agents as [TestClient, TestClient];
    const l = await teamListing(a0, {});
    // this file's own database only (createTestDb): make the system's card sync, which runs after the commit, fail
    await h.su.query('REVOKE SELECT ON marketing_pieces FROM app_user');
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: a1.userId });
    } finally {
      await h.su.query('GRANT SELECT ON marketing_pieces TO app_user');
    }
    expect([r.status, r.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(await agentOf(l)).toBe(a1.userId);
    expect(await audits(l)).toHaveLength(1);
    // the same change again is the 200 no-op (nothing more audited); the card sync runs again with it
    expect((await call(w.owner, 'PATCH', `/listings/${l}/agent`, { listingAgentUserId: a1.userId })).status).toBe(200);
    expect(await audits(l)).toHaveLength(1);
  });
});

describe('R-MKT-4 b7 ownership-data/F2: marketing review on a listing whose agent was removed', () => {
  it('R-MKT-4 b7 ownership-data/F2: a marketing draft on a listing with a removed agent raises the Owner/Admin card, not an agent review card', async () => {
    const w = await marketingWorld(h);
    const admin = await h.invite(w.owner, 'admin');
    const next = w.agents[1]!;
    const address = (await h.su.query<{ a: string }>('SELECT address_line1 AS a FROM listings WHERE id = $1', [w.listingId])).rows[0]!.a;
    // suspended, not removed: the staged deactivation now moves an open listing (R-OWN-22 E540), a suspension keeps it
    await freshReauth(h, w.owner);
    const v = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, w.agent.userId])).rows[0]!.version;
    expect((await call(w.owner, 'PATCH', `/members/${w.agent.userId}`, { status: 'suspended', version: v })).status).toBe(200);
    expect(await agentOf(w.listingId)).toBe(w.agent.userId);

    // the Owner drafts marketing for the listing (listing.edit: ALL)
    const pieces = Object.values(await generateAll(w.owner, w.listingId));
    expect(pieces.length).toBeGreaterThan(0);
    const ids = pieces.map((p) => p.id);
    const reviewCards = async () =>
      (await h.su.query("SELECT user_id, state, reasons FROM priority_feed_items WHERE item_type = 'marketing_review' AND subject_id = ANY($1::uuid[]) ORDER BY user_id", [ids])).rows;
    // nobody got a review card for the drafts (the removed agent cannot review them)
    expect(await reviewCards()).toEqual([]);

    // every active Owner/Admin got exactly one "no active listing agent" card naming the listing
    const key = `seller_update:${w.listingId}:agent-inactive`;
    const inactive = async () => (await h.su.query("SELECT id, user_id, state, resolved_by, reasons FROM priority_feed_items WHERE dedupe_key = $1 AND tenant_id = $2 ORDER BY user_id", [key, w.tenantId])).rows;
    const open = (await inactive()).filter((c) => c.state === 'open');
    expect(open.map((c) => c.user_id).sort()).toEqual([w.owner.userId, admin.userId].sort());
    for (const c of open) {
      expect(c.reasons.map((x: { code: string }) => x.code)).toEqual(['LISTING_AGENT_INACTIVE']);
      expect(c.reasons[0].label).toContain(address);
    }
    // generating again does not add cards
    await generateAll(w.owner, w.listingId);
    expect((await inactive()).map((c) => c.id).sort()).toEqual(open.map((c) => c.id).sort());

    // the Owner hands the listing to an active agent: their review cards are written right away
    const p = await call(w.owner, 'PATCH', `/listings/${w.listingId}/agent`, { listingAgentUserId: next.userId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const drafts = (await h.su.query<{ id: string }>("SELECT id FROM marketing_pieces WHERE listing_id = $1 AND status = 'draft'", [w.listingId])).rows.map((x) => x.id);
    const after = (await h.su.query("SELECT user_id, subject_id, state FROM priority_feed_items WHERE item_type = 'marketing_review' AND subject_id = ANY($1::uuid[]) AND state = 'open'", [drafts])).rows;
    expect(after.length).toBe(drafts.length);
    expect(after.every((c) => c.user_id === next.userId)).toBe(true);
    // and the Owner/Admin cards close on the next seller-update reconcile (the listing has an active agent again)
    await reconcile(h, w.tenantId);
    const closed = await inactive();
    expect(closed).toHaveLength(2);
    for (const c of closed) expect([c.state, c.resolved_by]).toEqual(['done', 'condition']);
  });
});
