// Pond leads reach exactly the members allowed to claim them (journey bug: agents and Team Leads never saw a
// pond lead in the web app; the feed was built with `pondLeads: []`). Over real Postgres as app_user:
//   - the "New in the pond" card (masked name, one-tap Claim) on every eligible member's feed, never the releaser's
//     (claim cooldown), a TC's, the Owner's or an Admin's; a members-only pond reaches only its members;
//   - a claim (or any exit from the pond) marks every eligible member's incremental feed, so the card goes at once
//     for everyone else, also for a Team Lead who keeps seeing the lead through their team;
//   - the member's own totals (claims today against the pond's limit, uncontacted leads against the cap) hide the
//     cards of the ponds they block, read when the feed is read; GET /me/ponds says which and why;
//   - app.my_pond_leads (migration pond_leads_feed) answers only the caller, about the ponds they may claim from.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { acceptedLead, call, command, contactState, feedOf, freshReauth, type FeedCardT, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let tc: TestClient;
let admin: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 3, teamLead: true, others: ['tc', 'admin'] });
  [tc, admin] = w.others as [TestClient, TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface MyPonds {
  ponds: { id: string; name: string; isDefault: boolean; claimsPerDay: number; blockedBy: string | null }[];
  claimsToday: number;
  uncontactedOwned: number;
  capacityCap: number;
}

let n = 0;
/** A lead accepted by whoever it was offered to, then released by them (to the default pond unless `toPondId`). */
async function releasedLead(o: { toPondId?: string } = {}): Promise<{ id: string; by: TestClient; first: string }> {
  n += 1;
  const first = `Sol${n}`;
  const { contactId, owner } = await acceptedLead(h, w, { fullName: `${first} Pondsworth` });
  const r = await command(owner, contactId, 'release', { reason: 'not_a_fit', ...(o.toPondId ? { toPondId: o.toPondId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await contactState(h, contactId)).ownership_state).toBe('in_pond');
  return { id: contactId, by: owner, first };
}

const pondCard = (f: { all: FeedCardT[] }, id: string) => f.all.find((c) => c.itemType === 'pond_new' && c.contact?.id === id);
const othersThan = (c: TestClient) => w.agents.filter((a) => a.userId !== c.userId);
const actorOf = (c: TestClient): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'pond-feed-test' }) as unknown as UserActor;

async function cardsOf(c: TestClient, pondId: string): Promise<string[]> {
  const r = await call<{ cards: { id: string }[] }>(c, 'GET', `/ponds/${pondId}/cards`);
  expect(r.status).toBe(200);
  return r.body.cards.map((x) => x.id);
}

async function settingsVersion(): Promise<number> {
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  expect(s.status).toBe(200);
  return s.body.settings.version;
}

describe('pond leads in the Priority Feed and on the Pond page (R-OWN-16)', () => {
  it('R-OWN-16 R-PERM-6: a released lead reaches every member who may claim it as a masked "New in the pond" card with one-tap Claim; never the releaser (claim cooldown), a TC, the Owner or an Admin', async () => {
    const lead = await releasedLead();
    for (const m of [...othersThan(lead.by), w.teamLead!]) {
      const f = await feedOf(m);
      const card = pondCard(f, lead.id);
      expect(card, `${m.role} ${m.userId}`).toBeDefined();
      expect(card!.contact!.name).toBe(`${lead.first} P.`);
      expect(card!.primaryAction).toMatchObject({ kind: 'claim', label: 'Claim', contactId: lead.id, pondId: w.defaultPondId });
      expect(card!.reasons[0]).toMatchObject({ code: 'POND_NEW' });
      expect(card!.reasons[0]!.label).toMatch(/^New in the pond .+; first to claim gets it$/);
      expect(JSON.stringify(card)).not.toContain('Pondsworth');
    }
    for (const m of [lead.by, tc, admin, w.owner]) expect(pondCard(await feedOf(m), lead.id), m.role ?? '').toBeUndefined();
    // the Pond page's reads: the ponds each member may claim from; the releaser's list leaves out the lead they cannot claim
    const mine = await call<MyPonds>(othersThan(lead.by)[0]!, 'GET', '/me/ponds');
    expect(mine.status).toBe(200);
    expect(mine.body.ponds).toEqual([expect.objectContaining({ id: w.defaultPondId, isDefault: true, blockedBy: null })]);
    for (const m of [tc, w.owner, admin]) expect((await call<MyPonds>(m, 'GET', '/me/ponds')).body.ponds).toEqual([]);
    expect(await cardsOf(othersThan(lead.by)[0]!, w.defaultPondId)).toContain(lead.id);
    expect(await cardsOf(w.teamLead!, w.defaultPondId)).toContain(lead.id);
    expect(await cardsOf(lead.by, w.defaultPondId)).not.toContain(lead.id);
    // Owner/Admin see the pond's every lead (they assign, they never claim)
    expect(await cardsOf(w.owner, w.defaultPondId)).toContain(lead.id);
  });

  it('R-OWN-5 R-OWN-16: the first claim wins and every other eligible member is marked, so their card goes at once (closed, not merely hidden, for a Team Lead who still sees the lead)', async () => {
    const lead = await releasedLead();
    const [winner, other] = othersThan(lead.by) as [TestClient, TestClient];
    for (const m of [winner, other, w.teamLead!]) expect(pondCard(await feedOf(m), lead.id)).toBeDefined();
    const won = await command(winner, lead.id, 'claim', { pondId: w.defaultPondId });
    expect(won.status, JSON.stringify(won.body)).toBe(200);
    // the claim marked every member who may claim from the pond (their materialized feeds are stale until re-scored)
    const marked = (await h.su.query<{ user_id: string }>('SELECT DISTINCT user_id FROM feed_dirty WHERE group_key = $1', [`c:${lead.id}`])).rows.map((r) => r.user_id);
    expect(marked).toEqual(expect.arrayContaining([other.userId, w.teamLead!.userId, lead.by.userId]));
    const lost = await command(other, lead.id, 'claim', { pondId: w.defaultPondId });
    expect([lost.status, lost.code]).toEqual([409, 'LEAD_ALREADY_CLAIMED']);
    const fo = await feedOf(other);
    expect(pondCard(fo, lead.id)).toBeUndefined();
    // nothing stale is counted either
    expect(fo.total).toBe(fo.all.length);
    // the Team Lead still sees the lead (their team member owns it): the pond card was closed by its condition
    const tl = await feedOf(w.teamLead!);
    expect(pondCard(tl, lead.id)).toBeUndefined();
    expect(tl.total).toBe(tl.all.length);
    const rows = await h.su.query<{ state: string; resolved_by: string | null }>("SELECT state, resolved_by FROM priority_feed_items WHERE user_id = $1 AND contact_id = $2 AND item_type = 'pond_new'", [w.teamLead!.userId, lead.id]);
    expect(rows.rows).toEqual([{ state: 'done', resolved_by: 'condition' }]);
    // the winner owns it and works it from a first-contact card, not a pond card
    const fw = await feedOf(winner);
    expect(pondCard(fw, lead.id)).toBeUndefined();
    expect(fw.all.some((c) => c.itemType === 'first_touch_due' && c.contact?.id === lead.id)).toBe(true);
  });

  it('F4-ERASE-POND-PHANTOM-COUNT R-DATA-4 R-OWN-16: erasing a pond lead takes its card out of every eligible member\'s feed and feed total at once (before: the card went, but each total kept counting it until the hourly reconcile)', async () => {
    const lead = await releasedLead();
    const members = [...othersThan(lead.by), w.teamLead!];
    for (const m of members) {
      const f = await feedOf(m);
      expect(pondCard(f, lead.id), `${m.role} ${m.userId}`).toBeDefined();
      expect(f.total, `${m.role} ${m.userId}`).toBe(f.all.length);
    }
    await freshReauth(h, w.owner);
    const er = await call(w.owner, 'POST', `/contacts/${lead.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(er.status, JSON.stringify(er.body)).toBe(200);
    // the delete marked each member whose stored count held the lead's group (the materializer re-scores it on read)
    const marked = (await h.su.query<{ user_id: string }>('SELECT DISTINCT user_id FROM feed_dirty WHERE group_key = $1', [`c:${lead.id}`])).rows.map((r) => r.user_id);
    expect(marked).toEqual(expect.arrayContaining(members.map((m) => m.userId!)));
    for (const m of members) {
      const f = await feedOf(m);
      expect(pondCard(f, lead.id), `${m.role} ${m.userId}`).toBeUndefined();
      expect(f.total, `${m.role} ${m.userId}`).toBe(f.all.length);
    }
    expect((await h.su.query('SELECT user_id FROM feed_groups WHERE group_key = $1', [`c:${lead.id}`])).rows).toEqual([]);
  });

  it('R-OWN-16: a members-only pond reaches only its members; adding a member marks them and the card reaches them', async () => {
    const ag = w.agents;
    const p = await call<{ pond: { id: string } }>(w.owner, 'POST', '/ponds', { name: `Buyers only ${randomUUID().slice(0, 6)}`, openToAll: false });
    expect(p.status).toBe(201);
    const pondId = p.body.pond.id;
    expect((await call(w.owner, 'PUT', `/ponds/${pondId}/members`, { userIds: ag.map((a) => a.userId) })).status).toBe(200);
    const lead = await releasedLead({ toPondId: pondId });
    const [inside, outside] = othersThan(lead.by) as [TestClient, TestClient];
    // only the members (and not the releaser) are in it now; then one of them is taken out
    expect((await call(w.owner, 'PUT', `/ponds/${pondId}/members`, { userIds: [lead.by.userId, inside.userId] })).status).toBe(200);
    expect(pondCard(await feedOf(inside), lead.id)).toBeDefined();
    const fo = await feedOf(outside);
    expect(pondCard(fo, lead.id)).toBeUndefined();
    expect(fo.total).toBe(fo.all.length);
    // the Team Lead is not a member of this pond: no card (they still see it in their team's ponds, R-PERM-4)
    expect(pondCard(await feedOf(w.teamLead!), lead.id)).toBeUndefined();
    expect((await call<MyPonds>(outside, 'GET', '/me/ponds')).body.ponds.map((x) => x.id)).not.toContain(pondId);
    expect((await call(outside, 'GET', `/ponds/${pondId}/cards`)).status).toBe(404);
    // added again: marked for a whole-book recompute, and the card reaches them
    expect((await call(w.owner, 'PUT', `/ponds/${pondId}/members`, { userIds: [lead.by.userId, inside.userId, outside.userId] })).status).toBe(200);
    const full = await h.su.query<{ n: string }>("SELECT count(*) AS n FROM feed_dirty WHERE user_id = $1 AND group_key = '!full'", [outside.userId]);
    expect(Number(full.rows[0]!.n)).toBeGreaterThan(0);
    expect(pondCard(await feedOf(outside), lead.id)).toBeDefined();
    expect((await call<MyPonds>(outside, 'GET', '/me/ponds')).body.ponds.map((x) => x.id)).toContain(pondId);
    // a pond that allows no claims reaches nobody
    expect((await call(w.owner, 'PATCH', `/ponds/${pondId}`, { claimsPerDay: 0 })).status).toBe(200);
    expect(pondCard(await feedOf(outside), lead.id)).toBeUndefined();
    expect((await call<MyPonds>(outside, 'GET', '/me/ponds')).body.ponds.map((x) => x.id)).not.toContain(pondId);
  });

  it("R-OWN-16: a member's own totals hide the cards of the ponds they block (the day's claim limit, then the uncontacted-lead cap), and the card comes back when they are under them; GET /me/ponds says why", async () => {
    const one = await releasedLead();
    const two = await releasedLead();
    const claimer = othersThan(one.by).find((a) => a.userId !== two.by.userId) ?? othersThan(one.by)[0]!;
    const bystander = w.agents.find((a) => a.userId !== claimer.userId && a.userId !== two.by.userId)!;
    expect((await call(w.owner, 'PATCH', `/ponds/${w.defaultPondId}`, { claimsPerDay: 1 })).status).toBe(200);
    try {
      const before = await call<MyPonds>(claimer, 'GET', '/me/ponds');
      const today = before.body.claimsToday;
      // claim limit: once the member has claimed today's allowance, the pond's other leads stop reaching them
      expect((await call(w.owner, 'PATCH', `/ponds/${w.defaultPondId}`, { claimsPerDay: today + 1 })).status).toBe(200);
      expect(pondCard(await feedOf(claimer), two.id)).toBeDefined();
      expect((await command(claimer, one.id, 'claim', { pondId: w.defaultPondId })).status).toBe(200);
      const f = await feedOf(claimer);
      expect(pondCard(f, two.id)).toBeUndefined();
      expect(f.total).toBe(f.all.length);
      const blocked = await call<MyPonds>(claimer, 'GET', '/me/ponds');
      expect(blocked.body).toMatchObject({ claimsToday: today + 1, ponds: [expect.objectContaining({ id: w.defaultPondId, claimsPerDay: today + 1, blockedBy: 'CLAIM_LIMIT_REACHED' })] });
      // a claim the card would have offered is refused for exactly that reason
      expect((await command(claimer, two.id, 'claim', { pondId: w.defaultPondId })).code).toBe('CLAIM_LIMIT_REACHED');
      // someone who has not claimed still gets it
      if (bystander.userId !== one.by.userId) expect(pondCard(await feedOf(bystander), two.id)).toBeDefined();
      // a higher limit lets it reach them again (read when the feed is read: no mark needed)
      expect((await call(w.owner, 'PATCH', `/ponds/${w.defaultPondId}`, { claimsPerDay: today + 5 })).status).toBe(200);
      expect(pondCard(await feedOf(claimer), two.id)).toBeDefined();
      // capacity: the claimed lead is still uncontacted; with a cap at that count nothing more reaches them
      const totals = (await call<MyPonds>(claimer, 'GET', '/me/ponds')).body;
      expect(totals.uncontactedOwned).toBeGreaterThanOrEqual(1);
      await freshReauth(h, w.owner);
      const cap = await call(w.owner, 'PATCH', '/settings', { version: await settingsVersion(), uncontactedCapacityCap: totals.uncontactedOwned });
      expect(cap.status, JSON.stringify(cap.body)).toBe(200);
      const fc = await feedOf(claimer);
      expect(pondCard(fc, two.id)).toBeUndefined();
      expect(fc.total).toBe(fc.all.length);
      expect((await call<MyPonds>(claimer, 'GET', '/me/ponds')).body.ponds[0]).toMatchObject({ blockedBy: 'CAPACITY_REACHED' });
      expect((await command(claimer, two.id, 'claim', { pondId: w.defaultPondId })).code).toBe('CAPACITY_REACHED');
      const back = await call(w.owner, 'PATCH', '/settings', { version: await settingsVersion(), uncontactedCapacityCap: 5 });
      expect(back.status).toBe(200);
      expect(pondCard(await feedOf(claimer), two.id)).toBeDefined();
    } finally {
      await call(w.owner, 'PATCH', `/ponds/${w.defaultPondId}`, { claimsPerDay: 5 });
    }
  });

  it('R-PERM-6 R-TEN-5: app.my_pond_leads answers only the caller, about the ponds they may claim from: the releaser learns only their own cooldown; a TC, the Owner, the system and another tenant get nothing', async () => {
    const lead = await releasedLead();
    const ask = (c: TestClient) =>
      withTenantTx(actorOf(c), async (tx) => (await sql<{ contact_id: string; pond_id: string; entered_by_import: boolean; cooldown_until: Date | null }>`
        SELECT contact_id, pond_id, entered_by_import, cooldown_until FROM app.my_pond_leads(NULL, ${[lead.id]}::uuid[])`.execute(tx)).rows, { db: h.database });
    const eligible = othersThan(lead.by)[0]!;
    expect(await ask(eligible)).toEqual([{ contact_id: lead.id, pond_id: w.defaultPondId, entered_by_import: false, cooldown_until: null }]);
    const mine = await ask(lead.by);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.cooldown_until!.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    for (const c of [tc, w.owner, admin]) expect(await ask(c), c.role ?? '').toEqual([]);
    const sys = await withTenantTx(
      systemActor(w.tenantId, 'worker'),
      async (tx) => (await sql`SELECT * FROM app.my_pond_leads(NULL, ${[lead.id]}::uuid[])`.execute(tx)).rows,
      { db: h.database },
    );
    expect(sys).toEqual([]);
    const elsewhere = await workspaceWorld(h, { agents: 1 });
    expect(await ask(elsewhere.agents[0]!)).toEqual([]);
    // the window form returns the same lead, and never runs without a bound
    const recent = await withTenantTx(actorOf(eligible), async (tx) => (await sql<{ contact_id: string }>`
      SELECT contact_id FROM app.my_pond_leads(now() - interval '1 hour', NULL)`.execute(tx)).rows, { db: h.database });
    expect(recent.map((r) => r.contact_id)).toContain(lead.id);
    const unbounded = await withTenantTx(actorOf(eligible), async (tx) => (await sql`SELECT * FROM app.my_pond_leads(NULL, NULL)`.execute(tx)).rows, { db: h.database });
    expect(unbounded).toEqual([]);
  });
});
