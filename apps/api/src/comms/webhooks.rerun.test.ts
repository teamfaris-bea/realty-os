// R-LSRC-7 / E354 (pilot plan R4): no lead lost to a transient fault. A provider delivery whose first run failed (an
// injected database error) or crashed (left 'received' past the stale window) is processed when the provider retries,
// exactly once; a processed delivery stays a duplicate; unrouted and rejected rows never re-arm. Every run() caller is
// idempotent on a re-run: lead email, telephony SMS, inbound calls and status callbacks. The injected failure is a
// test-only trigger the superuser adds and drops (no application path writes it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { enableInbox, labelledBody, leadAddress, postLeadEmail } from '../leadEmail/testing.js';
import { type CommsWorld, commsWorld, inboundSms, messageRow, ownedContact, randomPhone, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h);
  await h.su.query(`CREATE FUNCTION public.test_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED'; END $$`);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** Runs `send` once with an injected failure on `table`, then without it. */
async function failOnce(table: string, send: () => Promise<{ statusCode: number }>): Promise<[number, number]> {
  await h.su.query(`CREATE TRIGGER test_injected BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.test_injected_failure()`);
  let first: number;
  try {
    first = (await send()).statusCode;
  } finally {
    await h.su.query(`DROP TRIGGER test_injected ON public.${table}`);
  }
  return [first, (await send()).statusCode];
}
const event = async (id: string) => (await h.su.query<{ status: string; error_code: string | null }>('SELECT status, error_code FROM webhook_events WHERE provider_event_id = $1', [id])).rows;

describe('R-LSRC-7 E354: a failed or crashed delivery is processed on the retry, once', () => {
  it('R-LSRC-7 E354: a lead email whose first processing failed becomes one lead on the retry; a later retry is a duplicate', async () => {
    const inbox = await enableInbox(h, w.owner, w.sourceId);
    const email = leadAddress();
    const body = { messageId: '<rerun-1@mail.test>', to: inbox.address!, text: labelledBody({ name: 'Riley Rerun', email }) };
    const [first, second] = await failOnce('lead_inquiries', () => postLeadEmail(h, body));
    expect(first).toBe(500);
    expect(second).toBe(200);
    const contacts = (await h.su.query('SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND address = $2', [w.tenantId, email])).rows;
    expect(contacts).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_email_messages WHERE tenant_id = $1 AND contact_id = $2', [w.tenantId, contacts[0]!.contact_id])).rows[0]!.n).toBe(1);
    const again = await postLeadEmail(h, body);
    expect(JSON.parse(again.body).outcome).toBe('duplicate');
  });

  it('R-LSRC-7 E354: an inbound SMS whose first run failed is stored once on the retry', async () => {
    const from = randomPhone();
    const ref = sid();
    const [first, second] = await failOnce('messages', () => inboundSms(h, from, w.mainNumber, 'Hello there', ref));
    expect([first, second]).toEqual([500, 200]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE provider_message_ref = $1', [ref])).rows[0]!.n).toBe(1);
    expect(await event(`sms:${ref}`)).toEqual([{ status: 'processed', error_code: null }]);
    expect((await inboundSms(h, from, w.mainNumber, 'Hello there', ref)).statusCode).toBe(200);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE provider_message_ref = $1', [ref])).rows[0]!.n).toBe(1);
  });

  it('R-LSRC-7 E354: an inbound call whose first run failed is stored once on the retry', async () => {
    const from = randomPhone();
    const callSid = sid('CA');
    const send = () => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: w.mainNumber, CallStatus: 'ringing', Direction: 'inbound' });
    const [first, second] = await failOnce('calls', send);
    expect([first, second]).toEqual([500, 200]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM calls WHERE provider_call_ref = $1', [callSid])).rows[0]!.n).toBe(1);
  });

  it('R-LSRC-7 E354: a status callback whose first run failed is applied once on the retry', async () => {
    const c = await ownedContact(w.agents[0]!);
    const r = await sendText(w.agents[0]!, c.id, 'Rerun status');
    const id = r.body.message!.id;
    const ref = (await messageRow(h, id)).provider_message_ref!;
    const send = () => telephonyWebhook(h, `/webhooks/telephony/status?m=${id}`, { MessageSid: ref, MessageStatus: 'delivered', From: w.mainNumber, To: c.phone });
    const [first, second] = await failOnce('message_status_events', send);
    expect([first, second]).toEqual([500, 200]);
    expect((await messageRow(h, id)).status).toBe('delivered');
    expect((await h.su.query('SELECT count(*)::int AS n FROM message_status_events WHERE message_id = $1', [id])).rows[0]!.n).toBe(1);
  });

  it('R-LSRC-7 E354: a run that crashed (still received past the stale window) runs again; a fresh one is a duplicate', async () => {
    const from = randomPhone();
    const ref = sid();
    expect((await inboundSms(h, from, w.mainNumber, 'Crash test', ref)).statusCode).toBe(200);
    // the delivery as a crash would leave it: recorded, never finished, and the work rolled back
    await h.su.query(`UPDATE webhook_events SET status = 'received', processed_at = NULL WHERE provider_event_id = $1`, [`sms:${ref}`]);
    await h.su.query('DELETE FROM messages WHERE provider_message_ref = $1', [ref]).catch(() => undefined);
    const stored = (await h.su.query('SELECT count(*)::int AS n FROM messages WHERE provider_message_ref = $1', [ref])).rows[0]!.n;
    // fresh (inside the window): a duplicate, nothing runs
    expect((await inboundSms(h, from, w.mainNumber, 'Crash test', ref)).statusCode).toBe(200);
    expect((await event(`sms:${ref}`))[0]!.status).toBe('received');
    await h.su.query(`UPDATE webhook_events SET received_at = now() - interval '10 minutes' WHERE provider_event_id = $1`, [`sms:${ref}`]);
    expect((await inboundSms(h, from, w.mainNumber, 'Crash test', ref)).statusCode).toBe(200);
    expect((await event(`sms:${ref}`))[0]!.status).toBe('processed');
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE provider_message_ref = $1', [ref])).rows[0]!.n).toBe(Math.max(stored, 1));
  });

  it('R-LSRC-7: an unrouted delivery stays unrouted on a retry', async () => {
    const ref = sid();
    expect((await inboundSms(h, randomPhone(), '+15550000000', 'Nobody', ref)).statusCode).toBe(200);
    expect((await inboundSms(h, randomPhone(), '+15550000000', 'Nobody', ref)).statusCode).toBe(200);
    expect(await event(`sms:${ref}`)).toEqual([{ status: 'unrouted', error_code: null }]);
  });
});
