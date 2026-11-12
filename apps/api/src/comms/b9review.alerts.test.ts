// Batch 9 interaction review, group comms/routing/opt-outs:
//   sends/F4            an R4 re-armed delivery of an agent's alert-phone STOP is recorded once (one revoke, one notice)
//   ownership-data/F4   a text or call the kill switch refuses (TELEPHONY_LIVE_OFF) is never a touch or a first touch
// Real Postgres; the fake telephony, and the real Twilio adapter with the switch off and a fetch that refuses to run.
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { identifiersOf } from '../leads/intake.js';
import { TwilioTelephony } from '../providers/twilio/telephony.js';
import type { TelephonyProvider } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { TELEPHONY_LIVE_OFF } from './telephonySafeguards.js';
import { type CommsWorld, call, commsWorld, messageRow, ownedContact, randomPhone, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}
const hmacOf = (phone: string) => withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => (await identifiersOf(tx, w.deps.envelope, w.tenantId as never, [phone], [])).phones[0]!.hmac, { db: w.deps.db });
const smsEvents = async (hmac: string) => (await h.su.query<{ event_type: string }>("SELECT event_type FROM consent_events WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND channel = 'sms' ORDER BY occurred_at, id", [w.tenantId, hmac])).rows.map((r) => r.event_type);
const alertNotices = async (userId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE tenant_id = $1 AND subject_type = 'membership' AND subject_id = $2 AND dedupe_key LIKE 'alert_stop:%'", [w.tenantId, userId])).rows[0]!.n);
const rearm = (ref: string) => h.su.query("UPDATE webhook_events SET status = 'received', received_at = now() - interval '10 minutes' WHERE provider_event_id = $1", [`sms:${ref}`]);
const sms = (from: string, body: string, ref: string) => telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: ref, From: from, To: w.mainNumber, Body: body, NumMedia: '0' });

describe('b9 comms sends/F4: an alert-phone keyword is recorded once per provider message (R-LSRC-7, E60)', () => {
  it('b9 comms sends/F4 R-LSRC-7 E60 E354: a re-armed delivery of an alert-phone STOP writes no second revoke and no second Admin notice', async () => {
    const agent = w.agents[0]!;
    const phone = await alertPhone(agent);
    const hmac = await hmacOf(phone);
    const ref = sid();
    expect((await sms(phone, 'STOP', ref)).statusCode).toBe(200);
    expect(await smsEvents(hmac)).toEqual(['revoke']);
    const n1 = await alertNotices(agent.userId!);
    expect(n1).toBeGreaterThan(0);
    await rearm(ref);
    expect((await sms(phone, 'STOP', ref)).statusCode).toBe(200);
    expect(await smsEvents(hmac)).toEqual(['revoke']);
    expect(await alertNotices(agent.userId!)).toBe(n1);
  });

  it('b9 comms sends/F4 E60: a STOP replayed after the agent\'s START never turns alert texts off again', async () => {
    const agent = w.agents[1]!;
    const phone = await alertPhone(agent);
    const hmac = await hmacOf(phone);
    const stop = sid();
    expect((await sms(phone, 'STOP', stop)).statusCode).toBe(200);
    expect((await sms(phone, 'START', sid())).statusCode).toBe(200);
    await rearm(stop);
    expect((await sms(phone, 'STOP', stop)).statusCode).toBe(200);
    expect(await smsEvents(hmac)).toEqual(['revoke', 'resubscribe']);
  });
});

/** Runs fn with the REAL Twilio adapter, kill switch off (no liveRequests), and a fetch that must never run. */
async function withLiveOff<T>(fn: () => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const forbidden = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error('R-TWL-1 violated: a request left the process');
  }) as typeof fetch;
  const real = new TwilioTelephony({ accountSid: 'AC' + '0'.repeat(32), authToken: 'fake-master-token', publicBaseUrl: h.config.publicBaseUrl, fetch: forbidden, sleep: async () => undefined });
  const providers = h.app.platform.providers as { telephony: TelephonyProvider };
  const fake = providers.telephony;
  providers.telephony = real;
  try {
    const out = await fn();
    expect(calls).toEqual([]);
    return out;
  } finally {
    providers.telephony = fake;
  }
}
const touchState = async (contactId: string) => {
  const c = (await h.su.query('SELECT last_human_touch_at, first_touch_at FROM contacts WHERE id = $1', [contactId])).rows[0]!;
  const ledger = Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM lead_ownership_events WHERE contact_id = $1 AND type IN ('touch_recorded','first_touch_recorded')", [contactId])).rows[0]!.n);
  return { last: c.last_human_touch_at as Date | null, first: c.first_touch_at as Date | null, ledger };
};

describe('b9 comms ownership-data/F4: the kill switch refuses before the touch (D8, R-OWN-14, R-TWL-1)', () => {
  it('b9 comms ownership-data/F4 D8 R-OWN-14 R-TWL-1: a text refused by the kill switch is blocked TELEPHONY_LIVE_OFF in TX1 and is no touch', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const before = await touchState(c.id);
    const r = await withLiveOff(() => sendText(agent, c.id, 'Hi, checking in about Saturday.'));
    expect(r.body.result).toBe('blocked');
    expect(r.body.decision!.reasons).toContain(TELEPHONY_LIVE_OFF);
    expect((await messageRow(h, r.body.message!.id)).status_reason).toBe(TELEPHONY_LIVE_OFF);
    expect(await touchState(c.id)).toEqual(before);
  });

  it('b9 comms ownership-data/F4 D8 R-OWN-14 R-TWL-1: a call refused by the kill switch dials nothing and is no touch', async () => {
    const agent = w.agents[1]!;
    const c = await ownedContact(agent, { consent: false });
    const before = await touchState(c.id);
    const r = await withLiveOff(() => call<{ result: string; reason: string | null; decision?: { reasons: string[] } }>(agent, 'POST', `/contacts/${c.id}/calls`, {}));
    expect(r.status).toBe(200);
    expect(r.body.result).not.toBe('dialing');
    expect(await touchState(c.id)).toEqual(before);
  });
});
