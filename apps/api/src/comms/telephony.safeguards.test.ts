// Lane telephony-safeguards S1 on real Postgres (createTestDb) and the deterministic fakes:
//   R-TWL-1  the kill switch end to end: the REAL Twilio adapter with TELEPHONY_LIVE_REQUESTS off is put behind the
//            single send path; a text fails with the sentence the agent sees, a call and a number purchase answer
//            with it, nothing is an opt-out, nothing is retried or reconciled, inbound webhooks keep working, and the
//            injected fetch proves no request left the process.
//   R-TWL-2  the per-tenant daily cap inside dispatch (E380: two concurrent sends at cap-1, exactly one passes;
//            E381: the platform's STOP confirmation is exempt), and calls count too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { TelephonyProvider } from '../providers/types.js';
import { TwilioTelephony } from '../providers/twilio/telephony.js';
import { startCall } from './dial.js';
import { dispatchOutbound } from './dispatch.js';
import { DAILY_CAP_SENTENCE, TELEPHONY_LIVE_OFF, TELEPHONY_LIVE_OFF_SENTENCE, countsTowardDailyCap } from './telephonySafeguards.js';
import { type CommsWorld, call, commsWorld, decisionsFor, freshReauth, inboundSms, messageRow, ownedContact, randomPhone, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

/** Puts the REAL Twilio adapter (switch off, a fetch that fails the test) behind the platform for `fn`. */
async function withLiveOff<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
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
    const out = await fn(calls);
    expect(calls).toEqual([]);
    return out;
  } finally {
    providers.telephony = fake;
  }
}

async function verifiedAlertPhone(c: (typeof w.agents)[number]): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

