// Lane telephony-safeguards S3 on real Postgres and the deterministic fakes: every opt-out path revokes exactly once and
// never lifts (D1 unchanged: sending checks only opt-outs).
//   R-TWL-7  Twilio's OptOutType (E383, E384): STOP adds the usual STOP effects with no platform reply; START / HELP / YES
//            change nothing.
//   R-TWL-8  error 21610 on an agent alert text: the alert phone's revoke, as the agent keyword path records it; START restores.
//   R-TWL-9  30032 / 30034 (E385): SENDER_NOT_VERIFIED, the NUMBER not ready in the same transaction (b9 review sends/F1:
//            never the shared registration), texts from it blocked,
//            calls still work, one notice per number per day, only "Check registration status" restores it.
//   R-TWL-10 a toll-free receiving number: no platform STOP confirmation or HELP reply.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { dispatchAgentAlertSms } from './dispatch.js';
import { SENDER_NOT_VERIFIED, SENDER_NOT_VERIFIED_CODES, SENDER_NOT_VERIFIED_SENTENCE } from './telephonySafeguards.js';
import { type CommsWorld, call, commsWorld, freshReauth, inboundSms, messageRow, ownedContact, randomPhone, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const revokes = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [contactId])).rows[0]!.n);
const confirmations = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category IN ('opt_out_confirmation','help_reply')", [contactId])).rows[0]!.n);
const smsWith = (from: string, to: string, body: string, extra: Record<string, string> = {}) => telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: sid(), From: from, To: to, Body: body, NumMedia: '0', ...extra });
const usePlatformConfirmations = async (on: boolean) => {
  expect((await call(w.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: on ? 'platform' : 'provider', activate: true })).status).toBe(201);
};

async function alertPhone(c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}

