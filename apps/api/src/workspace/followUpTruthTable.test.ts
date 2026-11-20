// b19 Today fix 1 (M5; R-TODAY-14), over real Postgres as app_user: the Due line and the facts of the Last line of a
// quiet person are decided from ONE story (core quietStory), so they cannot disagree. The truth table, by evidence,
// through real rows. (The words of the Last line are the web's: apps/web feed/lib/followUp.test.ts tests the same table.)
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, ownedContact, randomPhone, sendText } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { call } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let a: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  a = w.agents[0]!;
});
afterAll(async () => {
  await h?.close();
});

interface Row {
  contact: { id: string } | null;
  itemType: string;
  why: string[] | null;
  reasons: { code: string; label: string }[];
  lastTouch: { kind: string; reported: boolean; at: string } | null;
  lastConversation: { kind: string } | null;
  lastAutomatic: { kind: string; bulk: boolean } | null;
  importedHistoryAt: string | null;
  quiet: { basis: string; at: string | null; attempt: { kind: string; at: string; what: string } | null } | null;
}

async function rowOf(contactId: string): Promise<Row> {
  const r = await call<{ followUpToday: { people: Row[] } }>(a, 'GET', '/feed');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const row = r.body.followUpToday.people.find((p) => p.contact?.id === contactId);
  expect(row, 'in the plan').toBeDefined();
  return row!;
}

const DAY = `interval '1 day'`;
/** A person of the agent's in `stage`, theirs for 90 days, whom the system has never counted a touch for. */
async function person(first: string, stage = 'connected') {
  const c = await ownedContact(a, { firstName: first });
  await suFixture(h, [{ text: `UPDATE contacts SET stage = $2, owned_at = clock_timestamp() - 90 * ${DAY}, last_human_touch_at = NULL WHERE id = $1`, values: [c.id, stage] }]);
  return c;
}
const su = (text: string, values: unknown[]) => suFixture(h, [{ text, values }]);
const touch = (id: string, days: number | null) => su(`UPDATE contacts SET last_human_touch_at = CASE WHEN $2::int IS NULL THEN NULL ELSE clock_timestamp() - $2::int * ${DAY} - interval '1 hour' END WHERE id = $1`, [id, days]);
/** A text the agent really sent through the fake provider, moved `days` back. */
async function sentText(id: string, days: number, body = 'Checking in about Saturday.') {
  const r = await sendText(a, id, body);
  expect(r.body.result, JSON.stringify(r.body)).toBe('sent');
  await su(`UPDATE messages SET occurred_at = clock_timestamp() - $2::int * ${DAY} - interval '1 hour', dispatched_at = clock_timestamp() - $2::int * ${DAY} - interval '1 hour' WHERE id = $1`, [r.body.message!.id, days]);
  return r.body.message!.id;
}