const jobsFor = async (kind: string, messageId: string) => Number((await h.su.query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE kind = $1 AND payload->>'messageId' = $2`, [kind, messageId])).rows[0]!.n);
const consentEventsFor = async (contactId: string) => Number((await h.su.query<{ n: string }>(`SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'`, [contactId])).rows[0]!.n);

describe('R-TWL-1 kill switch through the single send path (real adapter, switch off)', () => {
  it('R-TWL-1 b9 comms ownership-data/F4: a text is refused in TX1 with "Live texting and calling are off on this deployment." (no touch) and is never an opt-out, retried or reconciled; no request is made', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await withLiveOff(() => sendText(agent, c.id, 'Hi Jane, checking in about Saturday.'));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('blocked');
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('blocked');
    expect(m.status_reason).toBe(TELEPHONY_LIVE_OFF);
    expect(TELEPHONY_LIVE_OFF_SENTENCE).toBe('Live texting and calling are off on this deployment.');
    // not an opt-out: no revoke, the next send is gated normally (and still allowed by the gate)
    expect(await consentEventsFor(c.id)).toBe(0);
    // never reconciled (no comms.reconcile job), never re-dispatched (the message is terminal)
    expect(await jobsFor('comms.reconcile', r.body.message!.id)).toBe(0);
    expect((await dispatchOutbound(r.body.message!.id, w.deps, { tenantId: w.tenantId })).kind).toBe('noop');
    // with the fake back the same contact is texted normally: nothing was recorded against them
    expect((await sendText(agent, c.id, 'Second try')).body.result).toBe('sent');
  });

  it('R-TWL-1 b9 comms ownership-data/F4: click-to-call is refused at the gate with the same reason and dials nothing', async () => {
    const agent = w.agents[1]!;
    await verifiedAlertPhone(agent);
    const c = await ownedContact(agent, { consent: false });
    const r = await withLiveOff(() => call<{ result: string; reason: string | null }>(agent, 'POST', `/contacts/${c.id}/calls`, {}));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'gate', decision: { reasons: [TELEPHONY_LIVE_OFF] } });
    expect(await consentEventsFor(c.id)).toBe(0);
  });

  it('R-TWL-1: number purchase and "Check registration status" answer TELEPHONY_LIVE_OFF (the web shows the same sentence); nothing changes', async () => {
    await freshReauth(h, w.owner);
    const before = (await h.su.query('SELECT count(*)::int AS n FROM phone_numbers WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    const buy = await withLiveOff(() => call<{ error: { code: string } }>(w.owner, 'POST', '/numbers', { purpose: 'team_main', areaCode: '555' }));
    expect(buy.status).toBe(409);
    expect(buy.body.error.code).toBe('TELEPHONY_LIVE_OFF');
    expect((await h.su.query('SELECT count(*)::int AS n FROM phone_numbers WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(before);
    const refresh = await withLiveOff(() => call<{ error: { code: string } }>(w.owner, 'POST', `/sender-registrations/${w.registrationId}/refresh`));
    expect(refresh.status).toBe(409);
    expect(refresh.body.error.code).toBe('TELEPHONY_LIVE_OFF');
    expect((await h.su.query('SELECT status FROM sender_registrations WHERE id = $1', [w.registrationId])).rows[0]!.status).toBe('approved');
  });

  it('R-TWL-1: inbound webhooks keep working while the switch is off (an inbound text is stored and routed)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const res = await withLiveOff(() => inboundSms(h, c.phone, w.mainNumber, 'Sounds good, see you then'));
    expect(res.statusCode).toBe(200);
    const n = (await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows[0]!.n;
    expect(n).toBe(1);
  });
});

// ---- R-TWL-2: the daily cap -------------------------------------------------------------------------------

const capped = () => ({ ...w.deps, telephonyDailyCap: true });
async function setCap(cap: number, used: number): Promise<void> {
  await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = $2 WHERE tenant_id = $1', [w.tenantId, cap]);
  await h.su.query('DELETE FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId]);
  if (used > 0) {
    await h.su.query(
      `INSERT INTO telephony_daily_usage (tenant_id, day, sends)
       SELECT tenant_id, (now() AT TIME ZONE default_timezone)::date, $2 FROM tenant_settings WHERE tenant_id = $1`,
      [w.tenantId, used],
    );
  }
}
const usedToday = async () => (await h.su.query<{ n: number }>('SELECT COALESCE(sum(sends), 0)::int AS n FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;

/** A human text scheduled for later, made due, then dispatched by the caller (the worker's path). */
async function dueText(agent: (typeof w.agents)[number], body: string): Promise<{ messageId: string; contactId: string }> {
  const c = await ownedContact(agent);
  const r = await sendText(agent, c.id, body, { scheduleAt: new Date(Date.now() + 3_600_000).toISOString() });
  if (r.status !== 200 || !r.body.message) throw new Error(`schedule: ${r.status} ${JSON.stringify(r.body)}`);
  await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message.id]);
  return { messageId: r.body.message.id, contactId: c.id };
}

describe('R-TWL-2 per-tenant daily cap on texts and calls (enforced in dispatch before the provider call)', () => {
  it('R-TWL-2: the default is 200 a day with a CHECK; the fake provider does not count (deps flag off), the real adapter does', async () => {
    const d = (await h.su.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'tenant_settings' AND column_name = 'telephony_daily_cap'")).rows[0]!;
    expect(d.column_default).toBe('200');
    await expect(h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 0 WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow(/check/i);
    expect(w.deps.telephonyDailyCap).toBe(false);
  });

  it('R-TWL-2: over the cap a text is blocked with the gate reason "Today\'s sending limit for this team is reached." and nothing reaches the provider', async () => {
    await setCap(3, 3);
    const t = await dueText(w.agents[0]!, 'Over the cap');
    const before = h.providers.telephony.sms.length;
    const r = await dispatchOutbound(t.messageId, capped(), { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    const m = await messageRow(h, t.messageId);
    expect([m.status, m.status_reason]).toEqual(['blocked', 'DAILY_SEND_CAP_REACHED']);
    const ds = await decisionsFor(h, { messageId: t.messageId });
    expect(ds).toHaveLength(1);
    expect(ds[0]!.reason_codes).toContain('DAILY_SEND_CAP_REACHED');
    expect(ds[0]!.explanation).toContain(DAILY_CAP_SENTENCE);
    expect(h.providers.telephony.sms.length).toBe(before);
    expect(await usedToday()).toBe(3);
  });

  it('R-TWL-2: under the cap a text claims one unit and goes out', async () => {
    await setCap(5, 1);
    const t = await dueText(w.agents[0]!, 'Under the cap');
    expect((await dispatchOutbound(t.messageId, capped(), { tenantId: w.tenantId })).kind).toBe('sent');
    expect(await usedToday()).toBe(2);
  });

  it('R-TWL-2 E380: two concurrent sends at cap-1: exactly one passes, the other is blocked with DAILY_SEND_CAP_REACHED', async () => {
    for (let round = 0; round < 3; round++) {
      await setCap(10, 9);
      const a = await dueText(w.agents[0]!, `Race A ${round}`);
      const b = await dueText(w.agents[1]!, `Race B ${round}`);
      const out = await Promise.all([dispatchOutbound(a.messageId, capped(), { tenantId: w.tenantId }), dispatchOutbound(b.messageId, capped(), { tenantId: w.tenantId })]);
      expect(out.map((o) => o.kind).sort()).toEqual(['blocked', 'sent']);
      const loser = out[0]!.kind === 'blocked' ? a : b;
      expect((await messageRow(h, loser.messageId)).status_reason).toBe('DAILY_SEND_CAP_REACHED');
      expect(await usedToday()).toBe(10);
    }
  });

  it('R-TWL-2 E381: the platform\'s own STOP confirmation is exempt: it goes out with the cap reached and claims nothing', async () => {
    expect(countsTowardDailyCap('opt_out_confirmation')).toBe(false);
    expect(countsTowardDailyCap('help_reply')).toBe(false);
    expect(countsTowardDailyCap('none')).toBe(true);
    expect((await call(w.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: 'platform', activate: true })).status).toBe(201);
    try {
      const c = await ownedContact(w.agents[0]!);
      await setCap(2, 2);
      expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
      const q = await h.su.query<{ id: string }>("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category = 'opt_out_confirmation'", [c.id]);
      expect(q.rows).toHaveLength(1);
      const r = await dispatchOutbound(q.rows[0]!.id, capped(), { tenantId: w.tenantId });
      expect(r.kind).toBe('sent');
      expect(await usedToday()).toBe(2);
    } finally {
      expect((await call(w.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: 'provider', activate: true })).status).toBe(201);
    }
  });

  it('R-TWL-2: a call counts too: over the cap click-to-call is blocked at dial time with the same reason and nothing is dialed', async () => {
    const agent = w.agents[0]!;
    await verifiedAlertPhone(agent);
    const c = await ownedContact(agent, { consent: false });
    await setCap(4, 4);
    const before = h.providers.telephony.calls.length;
    const r = await startCall(agent.actor(), c.id, {}, capped());
    expect(r.kind).toBe('gate');
    expect(r.decision.reasons).toContain('DAILY_SEND_CAP_REACHED');
    expect(h.providers.telephony.calls.length).toBe(before);
    await setCap(4, 3);
    expect((await startCall(agent.actor(), c.id, {}, capped())).kind).toBe('dialing');
    expect(await usedToday()).toBe(4);
    await setCap(200, 0);
  });

  it('R-TWL-2: the day\'s counter only counts up (a lower count or a moved day is refused)', async () => {
    await setCap(200, 5);
    await expect(h.su.query('UPDATE telephony_daily_usage SET sends = 1 WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow(/TELEPHONY_USAGE_COUNTS_UP/);
    await expect(h.su.query("UPDATE telephony_daily_usage SET day = day - 1 WHERE tenant_id = $1", [w.tenantId])).rejects.toThrow(/TELEPHONY_USAGE_COUNTS_UP/);
    await setCap(200, 0);
  });
});