describe('R-TWL-7 Twilio OptOutType', () => {
  it('R-TWL-7: OptOutType=STOP on a body we read as nothing ("ok thanks") is a STOP (matched OPTOUTTYPE_STOP): revoked once, texts blocked, and no platform reply even with the platform as confirmation sender', async () => {
    await usePlatformConfirmations(true);
    try {
      const agent = w.agents[0]!;
      const c = await ownedContact(agent);
      expect((await smsWith(c.phone, w.mainNumber, 'ok thanks', { OptOutType: 'STOP' })).statusCode).toBe(200);
      const m = (await h.su.query("SELECT opt_out_keyword FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows[0]!;
      expect(m.opt_out_keyword).toBe('OPTOUTTYPE_STOP');
      expect(await revokes(c.id)).toBe(1);
      expect(await confirmations(c.id)).toBe(0);
      const r = await sendText(agent, c.id, 'Are you still looking?');
      expect(r.body.result).toBe('blocked');
      expect(r.body.decision!.reasons).toContain('CONSENT_REVOKED');
    } finally {
      await usePlatformConfirmations(false);
    }
  });

  it('R-TWL-7 E383: OptOutType=STOP on opt-out language or a wrong number keeps OUR classification (no second revoke)', async () => {
    for (const body of ['please stop texting me', 'wrong number']) {
      const a = await ownedContact(w.agents[0]!);
      const b = await ownedContact(w.agents[0]!);
      await smsWith(a.phone, w.mainNumber, body);
      await smsWith(b.phone, w.mainNumber, body, { OptOutType: 'STOP' });
      expect(await revokes(b.id), body).toBe(await revokes(a.id));
      const k = (await h.su.query("SELECT opt_out_keyword FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [b.id])).rows[0]!.opt_out_keyword;
      expect(k).not.toBe('OPTOUTTYPE_STOP');
    }
  });

  it('R-TWL-7 E384: OptOutType START or HELP, and a body of YES, change nothing; YES never lifts an opt-out', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await smsWith(c.phone, w.mainNumber, 'STOP');
    expect(await revokes(c.id)).toBe(1);
    const lifts = async () => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type <> 'revoke'", [c.id])).rows[0]!.n);
    const before = await lifts();
    await smsWith(c.phone, w.mainNumber, 'YES');
    await smsWith(c.phone, w.mainNumber, 'yes please', { OptOutType: 'START' });
    await smsWith(c.phone, w.mainNumber, 'what is this', { OptOutType: 'HELP' });
    expect(await lifts()).toBe(before);
    expect(await revokes(c.id)).toBe(1);
    expect((await sendText(agent, c.id, 'Hello?')).body.result).toBe('blocked');
  });

  it('R-TWL-7: OptOutType=STOP from an agent\'s own alert phone stops their alert texts', async () => {
    const agent = w.agents[1]!;
    const phone = await alertPhone(agent);
    await smsWith(phone, w.mainNumber, 'got it', { OptOutType: 'STOP' });
    const ev = (await h.su.query("SELECT event_type, evidence FROM consent_events WHERE contact_id IS NULL AND evidence->>'recipient' = 'user' ORDER BY occurred_at DESC LIMIT 1")).rows[0]!;
    expect(ev.event_type).toBe('revoke');
    expect(ev.evidence.matched).toBe('OPTOUTTYPE_STOP');
  });
});

describe('R-TWL-10 toll-free keyword replies', () => {
  it('R-TWL-10: a STOP or HELP to a toll-free number gets no platform reply (the carrier answers); the same to a local number does (platform policy)', async () => {
    await usePlatformConfirmations(true);
    try {
      const tf = '+1855' + String(5_550_100 + Math.floor(Math.random() * 99)).padStart(7, '0');
      await h.su.query(`
        INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, registration_id, acquired_at)
        VALUES ($1, $2, $3, 'telephony', $4, 'toll_free', 'tracking', true, true, $5, now())`, [w.tenantId, randomUUID(), tf, 'PN' + 'b'.repeat(32), w.registrationId]);
      const a = await ownedContact(w.agents[0]!);
      await smsWith(a.phone, tf, 'STOP');
      await smsWith(a.phone, tf, 'HELP');
      expect(await revokes(a.id)).toBe(1);
      expect(await confirmations(a.id)).toBe(0);
      const b = await ownedContact(w.agents[0]!);
      await smsWith(b.phone, w.mainNumber, 'HELP');
      await smsWith(b.phone, w.mainNumber, 'STOP');
      expect(await confirmations(b.id)).toBe(2);
    } finally {
      await usePlatformConfirmations(false);
    }
  });
});

describe('R-TWL-8 error 21610 on an agent alert text', () => {
  const delivery = async (userId: string) => {
    const n = randomUUID();
    const d = randomUUID();
    await h.su.query("INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, dedupe_key) VALUES ($1,$2,$3,'lead_offer','critical','New lead offer',$4)", [w.tenantId, n, userId, `t:${n}`]);
    await h.su.query("INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'sms','alert_phone','pending',now())", [w.tenantId, d, n]);
    return d;
  };

  it('R-TWL-8: 21610 records the alert phone\'s revoke (once), suppresses the delivery PROVIDER_OPTED_OUT, audits, tells Admins; the next alert is blocked; the agent\'s own START restores alerts', async () => {
    const agent = w.agents[0]!;
    const phone = await alertPhone(agent);
    h.providers.telephony.failNext({ kind: 'rejected', code: '21610' });
    const d1 = await delivery(agent.userId!);
    const r1 = await dispatchAgentAlertSms(d1, w.deps, w.tenantId);
    expect(r1).toMatchObject({ kind: 'suppressed', reasons: ['PROVIDER_OPTED_OUT'] });
    expect((await h.su.query('SELECT status, last_error FROM notification_deliveries WHERE id = $1', [d1])).rows[0]).toEqual({ status: 'suppressed', last_error: 'PROVIDER_OPTED_OUT' });
    const ev = (await h.su.query("SELECT event_type, source, evidence FROM consent_events WHERE contact_id IS NULL AND evidence->>'matched' = 'PROVIDER_21610' ORDER BY occurred_at DESC")).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: 'revoke', source: 'inbound_keyword' });
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND reason = 'AGENT_ALERT_PROVIDER_OPT_OUT'", [w.tenantId, agent.userId])).rows[0]!.n).toBe(1);
    expect((await h.su.query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND subject_type = 'membership' AND subject_id = $2 AND title = 'A team member turned off alert texts'", [w.tenantId, agent.userId])).rows[0]!.n).toBeGreaterThan(0);
    // the next alert is blocked by the gate (recipient user) and never reaches the provider
    const before = h.providers.telephony.sms.filter((s) => s.to === phone).length;
    const r2 = await dispatchAgentAlertSms(await delivery(agent.userId!), w.deps, w.tenantId);
    expect(r2.kind).toBe('suppressed');
    expect((r2 as { reasons: string[] }).reasons).toContain('CONSENT_REVOKED');
    expect(h.providers.telephony.sms.filter((s) => s.to === phone).length).toBe(before);
    // the agent's own START from that phone restores alert texts
    await inboundSms(h, phone, w.mainNumber, 'START');
    expect((await dispatchAgentAlertSms(await delivery(agent.userId!), w.deps, w.tenantId)).kind).toBe('sent');
  });
});

describe('R-TWL-9 unverified senders (30032 toll-free, 30034 unregistered 10DLC)', () => {
  const regStatus = async () => (await h.su.query('SELECT status, status_detail FROM sender_registrations WHERE id = $1', [w.registrationId])).rows[0]!;
  const numberFlag = async () => (await h.su.query('SELECT sender_not_verified_detail AS detail FROM phone_numbers WHERE id = $1', [w.mainNumberId])).rows[0]!.detail as string | null;
  const restore = async () => {
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/sender-registrations/${w.registrationId}/refresh`)).status).toBe(200);
    expect((await regStatus()).status).toBe('approved');
    expect(await numberFlag()).toBeNull();
  };
  const notices = async () => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE tenant_id = $1 AND subject_type = 'phone_number' AND subject_id = $2 AND dedupe_key LIKE 'sender_not_verified:%'", [w.tenantId, w.mainNumberId])).rows[0]!.n);

  it('R-TWL-9: the codes are 30032 and 30034 (VERIFY); the agent copy is the brief\'s sentence', () => {
    expect([...SENDER_NOT_VERIFIED_CODES].sort()).toEqual(['30032', '30034']);
    expect(SENDER_NOT_VERIFIED_SENTENCE).toBe("Not delivered: the team's number isn't verified for texting. The Owner has been told.");
  });

  it('R-TWL-9 b9 comms sends/F1: 30034 on the submit fails the text SENDER_NOT_VERIFIED (no opt-out, no reconcile), marks the NUMBER not ready in TX2 (the registration stays approved), blocks the next text, keeps calls, notifies Owner/Admin once; "Check registration status" restores it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    h.providers.telephony.failNext({ kind: 'rejected', code: '30034' });
    const r = await sendText(agent, c.id, 'Hi Jane, quick question');
    expect(r.body.result).toBe('failed');
    expect(await messageRow(h, r.body.message!.id)).toMatchObject({ status: 'failed', status_reason: SENDER_NOT_VERIFIED });
    expect(await revokes(c.id)).toBe(0);
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'comms.reconcile' AND payload->>'messageId' = $1", [r.body.message!.id])).rows[0]!.n).toBe(0);
    expect((await regStatus()).status).toBe('approved');
    expect(await numberFlag()).toMatch(/^SENDER_NOT_VERIFIED: provider error 30034 on a local number ending \d{4}$/);
    expect(await notices()).toBe(1);
    // the existing sender check now blocks texts from the number; calls keep working (voice refuses only 'blocked')
    const next = await sendText(agent, c.id, 'Second text');
    expect(next.body.result).toBe('blocked');
    expect(next.body.decision!.reasons).toContain('SENDER_NOT_REGISTERED');
    await alertPhone(agent);
    expect((await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {})).body.result).toBe('dialing');
    await restore();
    expect((await sendText(agent, c.id, 'Third text')).body.result).toBe('sent');
  });

  it('R-TWL-9 E385 b9 comms sends/F1: 30032 from status callbacks, several the same day: each text SENDER_NOT_VERIFIED, the number marked once, one notice per number per day', async () => {
    const agent = w.agents[0]!;
    const before = await notices();
    const regAudits = async () => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'phone_number' AND entity_id = $2 AND reason LIKE 'SENDER_NOT_VERIFIED%'", [w.tenantId, w.mainNumberId])).rows[0]!.n);
    const auditsBefore = await regAudits();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await ownedContact(agent);
      const sent = await sendText(agent, c.id, `Status text ${i}`);
      expect(sent.body.result).toBe('sent');
      ids.push(sent.body.message!.id);
    }
    for (const id of ids) {
      const ref = (await messageRow(h, id)).provider_message_ref!;
      expect((await telephonyWebhook(h, `/webhooks/telephony/status?m=${id}`, { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '30032', From: w.mainNumber })).statusCode).toBe(200);
      expect(await messageRow(h, id)).toMatchObject({ status: 'undelivered', status_reason: SENDER_NOT_VERIFIED });
    }
    expect((await regStatus()).status).toBe('approved');
    expect(await numberFlag()).toMatch(/30032/);
    expect(await notices()).toBe(before); // the day's notice for this number already went (previous test, same day)
    expect((await regAudits()) - auditsBefore).toBe(1); // the number is marked once, by the first event
    await restore();
  });
});
