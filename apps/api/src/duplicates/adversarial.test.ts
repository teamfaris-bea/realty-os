// api/duplicates adversarial (PARITY_PLAN §4 critical module): tenancy, visibility, the ownership engine
// as the only merge path, idempotency and races, and opt-outs that a merge can never lift.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, type TestClient } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, ownedContact, randomEmail, sendText } from '../comms/testing.js';
import { command, intake } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let w2: CommsWorld;
let agent: TestClient;
let other: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  w2 = await commsWorld(h, { agents: 1 });
  [agent, other] = w.agents as [TestClient, TestClient];
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function pair(owner: TestClient) {
  const email = randomEmail();
  const x = await ownedContact(owner, { email, consent: false });
  const y = await ownedContact(owner, { email, consent: false, confirmDistinct: true });
  const [a, b] = [x.id, y.id].sort();
  const id = (await h.su.query<{ id: string }>('SELECT id FROM contact_duplicate_candidates WHERE contact_a_id = $1 AND contact_b_id = $2', [a, b])).rows[0]!.id;
  return { x, y, id };
}

describe('tenancy and visibility', () => {
  it('R-TEN-1 R-PERM-5: another tenant\'s pair id is 404 for read, dismiss and restore, and never listed', async () => {
    const p = await pair(agent);
    for (const c of [w2.owner, w2.agents[0]!]) {
      expect((await call(c, 'GET', `/duplicates/${p.id}`)).status).toBe(404);
      expect((await call(c, 'POST', `/duplicates/${p.id}/dismiss`, {})).status).toBe(404);
      expect((await call(c, 'POST', `/duplicates/${p.id}/restore`, {})).status).toBe(404);
      expect((await call<{ duplicates: { id: string }[] }>(c, 'GET', '/duplicates')).body.duplicates.map((d) => d.id)).not.toContain(p.id);
    }
    expect((await h.su.query('SELECT status FROM contact_duplicate_candidates WHERE id = $1', [p.id])).rows).toEqual([{ status: 'open' }]);
  });

  it('R-PERM-12: an agent who sees only one side of a pair cannot read, dismiss or merge it', async () => {
    const email = randomEmail();
    const mine = await ownedContact(agent, { email, consent: false });
    const theirs = await ownedContact(other, { email, consent: false, confirmDistinct: true });
    const [a, b] = [mine.id, theirs.id].sort();
    const id = (await h.su.query<{ id: string }>('SELECT id FROM contact_duplicate_candidates WHERE contact_a_id = $1 AND contact_b_id = $2', [a, b])).rows[0]!.id;
    expect((await call(agent, 'GET', `/duplicates/${id}`)).status).toBe(404);
    expect((await call(agent, 'POST', `/duplicates/${id}/dismiss`, {})).status).toBe(404);
    expect((await command(agent, mine.id, 'merge', { loserId: theirs.id })).status).toBe(404);
    const owner = (await h.su.query('SELECT merged_into_contact_id FROM contacts WHERE id = $1', [theirs.id])).rows[0];
    expect(owner).toEqual({ merged_into_contact_id: null });
  });

  it('R-PERM-6: an agent never sees or merges a contact they hold only as an offer card, even when a pair names it', async () => {
    const lead = await intake(h, w, { fullName: 'Offer Card' });
    const st = (await h.su.query<{ ownership_state: string; offered_to_user_id: string | null }>('SELECT ownership_state, offered_to_user_id FROM contacts WHERE id = $1', [lead.contactId])).rows[0]!;
    expect(st.ownership_state).toBe('offered');
    const offeree = [agent, other].find((c) => c.userId === st.offered_to_user_id)!;
    const mine = await ownedContact(offeree, { consent: false, firstName: 'Offer' });
    const [a, b] = [mine.id, lead.contactId].sort();
    const id = randomUUID();
    await h.su.query(`INSERT INTO contact_duplicate_candidates (tenant_id, id, contact_a_id, contact_b_id, match_reason) VALUES ($1, $2, $3, $4, 'trigram_name')`, [w.tenantId, id, a, b]);
    expect((await call(offeree, 'GET', `/duplicates/${id}`)).status).toBe(404);
    expect((await call<{ duplicates: { id: string }[] }>(offeree, 'GET', '/duplicates')).body.duplicates.map((d) => d.id)).not.toContain(id);
    expect((await command(offeree, mine.id, 'merge', { loserId: lead.contactId })).status).toBe(404);
    expect((await command(offeree, lead.contactId, 'merge', { loserId: mine.id })).status).toBe(404);
    expect((await call(w.owner, 'GET', `/duplicates/${id}`)).status).toBe(200);
  });

  it('R-PAR-45: a body field the merge route does not know (e.g. a forged tag list) is refused by the strict schema', async () => {
    const p = await pair(agent);
    const r = await command(agent, p.x.id, 'merge', { loserId: p.y.id, tags: ['VIP'] });
    expect(r.status).toBe(422);
  });
});

