// Every automated outbound path of ARCHITECTURE §9 goes through dispatchOutbound and its send-time gate:
// each test asserts the outcome, that a blocked send writes its gate_decisions row (0013: only blocked
// sends are logged) and that a denial never reaches the provider fake (R-GATE-10).
import { randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { dispatchAgentAlertSms, dispatchOutbound } from './dispatch.js';
import { type CommsWorld, approvedDraft, call, commsWorld, decisionsFor, freshReauth, messageRow, ownedContact, playbookFixture, randomPhone, runJobs, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let brokerage: string;
let team: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
  brokerage = s.b;
  team = s.t ?? s.b;
});
afterAll(async () => {
  await h?.close();
});

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);

function step(o: { key: string; category: string; intent: string; purpose: 'marketing' | 'informational'; template: string }) {
  return { stepKey: o.key, channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: o.purpose, category: o.category, intent: o.intent, template: o.template, personalization: 'none', slots: [], maxLength: 640, stopIf: [] };
}

/** The body exactly as core renders it for this step (sign-off, first-message brokerage + STOP line). */
function rendered(s: ReturnType<typeof step>, scope: 'team' | 'agent', agentFirstName: string | null): string {
  const r = renderStep(s as never, {}, { signOff: signOffFor({ scope, agentFirstName, teamName: team }), brokerageName: brokerage, firstInThread: true });
  if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r)}`);
  return (r as { text: string }).text;
}

async function queue(contactId: string, spec: Partial<Parameters<typeof queueOutboundInTx>[2]> & { body: string; category: string; purpose: 'marketing' | 'informational'; initiator: 'assistant' | 'system' }): Promise<string> {
  const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', idempotencyKey: `t:${randomUUID()}`, ...spec } as never, now), { db: h.database });
  if (!r.ok) throw new Error(r.code);
  return r.messageId;
}

describe('playbook steps and the 60-second first response (paths 5, 6)', () => {
  it('R-GATE-10 R-GATE-4 R-AST-16: a within-playbook first response on an approved team playbook is gated at send time and sent (no consent level needed)', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const mid = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, firstResponse: true });
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, mid);
    expect(m.status).toBe('sent');
    expect(await decisionsFor(h, { messageId: mid })).toHaveLength(0);
    expect(smsTo(c.phone)).toHaveLength(1);
    expect((await h.su.query('SELECT status, message_id FROM playbook_step_runs WHERE id = $1', [pb.stepRunId])).rows[0]).toEqual({ status: 'sent', message_id: mid });
  });

  it('R-GATE-10 R-CONSENT-7: the assistant never texts a number that texted STOP (approved playbook or not): denied at send time, logged, nothing reaches the provider', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    expect((await (await import('./testing.js')).inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const mid = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId });
    const r = await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    const d = (await decisionsFor(h, { messageId: mid }))[0]!;
    expect([d.outcome, d.phase, d.initiator]).toEqual(['deny', 'send', 'assistant']);
    expect(d.reason_codes).toContain('CONSENT_REVOKED');
    expect(smsTo(c.phone).filter((x) => !/stop|unsubscribed|opted out/i.test(x.body))).toHaveLength(0);
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [pb.stepRunId])).rows[0]!.status).not.toBe('sent');
  });

  it('R-GATE-4 R-AST-4: a revoked playbook approval or a paused conversation blocks the assistant message in the dispatch transaction', async () => {
    const c = await ownedContact(w.agents[0]!);
    const s = step({ key: 'checkin', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Checking in: anything new on your search?' });
    const body = rendered(s, 'team', null);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'nurture_step', purpose: 'marketing' });
    // the approval is revoked (fixture: the revoke row and the version transition, as api/assistant will write them)
    await suFixture(h, [
      { text: "INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at) SELECT tenant_id, $2, id, 'revoke', $3, 'owner', content_sha256, 'revoked', now() FROM playbook_versions WHERE id = $1", values: [pb.versionId, randomUUID(), w.owner.userId] },
      { text: "UPDATE playbook_versions SET status = 'revoked' WHERE id = $1", values: [pb.versionId] },
    ]);
    const mid = await queue(c.id, { body, category: 'nurture_step', purpose: 'marketing', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId });
    const r = await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid }))[0]!.reason_codes).toContain('PLAYBOOK_NOT_APPROVED');
    expect(smsTo(c.phone)).toHaveLength(0);

    // paused conversation (the client replied): AUTOMATION_PAUSED, never sent
    const c2 = await ownedContact(w.agents[0]!);
    const pb2 = await playbookFixture(h, w.tenantId, w.owner, c2.id, { scope: 'team', step: s, body, category: 'nurture_step', purpose: 'marketing' });
    const mid2 = await queue(c2.id, { body, category: 'nurture_step', purpose: 'marketing', initiator: 'assistant', assistantActionId: pb2.actionId, playbookStepRunId: pb2.stepRunId });
    await h.su.query("UPDATE conversations SET automation_paused_at = now(), automation_pause_reason = 'client_reply' WHERE contact_id = $1", [c2.id]);
    expect((await dispatchOutbound(mid2, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid2 }))[0]!.reason_codes).toContain('AUTOMATION_PAUSED');
    expect(smsTo(c2.phone)).toHaveLength(0);
  });

  it('R-GATE-4: a scheduled agent-playbook step is blocked when the playbook owner no longer owns the contact', async () => {
    const [a, b] = w.agents as [NonNullable<typeof w.agents[0]>, NonNullable<typeof w.agents[0]>];
    const c = await ownedContact(a);
    const s = step({ key: 'checkin', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Checking in: anything new on your search?' });
    const first = (await h.su.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [a.userId])).rows[0]!.display_name.split(/\s+/)[0]!;
    const body = rendered(s, 'agent', first);
    const pb = await playbookFixture(h, w.tenantId, a, c.id, { scope: 'agent', ownerUserId: a.userId!, step: s, body, category: 'nurture_step', purpose: 'marketing' });
    const mid = await queue(c.id, { body, category: 'nurture_step', purpose: 'marketing', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, scheduleAt: (Date.now() + 3600_000) as never });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reassign`, { commandId: randomUUID(), toUserId: b.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [mid]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, mid);
    expect(m.status).toBe('blocked');
    expect(m.dispatched_at).toBeNull();
    expect((await decisionsFor(h, { messageId: mid }))[0]!.reason_codes).toContain('PLAYBOOK_OWNER_NOT_CONTACT_OWNER');
    expect(smsTo(c.phone)).toHaveLength(0);
  });

  it('R-GATE-8: TX1 stamps dispatched_at when it commits dispatching (DB CHECK)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const before = Date.now();
    const r = await sendText(w.agents[0]!, c.id, 'Stamp check');
    const m = await messageRow(h, r.body.message!.id);
    expect(m.dispatched_at!.getTime()).toBeGreaterThanOrEqual(before - 5000);
    // the CHECK: no dispatched_at ⇒ cannot be dispatching
    await expect(h.su.query("UPDATE messages SET status = 'dispatching', dispatched_at = NULL WHERE id = $1", [r.body.message!.id])).rejects.toThrow(/check/i);
  });

  it('0013: the DB dispatch guard refuses a direct dispatch to an opted-out number even bypassing dispatchOutbound (no gate decision is needed otherwise)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const later = await sendText(w.agents[0]!, c.id, 'Later', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const ok = await sendText(w.agents[0]!, c.id, 'Later too', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    await expect(
      withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${ok.body.message!.id}`.execute(tx), { db: h.database }),
    ).resolves.toBeTruthy();
    // the opt-out lands as a consent_state revoke without touching the queued message (a fixture: the
    // application path would also cancel it)
    await suFixture(h, [{ text: "UPDATE messages SET status = 'scheduled' WHERE id = $1", values: [later.body.message!.id] }]);
    const pid = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.id;
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: {} })).status).toBe(200);
    await suFixture(h, [{ text: "UPDATE messages SET status = 'scheduled', status_reason = NULL WHERE id = $1", values: [later.body.message!.id] }]);
    await expect(
      withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${later.body.message!.id}`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });
});