describe('R-TODAY-14: Connected × evidence: the Due line and the Last line’s facts come from one story', () => {
  it('none: "no conversation yet", and nothing for a Last line to repeat', async () => {
    const c = await person('None');
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NEVER_CONTACTED', label: 'Connected: no conversation yet' }]);
    expect(row).toMatchObject({ quiet: { basis: 'never', at: null, attempt: null }, lastTouch: null, lastConversation: null, lastAutomatic: null, importedHistoryAt: null });
  });

  it('automated only: still "no conversation yet"; the automatic text is its own line and moves nothing', async () => {
    const c = await person('Auto');
    const id = await sentText(c.id, 2, 'New listings near you this week');
    await su(`UPDATE messages SET initiator = 'system', initiated_by_user_id = NULL WHERE id = $1`, [id]);
    await touch(c.id, null);
    const row = await rowOf(c.id);
    expect(row.reasons[0]).toEqual({ code: 'WARM_NEVER_CONTACTED', label: 'Connected: no conversation yet' });
    expect(row).toMatchObject({ quiet: { basis: 'never' }, lastTouch: null, lastAutomatic: { kind: 'text', bulk: false } });
  });

  it('bulk only: the same, and the line says bulk', async () => {
    const c = await person('Bulk');
    const id = await sentText(c.id, 3, 'Open house Saturday');
    await su(`UPDATE messages SET bulk_action_id = $2, purpose = 'marketing' WHERE id = $1`, [id, randomUUID()]);
    await touch(c.id, null);
    const row = await rowOf(c.id);
    expect(row.reasons[0]).toEqual({ code: 'WARM_NEVER_CONTACTED', label: 'Connected: no conversation yet' });
    expect(row).toMatchObject({ quiet: { basis: 'never' }, lastTouch: null, lastAutomatic: { kind: 'text', bulk: true } });
  });

  it('E885 M5, the reviewer’s case: a text that was counted as a touch and came back undelivered: "but the last text was not delivered", never "no conversation for 9 days" beside "no conversation yet"', async () => {
    const c = await person('Undelivered');
    const id = await sentText(c.id, 9);
    // the send had moved the system's clock; the carrier then reported it undelivered
    await touch(c.id, 9);
    await su(`UPDATE messages SET status = 'undelivered' WHERE id = $1`, [id]);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NOT_DELIVERED', label: 'Connected, but the last text was not delivered' }]);
    expect(row.why).toEqual(['Connected, but the last text was not delivered']);
    expect(row).toMatchObject({ quiet: { basis: 'undelivered', attempt: { kind: 'text', what: 'undelivered' } }, lastTouch: null });
    expect(row.quiet!.at).toBe(row.quiet!.attempt!.at);
  });

  it('a failed dial that was counted as a touch: "but the last call did not connect"', async () => {
    const c = await person('Dial');
    // a real dial through the fake provider (the dial is what the system counts), which then never connected
    const ch = await a.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await a.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    const d = await call<{ result: string; callId: string }>(a, 'POST', `/contacts/${c.id}/calls`, {});
    expect(d.body.result, JSON.stringify(d.body)).toBe('dialing');
    await touch(c.id, 9);
    await su(`UPDATE calls SET status = 'failed', answered_at = NULL, started_at = clock_timestamp() - 9 * ${DAY} - interval '1 hour' WHERE id = $1`, [d.body.callId]);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_CALL_FAILED', label: 'Connected, but the last call did not connect' }]);
    expect(row).toMatchObject({ quiet: { basis: 'failed_dial', attempt: { kind: 'call', what: 'failed_dial' } }, lastTouch: null });
  });

  it('a logged outside call: quiet from that call, and the Last line is that call, reported', async () => {
    const c = await person('Logged');
    const at = new Date(Date.now() - 9 * 86_400_000 - 3_600_000).toISOString();
    expect((await call(a, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at, outcome: 'connected', noteId: randomUUID() })).status).toBe(201);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }]);
    expect(row).toMatchObject({ quiet: { basis: 'contact', at, attempt: null }, lastTouch: { kind: 'call', reported: true, at }, lastConversation: null });
  });

  it('a delivered text of the agent’s (verified by the system): quiet from that text; the touch and the text are one instant', async () => {
    const c = await person('Verified');
    await sentText(c.id, 9);
    await touch(c.id, 9);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }]);
    expect(row).toMatchObject({ quiet: { basis: 'contact' }, lastTouch: { kind: 'text', reported: false } });
    expect(row.quiet!.at).toBe(row.lastTouch!.at);
  });

  it('their reply: quiet from their reply (8 days), not from our older text (9)', async () => {
    const c = await person('Reply');
    await sentText(c.id, 9);
    await touch(c.id, 9);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Can we see it Saturday?')).statusCode).toBe(200);
    await su(`UPDATE messages SET occurred_at = clock_timestamp() - 8 * ${DAY} - interval '1 hour' WHERE contact_id = $1 AND direction = 'inbound'`, [c.id]);
    await su(`UPDATE contacts SET stage = 'connected' WHERE id = $1`, [c.id]);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 8 days' }]);
    expect(row).toMatchObject({ quiet: { basis: 'contact' }, lastTouch: { kind: 'text' } });
    expect(row.quiet!.at).toBe(row.lastTouch!.at);
  });

  it('imported only: both lines say imported; a day count from the imported date is never called a conversation', async () => {
    const c = await person('Imported');
    await su(
      `INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, imported, created_at)
       SELECT tenant_id, $2, id, NULL, 'Imported note', 'import', true, clock_timestamp() - 40 * ${DAY} - interval '1 hour' FROM contacts WHERE id = $1`,
      [c.id, randomUUID()],
    );
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_IMPORTED_ONLY', label: 'Connected: only imported history, the latest 40 days ago' }]);
    expect(row).toMatchObject({ quiet: { basis: 'imported' }, lastTouch: null });
    expect(row.importedHistoryAt).toBe(row.quiet!.at);
  });

  it('a touch on record with nothing readable behind it: quiet from that touch, and the story says so (the web then never writes "No conversation yet." under it)', async () => {
    const c = await person('Touch');
    await touch(c.id, 9);
    const row = await rowOf(c.id);
    expect(row.reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }]);
    expect(row).toMatchObject({ quiet: { basis: 'touch_only', attempt: null }, lastTouch: null });
    expect(row.quiet!.at).not.toBeNull();
  });

  it('a note on top of an old conversation: the note is the Last line, and the conversation the Due line counts from is sent beside it', async () => {
    const c = await person('Noted');
    const at = new Date(Date.now() - 12 * 86_400_000 - 3_600_000).toISOString();
    expect((await call(a, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at, outcome: 'connected', noteId: randomUUID() })).status).toBe(201);
    expect((await call(a, 'POST', `/contacts/${c.id}/notes`, { body: 'Ask about the school district.' })).status).toBe(201);
    const row = await rowOf(c.id);
    expect(row.reasons[0]!.label).toBe('Connected: no conversation for 12 days');
    expect(row).toMatchObject({ quiet: { basis: 'contact', at }, lastTouch: { kind: 'note' }, lastConversation: { kind: 'call', reported: true, at } });
  });

  it('Long-term follow-up × the same evidence leads with its own label', async () => {
    const c = await person('Nurture', 'nurture');
    const id = await sentText(c.id, 40);
    await touch(c.id, 40);
    await su(`UPDATE messages SET status = 'failed' WHERE id = $1`, [id]);
    expect((await rowOf(c.id)).reasons).toEqual([{ code: 'WARM_NOT_DELIVERED', label: 'Long-term follow-up, but the last text was not delivered' }]);
  });
});
