// Adversarial verification of api/comms (BUILD_PLAN module 12). Each test pins a defect found by
// attacking the module against its rules; all run on real Postgres (createApiHarness → createTestDb)
// through the real routes and fakes.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ProviderError } from '../providers/types.js';
import { withTenantTx } from '@realty/db';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { dispatchOutbound } from './dispatch.js';
import { type CommsWorld, approvedDraft, call, commsWorld, playbookFixture, decisionsFor, freshReauth, grantConsent, inboundSms, messageRow, ownedContact as ownedTextContact, randomPhone, runJobs, sendText, sid, telephonyWebhook } from './testing.js';
import type { CommsDeps } from './types.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, others: ['tc'] });
  for (const a of w.agents) await alertPhone(a);
});
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);

/** An IANA zone whose local hour right now is in [from, to). */
function zoneWithLocalHour(from: number, to: number): string | null {
  const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/Moscow', 'Europe/Berlin', 'Europe/London', 'Atlantic/Azores', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Pacific/Pago_Pago'];
  for (const z of zones) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour >= from && hour < to) return z;
  }
  return null;
}

describe('idempotency of a human send (CONVENTIONS §9: one tap = one command)', () => {
  it('two concurrent POSTs with the same idempotency key create one message and one provider send; both get the message', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const key = `k-${randomUUID()}`;
    const [a, b] = await Promise.all([sendText(agent, c.id, 'Same tap twice', { idempotencyKey: key }), sendText(agent, c.id, 'Same tap twice', { idempotencyKey: key })]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    expect(a.body.message!.id).toBe(b.body.message!.id);
    const rows = await h.su.query("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [c.id]);
    expect(rows.rows).toHaveLength(1);
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('E27 R-AST-6: replaying the original compose request (same idempotency key) after the client replied does not re-tap; only an explicit Send does', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const key = `k-${randomUUID()}`;
    const scheduleAt = new Date(Date.now() + 3600_000).toISOString();
    const r = await sendText(agent, c.id, 'Following up on the open house', { idempotencyKey: key, scheduleAt });
    expect(r.body.result).toBe('scheduled');
    expect((await inboundSms(h, c.phone, w.mainNumber, 'We bought a different house, please hold off')).statusCode).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, r.body.message!.id)).status_reason).toBe('CLIENT_REPLIED_SINCE_SCHEDULED');
    // a network retry of the ORIGINAL request (the app reuses the same key) is the same command: no new effect
    const replay = await sendText(agent, c.id, 'Following up on the open house', { idempotencyKey: key, scheduleAt });
    expect(replay.status).toBe(200);
    expect(replay.body.result).toBe('noop');
    expect(smsTo(c.phone)).toHaveLength(0);
    expect((await messageRow(h, r.body.message!.id)).status).toBe('queued');
  });
});

describe('owner decision: a weak or night-time timezone never blocks a human text', () => {
  it('a text that is night for the recipient (area-code zone) is sent; the only thing that blocks it is an opt-out', async () => {
    const night = zoneWithLocalHour(1, 6) ?? 'Pacific/Kiritimati';
    const agent = w.agents[1]!;
    const c = await ownedTextContact(agent, { consent: false });
    await h.su.query("UPDATE contacts SET timezone = $2, timezone_source = 'area_code' WHERE id = $1", [c.id, night]);
    const r = await sendText(agent, c.id, 'Quick question about Saturday');
    expect(r.body.result).toBe('sent');
    expect(r.body.decision!.reasons).toEqual([]);
    expect(smsTo(c.phone)).toHaveLength(1);
  });
});

