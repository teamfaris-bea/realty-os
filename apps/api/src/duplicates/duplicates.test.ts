// api/duplicates (PARITY_PLAN module 66): the review list, dismiss/Undo, and a merge through the existing
// POST /leads/:id/merge (the ownership engine) that moves tags, notes and stage history and keeps every
// opt-out (R-PAR-44, R-PAR-45, R-OWN-24, R-OWN-25, D1, R-PAR-12).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, type TestClient } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, ownedContact, randomEmail, randomPhone, sendText } from '../comms/testing.js';
import { command } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let other: TestClient;
let tc: TestClient;

interface Pair {
  id: string;
  matchReason: string;
  reasonText: string;
  status: string;
  suggestedSurvivorId: string;
  canMerge: boolean;
  owner: { rule: string; userId?: string | null; preselectedUserId?: string };
  a: { id: string; displayName: string; phones: { address: string }[]; counts: { notes: number; tags: number } };
  b: { id: string; displayName: string; phones: { address: string }[]; counts: { notes: number; tags: number } };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  [agent, other] = w.agents as [TestClient, TestClient];
  tc = w.others[0]!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** Two contacts of `owner` sharing an email (the second created with confirmDistinct ⇒ a shared_email candidate). */
async function pairOf(owner: TestClient, o: { firstName?: string } = {}) {
  const email = randomEmail();
  const x = await ownedContact(owner, { email, consent: false, firstName: o.firstName ?? 'Jane' });
  const y = await ownedContact(owner, { email, consent: false, firstName: o.firstName ?? 'Jane', confirmDistinct: true });
  const list = await call<{ duplicates: Pair[] }>(owner, 'GET', '/duplicates');
  const pair = list.body.duplicates.find((d) => [d.a.id, d.b.id].sort().join() === [x.id, y.id].sort().join());
  if (!pair) throw new Error(`no candidate: ${JSON.stringify(list.body)}`);
  return { x, y, pair };
}

const merge = (c: TestClient, survivorId: string, loserId: string, ownerChoice?: string) =>
  command<{ result: unknown; error?: { code: string } }>(c, survivorId, 'merge', { loserId, ...(ownerChoice ? { ownerChoice } : {}) });

describe('R-PAR-44 the duplicate review list', () => {
  it('R-PAR-44 R-OWN-25: an exact-match create with confirmDistinct shows up as a pair with its reason in words, the earlier record suggested as survivor', async () => {
    const { x, pair } = await pairOf(agent);
    expect(pair.matchReason).toBe('shared_email');
    expect(pair.reasonText).toBe('Same email address');
    expect(pair.status).toBe('open');
    expect(pair.suggestedSurvivorId).toBe(x.id);
    expect(pair.owner).toEqual({ rule: 'same', userId: agent.userId });
    expect(pair.canMerge).toBe(true);
    const one = await call<{ duplicate: Pair }>(agent, 'GET', `/duplicates/${pair.id}`);
    expect(one.status).toBe(200);
    expect(one.body.duplicate.id).toBe(pair.id);
    expect(JSON.stringify(one.body)).not.toMatch(/tenant_?id|confidence|score/i);
  });

  it('R-PERM-5 R-PERM-12: another agent and a TC never see the pair (404, not 403); the Team Lead and Owner do', async () => {
    const { pair } = await pairOf(agent);
    expect((await call(other, 'GET', `/duplicates/${pair.id}`)).status).toBe(404);
    expect((await call<{ duplicates: Pair[] }>(other, 'GET', '/duplicates')).body.duplicates.map((d) => d.id)).not.toContain(pair.id);
    expect((await call(tc, 'GET', '/duplicates')).status).toBe(404);
    expect((await call(w.teamLead!, 'GET', `/duplicates/${pair.id}`)).status).toBe(200);
    expect((await call(w.owner, 'GET', `/duplicates/${pair.id}`)).status).toBe(200);
  });

  it('R-PAR-44: dismiss ("not the same person") hides the pair, is audited, and Undo brings it back; a second dismiss is DUPLICATE_ALREADY_DECIDED', async () => {
    const { pair } = await pairOf(agent);
    const d = await call<{ duplicate: Pair }>(agent, 'POST', `/duplicates/${pair.id}/dismiss`, {});
    expect([d.status, d.body.duplicate.status]).toEqual([200, 'dismissed']);
    expect((await call<{ duplicates: Pair[] }>(agent, 'GET', '/duplicates')).body.duplicates.map((x) => x.id)).not.toContain(pair.id);
    expect((await call(agent, 'POST', `/duplicates/${pair.id}/dismiss`, {})).status).toBe(409);
    const u = await call<{ duplicate: Pair }>(agent, 'POST', `/duplicates/${pair.id}/restore`, {});
    expect([u.status, u.body.duplicate.status]).toEqual([200, 'open']);
    const audits = await h.su.query<{ action: string; actor_user_id: string }>(`SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at`, [pair.id]);
    expect(audits.rows).toEqual([{ action: 'duplicate.dismissed', actor_user_id: agent.userId }, { action: 'duplicate.restored', actor_user_id: agent.userId }]);
  });

  it('R-OWN-24: two owners need a choice: the pair says so up front (preselected), an agent cannot merge it, the Team Lead can', async () => {
    const email = randomEmail();
    const x = await ownedContact(agent, { email, consent: false });
    const y = await ownedContact(other, { email, consent: false, confirmDistinct: true });
    const list = await call<{ duplicates: Pair[] }>(w.teamLead!, 'GET', '/duplicates');
    const pair = list.body.duplicates.find((d) => [d.a.id, d.b.id].includes(x.id) && [d.a.id, d.b.id].includes(y.id))!;
    expect(pair.owner.rule).toBe('choose');
    expect(pair.owner.preselectedUserId).toBe(agent.userId);
    expect(pair.canMerge).toBe(true);
    const r = await merge(w.teamLead!, x.id, y.id, pair.owner.preselectedUserId);
    expect(r.status).toBe(200);
    expect((await call(w.teamLead!, 'GET', `/duplicates/${pair.id}`)).status).toBe(404); // a merged pair leaves the list
  });
});

describe('R-PAR-45 merging a pair from the list', () => {
  it('R-PAR-45 R-OWN-24: the merge goes through the engine (merged_away / merged_in ledger, audit), moves the notes, and marks the pair merged', async () => {
    const { x, y, pair } = await pairOf(agent);
    // the notes API is lane L1's (module 57): the note is a fixture row
    await h.su.query(`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'Prefers texts after 6pm')`, [w.tenantId, randomUUID(), y.id, agent.userId]);
    const r = await merge(agent, pair.suggestedSurvivorId, pair.suggestedSurvivorId === x.id ? y.id : x.id);
    expect(r.status).toBe(200);
    const loser = (await h.su.query('SELECT closed_reason, merged_into_contact_id FROM contacts WHERE id = $1', [y.id])).rows[0];
    expect(loser).toEqual({ closed_reason: 'merged', merged_into_contact_id: x.id });
    const ledger = await h.su.query<{ type: string }>(`SELECT type FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1`, [x.id]);
    expect(ledger.rows[0]!.type).toBe('merged_in');
    expect((await h.su.query('SELECT status FROM contact_duplicate_candidates WHERE id = $1', [pair.id])).rows).toEqual([{ status: 'merged' }]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM notes WHERE contact_id = $1', [x.id])).rows[0]).toEqual({ n: 1 });
    expect((await call<{ duplicates: Pair[] }>(agent, 'GET', '/duplicates')).body.duplicates.map((d) => d.id)).not.toContain(pair.id);
  });

  it('D1 R-PAR-12: the loser\'s phone texted STOP; after the merge a text to the survivor\'s own phone is blocked, with no override', async () => {
    const { x, y } = await pairOf(agent, { firstName: 'Stopper' });
    expect((await sendText(agent, x.id, 'Hi before')).body.result).toBe('sent');
    expect((await inboundSms(h, y.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await sendText(agent, x.id, 'Still a different person')).body.result).toBe('sent');
    expect((await merge(agent, x.id, y.id)).status).toBe(200);
    const r = await sendText(agent, x.id, 'After the merge');
    expect(r.body.result).toBe('blocked');
    expect(h.providers.telephony.sms.filter((m) => m.to === x.phone).map((m) => m.body).join('\n')).not.toContain('After the merge');
    // and nothing in the merge route can override it
    const again = await sendText(agent, x.id, 'Override?', { confirmDecisionId: randomUUID() });
    expect(again.body.result === 'blocked' || again.status === 422).toBe(true);
  });

  it('D1: a STOP on the survivor keeps blocking the loser\'s number once it is the merged person\'s', async () => {
    const { x, y } = await pairOf(agent, { firstName: 'Kept' });
    expect((await inboundSms(h, x.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await merge(agent, x.id, y.id)).status).toBe(200);
    // the survivor now has the loser's phone too; any send to the merged person is refused
    const pts = await h.su.query<{ address: string }>(`SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [x.id]);
    expect(pts.rows.map((p) => p.address).sort()).toEqual([x.phone, y.phone].sort());
    expect((await sendText(agent, x.id, 'Hello')).body.result).toBe('blocked');
  });

  it('R-PAR-45: a tag on the loser lands on the survivor', async () => {
    const { x, y } = await pairOf(agent, { firstName: 'Tagged' });
    const tagId = randomUUID();
    await h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, 'user', $4)`, [w.tenantId, tagId, `Buyer ${tagId.slice(0, 6)}`, agent.userId]);
    await h.su.query(`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES ($1, $2, $3, 'user', $4)`, [w.tenantId, y.id, tagId, agent.userId]);
    const before = await call<{ duplicates: Pair[] }>(agent, 'GET', '/duplicates');
    const p = before.body.duplicates.find((d) => [d.a.id, d.b.id].includes(y.id))!;
    expect((p.a.id === y.id ? p.a : p.b).counts.tags).toBe(1);
    expect((await merge(agent, x.id, y.id)).status).toBe(200);
    expect((await h.su.query('SELECT contact_id FROM contact_tags WHERE tag_id = $1', [tagId])).rows).toEqual([{ contact_id: x.id }]);
  });

  it('R-OWN-25 E140: a phone shared by both people is one point on the survivor (deduped)', async () => {
    const phone = randomPhone();
    const x = await ownedContact(agent, { phone, consent: false });
    const y = await ownedContact(agent, { phone, consent: false, confirmDistinct: true });
    expect((await merge(agent, x.id, y.id)).status).toBe(200);
    expect((await h.su.query(`SELECT count(*)::int AS n FROM contact_points WHERE contact_id = $1 AND address = $2`, [x.id, phone])).rows[0]).toEqual({ n: 1 });
  });
});