describe('the ownership engine is the only merge path', () => {
  it('R-OWN-7: replaying the same merge command returns the stored outcome; nothing is copied twice', async () => {
    const p = await pair(agent);
    const commandId = randomUUID();
    const r1 = await command(agent, p.x.id, 'merge', { loserId: p.y.id, commandId });
    const r2 = await command(agent, p.x.id, 'merge', { loserId: p.y.id, commandId });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const pts = await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM contact_points WHERE contact_id = $1 AND kind = 'email'`, [p.x.id]);
    expect(pts.rows[0]!.n).toBe(1);
  });

  it('R-OWN-24: two opposite merges of one pair race: exactly one wins; the other is refused CONTACT_MERGED, never a cycle', async () => {
    const p = await pair(agent);
    const [r1, r2] = await Promise.all([command(agent, p.x.id, 'merge', { loserId: p.y.id }), command(agent, p.y.id, 'merge', { loserId: p.x.id })]);
    // the loser of the race is closed as merged: refused CONTACT_MERGED, or 404 once its detail is gone for the agent
    expect(r1.status === 200 || r2.status === 200).toBe(true);
    expect([r1.status, r2.status].filter((s) => s !== 200)).toHaveLength(1);
    expect([404, 409]).toContain([r1.status, r2.status].find((s) => s !== 200));
    const rows = (await h.su.query<{ id: string; merged_into_contact_id: string | null }>('SELECT id, merged_into_contact_id FROM contacts WHERE id = ANY ($1::uuid[])', [[p.x.id, p.y.id]])).rows;
    expect(rows.filter((r) => r.merged_into_contact_id !== null)).toHaveLength(1);
  });

  it('R-PAR-44: dismissing a pair while it is being merged never resurrects it: the merged pair stays merged', async () => {
    const p = await pair(agent);
    await Promise.all([command(agent, p.x.id, 'merge', { loserId: p.y.id }), call(agent, 'POST', `/duplicates/${p.id}/dismiss`, {})]);
    const st = (await h.su.query<{ status: string }>('SELECT status FROM contact_duplicate_candidates WHERE id = $1', [p.id])).rows[0]!.status;
    expect(['merged', 'dismissed']).toContain(st);
    expect((await call(agent, 'POST', `/duplicates/${p.id}/restore`, {})).status).toBe(404); // the people are merged: the pair is gone
  });
});

describe('opt-outs survive every merge (D1, R-PAR-12)', () => {
  it('D1 R-PAR-12: STOP on either side, merged in either direction, blocks every text to the merged person', async () => {
    for (const stopOn of ['survivor', 'loser'] as const) {
      const p = await pair(agent);
      const stopped = stopOn === 'survivor' ? p.x : p.y;
      expect((await inboundSms(h, stopped.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
      expect((await command(agent, p.x.id, 'merge', { loserId: p.y.id })).status).toBe(200);
      for (const c of [agent, w.teamLead!, w.owner]) {
        const r = await sendText(c, p.x.id, `after merge ${stopOn}`);
        expect(r.body.result ?? r.status).not.toBe('sent');
      }
    }
  });

  it('D1: a merge into a contact never makes the loser\'s opted-out phone textable through the survivor (the copied point keeps its HMAC)', async () => {
    const p = await pair(agent);
    expect((await inboundSms(h, p.y.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await command(agent, p.x.id, 'merge', { loserId: p.y.id })).status).toBe(200);
    const hm = await h.su.query<{ same: boolean }>(
      `SELECT bool_and(s.address_hmac = l.address_hmac) AS same FROM contact_points s JOIN contact_points l ON l.address = s.address AND l.contact_id = $2 WHERE s.contact_id = $1`,
      [p.x.id, p.y.id]);
    expect(hm.rows[0]!.same).toBe(true);
    const before = h.providers.telephony.sms.filter((m) => m.to === p.y.phone || m.to === p.x.phone).length;
    expect((await sendText(agent, p.x.id, 'try')).body.result).toBe('blocked');
    expect(h.providers.telephony.sms.filter((m) => m.to === p.y.phone || m.to === p.x.phone).length).toBe(before);
  });
});