describe('approved drafts (path 4)', () => {
  it('R-GATE-10 R-GATE-4: an approved draft is sent with the approving human as the sender; an unapproved one never dispatches', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const ok = await approvedDraft(h, w.tenantId, c.id, agent);
    const mid = await queue(c.id, { body: 'About the offer: the sellers countered at list. Want to talk tonight?', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: ok });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    expect(await decisionsFor(h, { messageId: mid })).toHaveLength(0);
    expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [ok])).rows[0]!.status).toBe('executed');

    const pending = randomUUID();
    await h.su.query("INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload) VALUES ($1,$2,$3,'message_draft','novel_message','requires_approval','proposed',$4,'Draft','{}')", [w.tenantId, pending, c.id, agent.userId]);
    const mid2 = await queue(c.id, { body: 'Unapproved draft', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: pending });
    expect((await dispatchOutbound(mid2, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid2 }))[0]!.reason_codes).toContain('ASSISTANT_ACTION_NOT_APPROVED');
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('R-GATE-4: an approved draft to a number that opted out is blocked; the approving human\'s tap is not an override', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const pid = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.id;
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: {} })).status).toBe(200);
    const ok = await approvedDraft(h, w.tenantId, c.id, agent);
    const mid = await queue(c.id, { body: 'Quick question about Saturday', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: ok });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    const d = (await decisionsFor(h, { messageId: mid }))[0]!;
    expect([d.initiator, d.outcome]).toEqual(['human', 'deny']);
    expect(d.reason_codes).toContain('CONSENT_REVOKED');
    expect((await h.su.query('SELECT actor_user_id FROM gate_decisions WHERE id = $1', [d.id])).rows[0]!.actor_user_id).toBe(agent.userId);
    expect(smsTo(c.phone)).toHaveLength(0);
  });
});

