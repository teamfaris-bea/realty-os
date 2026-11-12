// Batch 9 interaction review, group comms/routing/opt-outs: sender health and keyword replies on tracking numbers.
//   sends/F1  a 30032/30034 marks only the failing NUMBER not ready to text (never the shared registration); the notice
//             names exactly what is blocked; a system keyword reply never makes a tracking number the sticky sender
//   sends/F3  a STOP confirmation (or HELP reply) for a tracking number that cannot text goes from the team number that
//             can, through the single send path
// Real Postgres, fake telephony.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { dispatchOutbound } from './dispatch.js';
import { readTextParts } from './mmsTextJob.js';
import { type CommsWorld, call, commsWorld, freshReauth, ownedContact, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

const hex32 = () => randomBytes(16).toString('hex');
const replies = async (contactId: string) => (await h.su.query<{ id: string; phone_number_id: string; status: string; status_reason: string | null }>("SELECT id, phone_number_id, status, status_reason FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category IN ('opt_out_confirmation','help_reply') ORDER BY created_at", [contactId])).rows;
const sticky = async (contactId: string) => (await h.su.query('SELECT sticky_phone_number_id FROM conversations WHERE contact_id = $1', [contactId])).rows[0]?.sticky_phone_number_id ?? null;
const reg = async () => (await h.su.query('SELECT status, status_detail FROM sender_registrations WHERE id = $1', [w.registrationId])).rows[0]!;
const flag = async (numberId: string) => (await h.su.query('SELECT sender_not_verified_at IS NOT NULL AS flagged, sender_not_verified_detail AS detail FROM phone_numbers WHERE id = $1', [numberId])).rows[0]!;

async function buyTracking(body: Record<string, unknown>) {
  await freshReauth(h, w.owner);
  const n = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', ...body });
  expect(n.status).toBe(201);
  return n.body.number;
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  expect((await call(w.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: 'platform', activate: true })).status).toBe(201);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('b9 comms sends/F1: sender health is per number (R-TWL-9)', () => {
  it('b9 comms sends/F1 R-TWL-9 R-CONSENT-17: 30034 on a tracking number sharing the team registration pauses texting from THAT number only; the main number keeps texting; the notice says exactly that; the HELP reply never became the sticky sender', async () => {
    const tracking = await buyTracking({ registrationId: w.registrationId });
    const agent = w.agents[0]!;
    const x = await ownedContact(agent);
    expect((await telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: sid(), From: x.phone, To: tracking.e164, Body: 'HELP', NumMedia: '0' })).statusCode).toBe(200);
    const [help] = await replies(x.id);
    expect(help!.phone_number_id).toBe(tracking.id);
    h.providers.telephony.failNext({ kind: 'rejected', code: '30034' });
    expect((await dispatchOutbound(help!.id, w.deps, { tenantId: w.tenantId })).kind).toBe('failed');
    // the shared registration is untouched; only the tracking number is flagged
    expect((await reg()).status).toBe('approved');
    expect(await flag(tracking.id)).toMatchObject({ flagged: true });
    expect((await flag(tracking.id)).detail).toMatch(/30034/);
    expect((await flag(w.mainNumberId)).flagged).toBe(false);
    // the keyword reply did not make the tracking number the conversation's sender
    expect(await sticky(x.id)).not.toBe(tracking.id);
    // the main number still texts, to the HELP texter and to anyone else
    const other = await ownedContact(agent);
    expect((await sendText(agent, other.id, 'Hi from the team')).body.result).toBe('sent');
    const toX = await sendText(agent, x.id, 'Happy to help');
    expect(toX.body.result).toBe('sent');
    expect((await h.su.query('SELECT phone_number_id FROM messages WHERE id = $1', [toX.body.message!.id])).rows[0]!.phone_number_id).not.toBe(tracking.id);
    // the notice names the one number and says what is (and is not) blocked
    const n = (await h.su.query<{ body: string }>("SELECT body FROM notifications WHERE subject_id = $1 AND dedupe_key LIKE 'sender_not_verified:%'", [tracking.id])).rows;
    expect(n.length).toBeGreaterThan(0);
    expect(n[0]!.body).toContain(tracking.e164.slice(-4));
    expect(n[0]!.body).toMatch(/Other team numbers are not affected/);
    // attaching the SAME registration again never clears it (only the carrier read does)
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PATCH', `/numbers/${tracking.id}/registration`, { registrationId: w.registrationId })).status).toBe(200);
    expect((await flag(tracking.id)).flagged).toBe(true);
    // "Check registration status" clears the number's flag
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/sender-registrations/${w.registrationId}/refresh`)).status).toBe(200);
    expect((await flag(tracking.id)).flagged).toBe(false);
  });

  it('b9 comms sends/F1 R-CONSENT-7: a system keyword reply from a tracking number that CAN text still never becomes the sticky sender', async () => {
    const tracking = await buyTracking({ registrationId: w.registrationId });
    const x = await ownedContact(w.agents[1]!);
    expect((await telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: sid(), From: x.phone, To: tracking.e164, Body: 'HELP', NumMedia: '0' })).statusCode).toBe(200);
    const [help] = await replies(x.id);
    expect(help!.phone_number_id).toBe(tracking.id);
    expect((await dispatchOutbound(help!.id, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    expect(await sticky(x.id)).not.toBe(tracking.id);
  });
});

describe('b9 comms sends/F3: keyword confirmations for a tracking number that cannot text', () => {
  it('b9 comms sends/F3 R-TWL-11 E386 R-CONSENT-7: a text-part STOP to a Lead-sources tracking number (no registration) is confirmed from the team number, through the single send path', async () => {
    await freshReauth(h, w.owner);
    const src = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Open house sign', kind: 'sign_call' });
    const tracking = await buyTracking({ leadSourceId: src.body.source.id });
    expect((await h.su.query('SELECT registration_id FROM phone_numbers WHERE id = $1', [tracking.id])).rows[0]!.registration_id).toBeNull();
    const x = await ownedContact(w.agents[0]!);
    const mm = `MM${hex32()}`;
    const me = `ME${hex32()}`;
    h.providers.telephony.media.set(me, { bytes: new Uint8Array(Buffer.from('STOP')), contentType: 'text/plain' });
    expect((await telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: mm, From: x.phone, To: tracking.e164, Body: '', NumMedia: '1', MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${mm}/Media/${me}`, MediaContentType0: 'text/plain' })).statusCode).toBe(200);
    const messageId = (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0]!.id;
    const job = (await h.su.query<{ payload: Record<string, unknown> }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [messageId])).rows[0]!.payload;
    expect((await readTextParts(systemActor(w.tenantId, 'provider'), { messageId, ...job } as never, w.deps)).revoked).toEqual(['stop']);
    const [conf] = await replies(x.id);
    expect(conf!.phone_number_id).toBe(w.mainNumberId);
    const out = await dispatchOutbound(conf!.id, w.deps, { tenantId: w.tenantId });
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'sent' });
    expect((await sendText(w.agents[0]!, x.id, 'Still there?')).body.result).toBe('blocked'); // D1: the STOP holds
  });
});