describe('inbound calls: honest missed-call items', () => {
  const voice = (callSid: string, from: string, status: string) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: w.mainNumber, CallStatus: status, Direction: 'inbound' });
  const missedItems = async (contactId: string) => (await h.su.query("SELECT id FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'missed_call'", [contactId])).rows;
  const missedNotes = async (userId: string, callId: string) => (await h.su.query("SELECT id FROM notifications WHERE user_id = $1 AND kind = 'missed_call' AND subject_id = $2", [userId, callId])).rows;

  it('a ringing call that is then answered is never shown as a missed call', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const ref = sid('CA');
    expect((await voice(ref, c.phone, 'ringing')).statusCode).toBe(200);
    expect((await voice(ref, c.phone, 'in-progress')).statusCode).toBe(200);
    expect((await voice(ref, c.phone, 'completed')).statusCode).toBe(200);
    const callId = (await h.su.query<{ id: string }>('SELECT id FROM calls WHERE provider_call_ref = $1', [ref])).rows[0]!.id;
    expect(await missedItems(c.id)).toHaveLength(0);
    expect(await missedNotes(agent.userId!, callId)).toHaveLength(0);
  });

  it('a ringing call that ends unanswered lands in the feed once, with one notification', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const ref = sid('CA');
    expect((await voice(ref, c.phone, 'ringing')).statusCode).toBe(200);
    expect((await voice(ref, c.phone, 'no-answer')).statusCode).toBe(200);
    expect((await voice(ref, c.phone, 'no-answer')).statusCode).toBe(200); // provider retry
    const callId = (await h.su.query<{ id: string; status: string }>('SELECT id, status FROM calls WHERE provider_call_ref = $1', [ref])).rows[0]!;
    expect(callId.status).toBe('no_answer');
    expect(await missedItems(c.id)).toHaveLength(1);
    expect(await missedNotes(agent.userId!, callId.id)).toHaveLength(1);
  });

  it('a malformed CallDuration from the provider does not lose the status update', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const ref = sid('CA');
    expect((await voice(ref, c.phone, 'ringing')).statusCode).toBe(200);
    const r = await telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: ref, From: c.phone, To: w.mainNumber, CallStatus: 'in-progress', Direction: 'inbound', CallDuration: 'abc' });
    expect(r.statusCode).toBe(200);
    expect((await h.su.query('SELECT status FROM calls WHERE provider_call_ref = $1', [ref])).rows[0]!.status).toBe('in_progress');
  });
});

