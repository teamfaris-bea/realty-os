// Every automated outbound path of ARCHITECTURE §9 goes through dispatchOutbound and its send-time gate:
// each test asserts the decision row exists and that a denial never reaches the provider fake (R-GATE-10).
import { randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture, zoneWithLocalHour } from '../leads/testing.js';
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
  it('R-GATE-10 R-GATE-4 R-AST-16: a within-playbook first response on an approved team playbook is gated at send time and sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const mid = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, firstResponse: true });
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, mid);
    expect(m.status).toBe('sent');
    const ds = await decisionsFor(h, { messageId: mid });
    expect(ds.map((d) => `${d.initiator}:${d.outcome}`)).toEqual(['assistant:allow']);
    expect(smsTo(c.phone)).toHaveLength(1);
    expect((await h.su.query('SELECT status, message_id FROM playbook_step_runs WHERE id = $1', [pb.stepRunId])).rows[0]).toEqual({ status: 'sent', message_id: mid });
  });

  it('R-GATE-10 R-CONSENT-5: the assistant may not text without an express basis: denied at send time, nothing reaches the provider', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const mid = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId });
    const r = await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid }))[0]!.reason_codes).toContain('CONSENT_BASIS_INSUFFICIENT');
    expect(smsTo(c.phone)).toHaveLength(0);
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

  it('R-GATE-8: TX1 stamps dispatched_at when it commits dispatching (DB CHECK) and the send-time decision is fresh', async () => {
    const c = await ownedContact(w.agents[0]!);
    const r = await sendText(w.agents[0]!, c.id, 'Stamp check');
    const m = await messageRow(h, r.body.message!.id);
    const d = (await decisionsFor(h, { messageId: r.body.message!.id }))[0]!;
    const evaluated = (await h.su.query<{ t: Date }>('SELECT evaluated_at AS t FROM gate_decisions WHERE id = $1', [d.id])).rows[0]!.t;
    expect(m.dispatched_at!.getTime()).toBeGreaterThanOrEqual(evaluated.getTime());
    // the CHECK: no dispatched_at ⇒ cannot be dispatching
    await expect(h.su.query("UPDATE messages SET status = 'dispatching', dispatched_at = NULL WHERE id = $1", [r.body.message!.id])).rejects.toThrow(/check/i);
  });

  it('R-GATE-3: a send-time decision older than 10 minutes can never authorize a dispatch (DB guard GATE_DECISION_STALE)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const r = await sendText(w.agents[0]!, c.id, 'Later', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const d = await sendText(w.agents[0]!, c.id, 'Now');
    const allow = (await decisionsFor(h, { messageId: d.body.message!.id }))[0]!;
    const stale = randomUUID();
    await h.su.query(`INSERT INTO gate_decisions SELECT tenant_id, $2, contact_id, recipient_kind, recipient_user_id, address_hmac, channel, purpose, initiator, action_category, phase, outcome, reason_codes, defer_until, explanation, actor_user_id, confirmed_by_user_id, confirms_decision_id, policy_version_id, core_rules_version, inputs, inputs_sha256, $3, call_id, now() - interval '11 minutes' FROM gate_decisions WHERE id = $1`, [allow.id, stale, r.body.message!.id]);
    await expect(
      withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now(), gate_decision_id = ${stale} WHERE id = ${r.body.message!.id}`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/GATE_DECISION_STALE/);
  });
});

describe('approved drafts (path 4)', () => {
  it('R-GATE-10 R-GATE-4: an approved draft is sent with the approving human as the sender; an unapproved one never dispatches', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const ok = await approvedDraft(h, w.tenantId, c.id, agent);
    const mid = await queue(c.id, { body: 'About the offer: the sellers countered at list. Want to talk tonight?', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: ok });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    const d = (await decisionsFor(h, { messageId: mid }))[0]!;
    expect(d.initiator).toBe('human');
    expect((await h.su.query('SELECT actor_user_id FROM gate_decisions WHERE id = $1', [d.id])).rows[0]!.actor_user_id).toBe(agent.userId);
    expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [ok])).rows[0]!.status).toBe('executed');

    const pending = randomUUID();
    await h.su.query("INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload) VALUES ($1,$2,$3,'message_draft','novel_message','requires_approval','proposed',$4,'Draft','{}')", [w.tenantId, pending, c.id, agent.userId]);
    const mid2 = await queue(c.id, { body: 'Unapproved draft', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: pending });
    expect((await dispatchOutbound(mid2, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid2 }))[0]!.reason_codes).toContain('ASSISTANT_ACTION_NOT_APPROVED');
    expect(smsTo(c.phone)).toHaveLength(1);
  });
});

describe('saved-search alerts (path 7)', () => {
  it('R-GATE-10 R-CONSENT-5: a search alert is automated marketing: SMS needs express_written, so an express basis is denied and nothing is sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    const mid = await queue(c.id, { body: `New match for your search. ${brokerage}. Reply STOP to opt out — the ${team} assistant`, category: 'search_alert', purpose: 'marketing', initiator: 'system' });
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: mid }))[0]!.reason_codes).toContain('CONSENT_BASIS_INSUFFICIENT');
    expect(smsTo(c.phone)).toHaveLength(0);
  });
});

describe('frequency caps and quiet hours (R-CONSENT-13, R-CONSENT-14, E29, E30)', () => {
  it('R-CONSENT-14: automated sends past the cap defer (never drop); after the maximum deferrals the step is skipped_ineligible, visibly', async () => {
    const c = await ownedContact(w.agents[0]!);
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const pb1 = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, extraSteps: [{ ...s, stepKey: 'second' }], body, category: 'speed_to_lead_reply', purpose: 'informational' });
    const m1 = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb1.actionId, playbookStepRunId: pb1.stepRunId });
    expect((await dispatchOutbound(m1, w.deps, { tenantId: w.tenantId })).kind).toBe('sent');
    // a second automated text within 24 h (the next step run of the same enrollment)
    const run2 = randomUUID();
    await h.su.query("INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for) VALUES ($1,$2,$3,$4,'second','scheduled',now())", [w.tenantId, run2, pb1.enrollmentId, pb1.versionId]);
    const m2 = await queue(c.id, { body: body.replace(`${brokerage}`, '').replace(/Reply STOP to opt out\.?/, '').trim() || body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb1.actionId, playbookStepRunId: run2 });
    expect((await dispatchOutbound(m2, w.deps, { tenantId: w.tenantId })).kind).toBe('deferred');
    expect((await decisionsFor(h, { messageId: m2 }))[0]!.reason_codes).toContain('FREQUENCY_CAP');
    for (let i = 0; i < 4; i++) {
      await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1 AND status = 'scheduled'", [m2]);
      await dispatchOutbound(m2, w.deps, { tenantId: w.tenantId });
    }
    const m = await messageRow(h, m2);
    expect(m.status).toBe('canceled');
    expect(m.status_reason).toBe('SKIPPED_INELIGIBLE');
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [run2])).rows[0]!.status).toBe('skipped_ineligible');
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('R-CONSENT-13 E29 E30: an automated text outside 9–8 recipient-local defers to the next opening plus a deterministic 0–20 min jitter per message; a human one is denied', async () => {
    const night = zoneWithLocalHour(21, 24) ?? zoneWithLocalHour(0, 7);
    const c1 = await ownedContact(w.agents[0]!);
    const c2 = await ownedContact(w.agents[0]!);
    await h.su.query("UPDATE contacts SET timezone = $2, timezone_source = 'explicit' WHERE id = ANY ($1)", [[c1.id, c2.id], night]);
    const s = step({ key: 'first', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational', template: 'Thanks for reaching out! When are you hoping to move?' });
    const body = rendered(s, 'team', null);
    const out: number[] = [];
    for (const c of [c1, c2]) {
      const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: s, body, category: 'speed_to_lead_reply', purpose: 'informational' });
      const mid = await queue(c.id, { body, category: 'speed_to_lead_reply', purpose: 'informational', initiator: 'assistant', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId });
      const r = await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId });
      expect(r.kind).toBe('deferred');
      const d = (await decisionsFor(h, { messageId: mid }))[0]!;
      expect(d.reason_codes).toContain('QUIET_HOURS_DEFERRED');
      const until = d.defer_until!;
      const local = new Intl.DateTimeFormat('en-US', { timeZone: night, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(until);
      const hour = Number(local.find((p) => p.type === 'hour')!.value);
      const minute = Number(local.find((p) => p.type === 'minute')!.value);
      expect(hour).toBe(9);
      expect(minute).toBeLessThanOrEqual(20);
      expect((await messageRow(h, mid)).scheduled_for!.getTime()).toBe(until.getTime());
      // deterministic: re-evaluating the same message lands on the same instant
      await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [mid]);
      await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId });
      expect((await messageRow(h, mid)).scheduled_for!.getTime()).toBe(until.getTime());
      out.push(until.getTime());
      expect(smsTo(c.phone)).toHaveLength(0);
    }
    expect(out[0]).not.toBe(out[1]); // jitter spreads the 9:00 burst (E30)
    const human = await sendText(w.agents[0]!, c1.id, 'Late question');
    expect(human.body.decision!.reasons).toContain('OUTSIDE_CONTACT_WINDOW');
    expect(human.body.decision!.explanation).toMatch(/9 AM–8 PM/);
    expect(smsTo(c1.phone)).toHaveLength(0);
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
  it('R-GATE-10: an agent alert text is gated with recipient = user; allowed ⇒ sent with a decision row, an opted-out agent ⇒ suppressed and never sent', async () => {
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
    expect(row.status).toBe('sent');
    const dec = (await h.su.query('SELECT recipient_kind, recipient_user_id, action_category, outcome FROM gate_decisions WHERE id = $1', [row.gate_decision_id])).rows[0]!;
    expect(dec).toEqual({ recipient_kind: 'user', recipient_user_id: agent.userId, action_category: 'agent_alert', outcome: 'allow' });
    expect(smsTo(phone)).toHaveLength(1);
    expect(smsTo(phone)[0]!.body).not.toMatch(/\+1\d{10}/); // lock screens never show numbers
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
