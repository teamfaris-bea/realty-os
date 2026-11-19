// b19 Today fix 6 (M11; R-TODAY-18), over real Postgres as app_user: the person picker's "Recent people" is the
// CALLER'S OWN recent activity (the people they most recently logged for, wrote a note about or called), newest first,
// and only people they may log for now. It is read from rows that already exist (notes by author, calls by agent):
// opening a person or the picker writes nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, ownedContact } from '../comms/testing.js';
import { call, suFixture } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let a: TestClient;
let b: TestClient;
let tc: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  [a, b] = w.agents as [TestClient, TestClient];
  [tc] = w.others as [TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const recent = async (c: TestClient) => {
  const r = await call<{ people: { id: string; name: string }[] }>(c, 'GET', '/activities/recent-people');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.people;
};
const logCall = async (c: TestClient, contactId: string) => {
  const r = await call(c, 'POST', `/contacts/${contactId}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 1000).toISOString(), outcome: 'connected', noteId: randomUUID() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};

describe('M11 (R-TODAY-18): GET /activities/recent-people', () => {
  it('a call just logged from a personal phone puts the person FIRST; a person only the system saw activity for (their inbound text) is not in it', async () => {
    const first = await ownedContact(a, { firstName: 'Ada' });
    const second = await ownedContact(a, { firstName: 'Bea' });
    const systemOnly = await ownedContact(a, { firstName: 'Cyd' });
    expect(await recent(a)).toEqual([]);
    await logCall(a, first.id);
    expect((await call(a, 'POST', `/contacts/${second.id}/notes`, { body: 'Prefers mornings.' })).status).toBe(201);
    // the newest thing in the tenant is somebody texting in: the system's activity, not the agent's
    expect((await inboundSms(h, systemOnly.phone, w.mainNumber, 'Hello?')).statusCode).toBe(200);
    expect(await recent(a)).toEqual([{ id: second.id, name: 'Bea Doe' }, { id: first.id, name: 'Ada Doe' }]);
    // logging again moves them back to the top, once
    await logCall(a, first.id);
    expect((await recent(a)).map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it('a Team Lead’s list is their OWN activity, not the whole team’s', async () => {
    const theirs = await ownedContact(b, { firstName: 'Dov' });
    await logCall(b, theirs.id);
    expect(await recent(w.teamLead!)).toEqual([]);
    await logCall(w.teamLead!, theirs.id);
    expect(await recent(w.teamLead!)).toEqual([{ id: theirs.id, name: 'Dov Doe' }]);
    // and another agent's activity never shows in mine
    expect((await recent(a)).map((p) => p.id)).not.toContain(theirs.id);
  });

  it('only people the caller may log for NOW: a person who was moved to another agent leaves the list, and the route refuses the log as before', async () => {
    const moving = await ownedContact(a, { firstName: 'Eli' });
    await logCall(a, moving.id);
    expect((await recent(a)).map((p) => p.id)).toContain(moving.id);
    // (a fixture: the reassignment's own command and ledger are another module's; only the resulting ownership matters here)
    await suFixture(h, [{ text: 'UPDATE contacts SET owner_user_id = $2 WHERE id = $1', values: [moving.id, b.userId] }]);
    expect((await recent(a)).map((p) => p.id)).not.toContain(moving.id);
    expect((await call(a, 'POST', `/contacts/${moving.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date().toISOString(), noteId: randomUUID() })).status).toBe(404);
  });

  it('at most 8 people, and reading it writes nothing', async () => {
    for (let i = 0; i < 10; i++) await logCall(b, (await ownedContact(b, { firstName: `Many${i}`, consent: false })).id);
    const counts = async () => (await h.su.query<{ n: string; t: string; au: string }>('SELECT (SELECT count(*) FROM notes WHERE tenant_id = $1) AS n, (SELECT count(*) FROM tasks WHERE tenant_id = $1) AS t, (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS au', [w.tenantId])).rows[0];
    const before = await counts();
    const list = await recent(b);
    expect(list).toHaveLength(8);
    expect(list[0]!.name).toBe('Many9 Doe');
    expect(await counts()).toEqual(before);
  });

  it('a Transaction Coordinator, who may log for nobody, gets an empty list', async () => {
    expect(await recent(tc)).toEqual([]);
  });
});