describe('saved-search alerts (path 7)', () => {
  it('R-GATE-10: a search alert is automated marketing: sent with no consent level, blocked for an unsubscribed (STOP) number', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const body = `New match for your search. ${brokerage}. Reply STOP to opt out — the ${team} assistant`;
    const mid = await queue(c.id, { body, category: 'search_alert', purpose: 'marketing', initiator: 'system' });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    const pid = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.id;
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'marketing', evidence: {} })).status).toBe(200);
    const mid2 = await queue(c.id, { body, category: 'search_alert', purpose: 'marketing', initiator: 'system' });
    expect((await dispatchOutbound(mid2, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid2 }))[0]!.reason_codes).toContain('CONSENT_REVOKED');
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('R-GATE-12: a marketing alert without the brokerage name is blocked even with no opt-out', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const mid = await queue(c.id, { body: `New match for your search. Reply STOP to opt out — the assistant`, category: 'search_alert', purpose: 'marketing', initiator: 'system' });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid }))[0]!.reason_codes).toContain('BROKERAGE_IDENTITY_MISSING');
  });
});

describe('owner decision: no caps, no quiet hours, nothing deferred', () => {
  it('two automated texts to the same contact within minutes both go (no frequency cap); a night-time automated text goes now (no quiet hours)', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    await h.su.query("UPDATE contacts SET timezone = 'Pacific/Kiritimati', timezone_source = 'explicit' WHERE id = $1", [c.id]);
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb1 = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, extraSteps: [{ ...s, stepKey: 'second' }], body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const m1 = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb1.actionId, playbookStepRunId: pb1.stepRunId });
    expect((await dispatchOutbound(m1, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    const run2 = randomUUID();
    await h.su.query("INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for) VALUES ($1,$2,$3,$4,'second','scheduled',now())", [w.tenantId, run2, pb1.enrollmentId, pb1.versionId]);
    const m2 = await queue(c.id, { body: body.replace(`${brokerage}`, '').replace(/Reply STOP to opt out\.?/, '').trim() || body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb1.actionId, playbookStepRunId: run2 });
    expect((await dispatchOutbound(m2, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(2);
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [run2])).rows[0]!.status).toBe('sent');
    expect((await sendText(w.agents[0]!, c.id, 'Late question')).body.result).toBe('sent');
  });
});

describe('sender registration (R-CONSENT-17, E46)', () => {
  it('E46 R-CONSENT-17: a suspended 10DLC campaign blocks SMS (SENDER_NOT_REGISTERED), with no fallback number; Admins are alerted', async () => {
    const h2 = h;
    const c = await ownedContact(w.agents[1]!);
    const ref = (await h2.su.query<{ r: string }>('SELECT provider_campaign_ref AS r FROM sender_registrations WHERE id = $1', [w.registrationId])).rows[0]!.r;
    h2.providers.telephony.registrations.set(ref, 'suspended');
    expect((await call(w.owner, 'POST', `/sender-registrations/${w.registrationId}/refresh`)).status).toBe(200);
    const r = await sendText(w.agents[1]!, c.id, 'Are you around?');
    expect(r.body.decision!.reasons).toContain('SENDER_NOT_REGISTERED');
    expect(smsTo(c.phone)).toHaveLength(0);
    const notes = await h2.su.query("SELECT title FROM notifications WHERE tenant_id = $1 AND subject_id = $2", [w.tenantId, w.registrationId]);
    expect(notes.rows.length).toBeGreaterThan(0);
    h2.providers.telephony.registrations.set(ref, 'approved');
    await call(w.owner, 'POST', `/sender-registrations/${w.registrationId}/refresh`);
  });
});