describe('E14 call outcome handover is one command', () => {
  it('R-PERM-7 E14: repeating the old agent\'s outcome after a reassignment creates one "log outcome" task, not one per tap', async () => {
    const [a, b] = w.agents as [TestClient, TestClient];
    const c = await ownedTextContact(a);
    await grantConsent(a, c.id, 'voice');
    const r = await call<{ callId: string; result: string }>(a, 'POST', `/contacts/${c.id}/calls`, {});
    expect(r.body.result, JSON.stringify(r.body)).toBe('dialing');
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reassign`, { commandId: randomUUID(), toUserId: b.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const out = await call<{ recordedAs: string }>(a, 'POST', `/calls/${r.body.callId}/outcome`, { outcome: 'callback_requested' });
      expect(out.status).toBe(200);
      expect(out.body.recordedAs).toBe('task_for_current_owner');
    }
    const t = (await h.su.query('SELECT assignee_user_id FROM tasks WHERE contact_id = $1', [c.id])).rows;
    expect(t).toEqual([{ assignee_user_id: b.userId }]);
  });
});

describe('a provider-reported opt-out is an audited opt-out received (R-AUDIT-5, R-CONSENT-12)', () => {
  const audits = async (messageId: string) => (await h.su.query("SELECT action, reason FROM audit_log WHERE tenant_id = $1 AND action = 'consent.opt_out_received' AND entity_id = $2", [w.tenantId, messageId])).rows;

  it('R-CONSENT-12 R-AUDIT-5: a carrier opt-out status callback revokes and writes consent.opt_out_received in the same transaction', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    const r = await sendText(agent, c.id, 'Status opt-out test');
    const id = r.body.message!.id;
    const ref = (await messageRow(h, id)).provider_message_ref!;
    expect((await telephonyWebhook(h, `/webhooks/telephony/status?m=${id}`, { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '21610', From: w.mainNumber, To: c.phone })).statusCode).toBe(200);
    expect(await audits(id)).toEqual([{ action: 'consent.opt_out_received', reason: 'PROVIDER_REPORT' }]);
  });

  it('R-CONSENT-12 R-AUDIT-5: a provider "recipient opted out" send error revokes, is never retried, and is audited', async () => {
    const agent = w.agents[1]!;
    const c = await ownedTextContact(agent);
    const fake = h.providers.telephony;
    const telephony = Object.create(fake) as typeof fake;
    // eslint-disable-next-line realty/no-provider-outbound -- test stub: the fake rejects with a carrier opt-out code; nothing is sent
    telephony.sendSms = async () => {
      throw new ProviderError('rejected', '21610');
    };
    const deps: CommsDeps = { ...w.deps, providers: { ...w.deps.providers, telephony } };
    const key = `k-${randomUUID()}`;
    const queued = await sendText(agent, c.id, 'Send-time opt-out test', { idempotencyKey: key, scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const id = queued.body.message!.id;
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [id]);
    const out = await dispatchOutbound(id, deps, { tenantId: w.tenantId });
    expect(out.kind).toBe('failed');
    expect((await messageRow(h, id)).status_reason).toBe('PROVIDER_OPTED_OUT');
    expect(await audits(id)).toEqual([{ action: 'consent.opt_out_received', reason: 'PROVIDER_REPORT' }]);
  });
});

describe('nothing can be confirmed past the gate (owner decision: needs_confirmation is gone)', () => {
  it('a preview says plainly why a text will not go, is not stored, and the call route takes no confirmDecisionId', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const before = (await decisionsFor(h, { contactId: c.id })).length;
    const preview = await call<{ decision: { id: string | null; outcome: string; reasons: string[]; explanation: string; phase: string } }>(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'Sure, calling now' });
    expect(preview.body.decision).toMatchObject({ id: null, outcome: 'deny', phase: 'preview' });
    expect(preview.body.decision.reasons).toContain('CONSENT_REVOKED');
    expect(preview.body.decision.explanation).toMatch(/Opted out of texts/);
    expect((await decisionsFor(h, { contactId: c.id })).length).toBe(before); // previews are never stored
    const crossed = await call(agent, 'POST', `/contacts/${c.id}/calls`, { confirmDecisionId: randomUUID() });
    expect(crossed.status).toBe(422);
    expect((await call(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'email', body: 'Following up' })).body).toMatchObject({ decision: { outcome: 'allow', id: null } });
  });
});

describe('resuming automation is a sender\'s decision (R-AST-9, R-PERM-1)', () => {
  it('R-PERM-1: a TC on the deal (informational texts only) cannot resume the agent\'s paused nurture; the owner can (audited)', async () => {
    const agent = w.agents[0]!;
    const tc = w.others[0]!;
    const c = await ownedTextContact(agent);
    const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step, body: 'Reminder: your showing is tomorrow at 10.', category: 'reminder', purpose: 'informational' });
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Thanks, I will get back to you')).statusCode).toBe(200);
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [pb.enrollmentId])).rows[0]!.state).toBe('paused');
    const dealId = randomUUID();
    await h.su.query("INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id) VALUES ($1,$2,'Deal','buy','active',now(),$3,$4)", [w.tenantId, dealId, c.id, agent.userId]);
    await h.su.query("INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES ($1,$2,$3,'tc')", [w.tenantId, dealId, tc.userId]);
    // the TC sees the contact and may text it informationally …
    expect((await call(tc, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'Inspection is Tuesday at 10' })).status).toBe(200);
    // … but resuming the agent's automation is not theirs to do
    expect((await call(tc, 'POST', `/contacts/${c.id}/automation/resume`, {})).code).toBe('PURPOSE_NOT_PERMITTED');
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [pb.enrollmentId])).rows[0]!.state).toBe('paused');
    const ok = await call<{ resumedEnrollments: number }>(agent, 'POST', `/contacts/${c.id}/automation/resume`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.resumedEnrollments).toBe(1);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'automation.resumed' AND entity_id = $1", [c.id])).rows[0]!.n).toBe(1);
  });
});

describe('a human message is classified at SEND time', () => {
  it('a scheduled text that was informational when written but is marketing by send time is gated as marketing: a marketing-only opt-out blocks it (and no DNC scrub is read any more)', async () => {
    const agent = w.agents[1]!;
    const c = await ownedTextContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Thanks for the info')).statusCode).toBe(200);
    await h.su.query("UPDATE conversations SET last_inbound_at = now() - interval '29 days' WHERE contact_id = $1", [c.id]);
    await h.su.query("UPDATE contacts SET last_inbound_at = now() - interval '29 days' WHERE id = $1", [c.id]);
    const hmac = (await h.su.query<{ x: Buffer }>("SELECT address_hmac AS x FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.x;
    // a DNC registry listing no longer matters (owner decision); the marketing-only opt-out does
    await h.su.query("INSERT INTO dnc_checks (tenant_id, id, phone_hmac, registry, listed, checked_at, valid_until, provider) VALUES ($1,$2,$3,'us_national',true,now(),now() + interval '31 days','fake')", [w.tenantId, randomUUID(), hmac]);
    const r = await sendText(agent, c.id, 'Want to see the new listing on Elm?', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(r.body.result).toBe('scheduled');
    expect((await h.su.query('SELECT purpose FROM messages WHERE id = $1', [r.body.message!.id])).rows[0]!.purpose).toBe('informational');
    // the person asked for no marketing texts (fixture: the projection row only, so the scheduled text is
    // not canceled by the revoke path and the SEND-time check is what is exercised)
    await (await import('../leads/testing.js')).suFixture(h, [{ text: "UPDATE consent_state SET status = 'revoked', consent_level = 'none', basis_event_id = NULL WHERE tenant_id = $1 AND address_hmac = $2 AND channel = 'sms' AND purpose = 'marketing'", values: [w.tenantId, hmac] }]);
    expect((await messageRow(h, r.body.message!.id)).status).toBe('scheduled');
    // two days later the last reply is 31 days old: a free-form text is marketing now
    await h.su.query("UPDATE conversations SET last_inbound_at = now() - interval '31 days' WHERE contact_id = $1", [c.id]);
    await h.su.query("UPDATE contacts SET last_inbound_at = now() - interval '31 days' WHERE id = $1", [c.id]);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const ds = await decisionsFor(h, { messageId: r.body.message!.id });
    expect(ds.at(-1)!.outcome).toBe('deny');
    expect(ds.at(-1)!.reason_codes).toContain('CONSENT_REVOKED');
    expect(ds.at(-1)!.reason_codes).not.toContain('DNC_LISTED');
    expect((await h.su.query('SELECT purpose FROM gate_decisions WHERE id = $1', [ds.at(-1)!.id])).rows[0]!.purpose).toBe('marketing');
    expect((await messageRow(h, r.body.message!.id)).status).toBe('blocked');
    expect(smsTo(c.phone)).toHaveLength(0);
  });
});

describe('an approved draft goes out with the approver as the sender, with no confirmation step (ARCHITECTURE §9 path 4)', () => {
  it('an approved draft to an address with no consent on file is sent at once; nobody can "confirm" it through Send', async () => {
    const agent = w.agents[0]!;
    const c = await ownedTextContact(agent, { consent: false });
    const draft = await approvedDraft(h, w.tenantId, c.id, agent, 'novel_message');
    const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'Your inspection is booked for Tuesday at 10.', initiator: 'assistant', purpose: 'informational', category: 'novel_message', assistantActionId: draft, idempotencyKey: `d:${randomUUID()}` }, now), { db: h.database });
    if (!q.ok) throw new Error(q.code);
    expect((await call(agent, 'POST', `/messages/${q.messageId}/send`, { confirmDecisionId: randomUUID() })).status).toBe(422);
    expect((await call(agent, 'POST', `/messages/${q.messageId}/send`, {})).status).toBe(404); // not the agent's own human message
    const first = await dispatchOutbound(q.messageId, w.deps, { tenantId: w.tenantId });
    expect(first.kind).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(1);
    expect(await decisionsFor(h, { messageId: q.messageId })).toHaveLength(0);
  });
});