describe('agent alert SMS (path 9)', () => {
  it('R-GATE-10: an agent alert text is gated with recipient = user; allowed ⇒ sent (no decision row), an opted-out agent ⇒ suppressed, logged and never sent', async () => {
    const agent = w.agents[1]!;
    const phone = randomPhone();
    const ch = await agent.post('/api/me/alert-phone', { phone });
    const sent = h.providers.telephony.verificationCodes.at(-1)!;
    expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code: sent.code })).statusCode).toBe(200);
    const mk = async () => {
      const n = randomUUID();
      const d = randomUUID();
      await h.su.query("INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, dedupe_key) VALUES ($1,$2,$3,'lead_offer','critical','New lead offer',$4)", [w.tenantId, n, agent.userId, `t:${n}`]);
      await h.su.query("INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'sms','alert_phone','pending',now())", [w.tenantId, d, n]);
      return d;
    };
    const d1 = await mk();
    const r1 = await dispatchAgentAlertSms(d1, w.deps, w.tenantId);
    expect(r1.kind).toBe('sent');
    const row = (await h.su.query('SELECT status, gate_decision_id FROM notification_deliveries WHERE id = $1', [d1])).rows[0]!;
    expect(row).toEqual({ status: 'sent', gate_decision_id: null });
    expect(smsTo(phone)).toHaveLength(1);
    expect(smsTo(phone)[0]!.body).not.toMatch(/\+1\d{10}/); // lock screens never show numbers
    // the agent texts STOP to the alert number: later alert texts are suppressed and logged
    expect((await (await import('./testing.js')).inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const d2 = await mk();
    const r2 = await dispatchAgentAlertSms(d2, w.deps, w.tenantId);
    expect(r2.kind).toBe('suppressed');
    const row2 = (await h.su.query('SELECT status, gate_decision_id FROM notification_deliveries WHERE id = $1', [d2])).rows[0]!;
    expect(row2.status).toBe('suppressed');
    const dec = (await h.su.query('SELECT recipient_kind, recipient_user_id, action_category, outcome, reason_codes FROM gate_decisions WHERE id = $1', [row2.gate_decision_id])).rows[0]!;
    expect(dec).toMatchObject({ recipient_kind: 'user', recipient_user_id: agent.userId, action_category: 'agent_alert', outcome: 'deny' });
    expect(dec.reason_codes).toContain('CONSENT_REVOKED');
    expect(smsTo(phone)).toHaveLength(1);
  });
});

describe('email (paths 1, R-CONSENT-18)', () => {
  it('R-CONSENT-18: marketing email needs a verified domain and the postal address; it then carries the footer, an unsubscribe link and one-click List-Unsubscribe headers', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const send = (key: string) => call<{ result: string; decision: { reasons: string[] } | null }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Homes you may like', body: 'Three new listings this week.', idempotencyKey: key });
    const r1 = await send(`e-${randomUUID()}`);
    expect(r1.body.decision!.reasons).toEqual(expect.arrayContaining(['EMAIL_DOMAIN_UNVERIFIED', 'POSTAL_ADDRESS_MISSING']));
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toHaveLength(0);
    // a verified domain + an identity for the agent + the brokerage postal address
    h.providers.email.verifiedDomains.add('mail.example.test');
    const dom = await call<{ domain: { id: string; verifiedAt: string | null } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.example.test' });
    const ver = await call<{ domain: { verifiedAt: string | null } }>(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
    expect(ver.body.domain.verifiedAt).not.toBeNull();
    expect((await call(w.owner, 'POST', '/email-identities', { fromAddress: `agent-${randomUUID().slice(0, 6)}@mail.example.test`, displayName: 'Agent A', userId: agent.userId, domainId: dom.body.domain.id })).status).toBe(201);
    await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
    const r2 = await send(`e-${randomUUID()}`);
    expect(r2.body.result).toBe('sent');
    const mail = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!;
    expect(mail.text).toContain(brokerage);
    expect(mail.text).toContain('1 Main St, Springfield');
    expect(mail.text).toMatch(/Unsubscribe: https:\/\/.+\/api\/email\/unsubscribe\//);
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.headers!['List-Unsubscribe']).toMatch(/^<https:\/\//);
    expect(mail.replyTo).toMatch(/^r\+[A-Za-z0-9_-]+@in\./);
  });
});
