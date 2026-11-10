// Inbound ingestion: opt-out keywords, opt-out language, wrong numbers and the atomic pause + handback
// (ARCHITECTURE §10; R-CONSENT-1/4/7/8/10/11/20, R-AST-9, R-TEN-8; E17, E21–E28, E55, E60, E61).
import { randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { dispatchAgentAlertSms } from './dispatch.js';
import { type CommsWorld, call, commsWorld, decisionsFor, emailWebhook, freshReauth, inboundSms, messageRow, ownedContact, playbookFixture, pointId, randomPhone, runJobs, sendText, sid, telephonyWebhook } from './testing.js';

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
const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };

function body(): string {
  const r = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: team }), brokerageName: brokerage, firstInThread: true });
  if (!r.ok) throw new Error('render');
  return r.text;
}

/** A live enrollment with one queued assistant message for the contact. */
async function nurture(contactId: string): Promise<{ messageId: string; enrollmentId: string; stepRunId: string }> {
  const pb = await playbookFixture(h, w.tenantId, w.owner, contactId, { scope: 'team', step, body: body(), category: 'reminder', purpose: 'informational' });
  const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', body: body(), initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
  if (!r.ok) throw new Error(r.code);
  return { messageId: r.messageId, enrollmentId: pb.enrollmentId, stepRunId: pb.stepRunId };
}

/** An upcoming appointment: the agent's free-form email is informational (R-CONSENT-5), so the shared domain may carry it. */
async function appointmentContext(contactId: string, userId: string): Promise<void> {
  await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), contactId, userId]);
}

async function consent(contactId: string, phoneHmacOf: string): Promise<{ status: string; purpose: string }[]> {
  void phoneHmacOf;
  return (await h.su.query("SELECT status, purpose FROM consent_state WHERE channel = 'sms' AND address_hmac = (SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'phone' ORDER BY created_at LIMIT 1) ORDER BY purpose", [contactId])).rows;
}

describe('STOP keywords (R-CONSENT-7)', () => {
  it('R-CONSENT-7 E25: "STOP STOP" revokes SMS for every purpose in the inbound transaction, cancels queued/scheduled SMS, pauses the enrollment and notifies the owner; the provider sends the confirmation by default', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const n = await nurture(c.id);
    const scheduled = await sendText(agent, c.id, 'Human scheduled', { scheduleAt: new Date(Date.now() + 7200_000).toISOString() });
    const r = await inboundSms(h, c.phone, w.mainNumber, 'STOP STOP');
    expect(r.statusCode).toBe(200);
    expect(await consent(c.id, '')).toEqual([{ status: 'revoked', purpose: 'informational' }, { status: 'revoked', purpose: 'marketing' }]);
    expect((await messageRow(h, n.messageId)).status).toBe('canceled');
    expect((await messageRow(h, scheduled.body.message!.id)).status).toBe('canceled');
    expect((await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]).toEqual({ state: 'paused', pause_reason: 'opt_out' });
    expect((await h.su.query("SELECT kind FROM notifications WHERE user_id = $1 AND kind = 'opt_out' AND subject_id = $2", [agent.userId, c.id])).rows).toHaveLength(1);
    expect((await h.su.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'consent.opt_out_received' AND reason = 'STOP'", [w.tenantId])).rows.length).toBeGreaterThan(0);
    expect(smsTo(c.phone)).toHaveLength(0); // default: the provider sends the confirmation (Q7)
    for (const text of ['stop.', 'Stop 🙏']) {
      const c2 = await ownedContact(agent);
      await inboundSms(h, c2.phone, w.mainNumber, text);
      expect((await consent(c2.id, '')).every((x) => x.status === 'revoked')).toBe(true);
    }
  });

  it('R-CONSENT-1 E21: spouses share one phone; one STOP blocks texting both contacts (address-keyed)', async () => {
    const phone = randomPhone();
    const a = await ownedContact(w.agents[0]!, { phone, firstName: 'Ann' });
    const b = await ownedContact(w.agents[1]!, { phone, firstName: 'Bob', confirmDistinct: true });
    await inboundSms(h, phone, w.mainNumber, 'STOP');
    const r = await sendText(w.agents[1]!, b.id, 'Hi Bob');
    expect(r.body.decision!.reasons).toContain('CONSENT_REVOKED');
    expect(smsTo(phone)).toHaveLength(0);
    void a;
  });

  it('R-CONSENT-20 E23: STOP to number A blocks texting from number B (tenant-wide); it never crosses tenants', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await freshReauth(h, w.owner);
    const direct = await call<{ number: { id: string } }>(w.owner, 'POST', '/numbers', { purpose: 'agent_direct', assignedUserId: agent.userId, registrationId: w.registrationId });
    expect(direct.status).toBe(201);
    await inboundSms(h, c.phone, w.mainNumber, 'STOP');
    const r = await sendText(agent, c.id, 'From my own number');
    expect(r.body.decision!.reasons).toContain('CONSENT_REVOKED');
    // tenant B: the same person, never opted out there
    const w2 = await commsWorld(h, { agents: 1 });
    const c2 = await ownedContact(w2.agents[0]!, { phone: c.phone });
    expect((await sendText(w2.agents[0]!, c2.id, 'Hello from another team')).body.result).toBe('sent');
  });

  it('R-CONSENT-10: START restores only the keyword revoke; staff can never reinstate an opt-out', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await inboundSms(h, c.phone, w.mainNumber, 'STOP');
    const pid = await pointId(h, c.id, 'phone');
    const staff = await call<{ explanation: string; state: { status: string }[] }>(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'record', pointId: pid, channel: 'sms', purpose: 'all', level: 'express', evidence: {} });
    expect(staff.status).toBe(200);
    expect(staff.body.state.every((s) => s.status === 'revoked')).toBe(true);
    expect(staff.body.explanation).toMatch(/Only the person can opt back in/);
    await inboundSms(h, c.phone, w.mainNumber, 'START');
    expect((await consent(c.id, '')).every((x) => x.status === 'granted')).toBe(true);
    expect((await sendText(agent, c.id, 'Welcome back')).body.result).toBe('sent');
  });

  it('R-GATE-10 path 8: with the platform as the confirmation sender, STOP gets exactly one consent-exempt confirmation and HELP one help reply, each with a decision row', async () => {
    const w3 = await commsWorld(h, { agents: 1 });
    const pol = await call(w3.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: 'platform', activate: true });
    expect(pol.status).toBe(201);
    const c = await ownedContact(w3.agents[0]!);
    await inboundSms(h, c.phone, w3.mainNumber, 'HELP');
    await runJobs(h, w3.tenantId, ['comms.dispatch']);
    const sid1 = sid();
    await inboundSms(h, c.phone, w3.mainNumber, 'STOP', sid1);
    await inboundSms(h, c.phone, w3.mainNumber, 'STOP', sid1); // provider redelivery: idempotent
    await runJobs(h, w3.tenantId, ['comms.dispatch']);
    const replies = (await h.su.query<{ id: string; action_category: string; status: string }>("SELECT id, action_category, status FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at", [c.id])).rows;
    expect(replies.map((m) => `${m.action_category}:${m.status}`)).toEqual(['help_reply:sent', 'opt_out_confirmation:sent']);
    for (const m of replies) expect((await decisionsFor(h, { messageId: m.id }))[0]!.outcome).toBe('allow');
    expect(smsTo(c.phone)).toHaveLength(2);
    expect(smsTo(c.phone)[1]!.body).toContain('unsubscribed');
  });
});

describe('opt-out language and wrong numbers (R-CONSENT-8, R-CONSENT-11, E24)', () => {
  it('E24: "Stop by at 5?" and "Don\'t stop sending listings!" are not opt-outs', async () => {
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'Stop by at 5?');
    await inboundSms(h, c.phone, w.mainNumber, "Don't stop sending listings!");
    expect((await consent(c.id, '')).every((x) => x.status === 'granted')).toBe(true);
  });

  it('R-CONSENT-8: opt-out language revokes at once with needs_review; the agent can mark "not an opt-out" (audited), restoring the prior level', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await inboundSms(h, c.phone, w.mainNumber, 'please stop texting me');
    expect((await consent(c.id, '')).every((x) => x.status === 'revoked')).toBe(true);
    const ev = (await h.su.query<{ id: string; needs_review: boolean; source: string }>("SELECT id, needs_review, source FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).rows;
    expect(ev.map((e) => [e.source, e.needs_review])).toEqual([['inbound_language', true]]);
    const r = await call<{ restored: { status: string; level: string }[] }>(agent, 'POST', `/consent-events/${ev[0]!.id}/not-opt-out`, { reason: 'She meant the other agent' });
    expect(r.status).toBe(200);
    expect(r.body.restored.every((s) => s.status === 'granted' && s.level === 'express')).toBe(true);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'consent.not_opt_out_marked'", [w.tenantId])).rows).toHaveLength(1);
    expect((await call(agent, 'POST', `/consent-events/${ev[0]!.id}/not-opt-out`, { reason: 'again' })).code).toBe('ALREADY_REVIEWED');
  });

  it('R-CONSENT-11: a wrong-number reply marks the point, revokes every channel of the address and stops the enrollment', async () => {
    const c = await ownedContact(w.agents[0]!);
    const n = await nurture(c.id);
    await inboundSms(h, c.phone, w.mainNumber, 'wrong number, who is this?');
    expect((await h.su.query("SELECT status FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.status).toBe('wrong_number');
    const st = (await h.su.query("SELECT channel, status FROM consent_state WHERE address_hmac = (SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'phone') ORDER BY channel, purpose", [c.id])).rows;
    expect(new Set(st.map((x) => x.channel))).toEqual(new Set(['sms', 'voice']));
    expect(st.every((x) => x.status === 'revoked')).toBe(true);
    expect((await h.su.query('SELECT state, stop_reason FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]).toEqual({ state: 'stopped', stop_reason: 'wrong_number' });
  });
});

describe('pause and handback (R-AST-9)', () => {
  it('R-AST-9 E26: a reply while a nurture step is queued cancels it, pauses the enrollment and its step run, and creates exactly one handback with evidence-backed claims, a feed item and a notification', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    expect((await sendText(agent, c.id, 'Earlier note from the agent')).body.result).toBe('sent');
    const n = await nurture(c.id);
    const msid = sid();
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Can we push the showing to Friday?', msid)).statusCode).toBe(200);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Can we push the showing to Friday?', msid)).statusCode).toBe(200); // redelivery
    expect((await messageRow(h, n.messageId)).status).toBe('canceled');
    expect((await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]).toEqual({ state: 'paused', pause_reason: 'client_reply' });
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [n.stepRunId])).rows[0]!.status).toBe('canceled_paused');
    expect((await h.su.query('SELECT automation_pause_reason FROM conversations WHERE contact_id = $1', [c.id])).rows[0]!.automation_pause_reason).toBe('client_reply');
    const hb = (await h.su.query<{ id: string; owner_user_id: string; dedupe_key: string }>("SELECT id, owner_user_id, dedupe_key FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows;
    expect(hb).toHaveLength(1);
    expect(hb[0]!.owner_user_id).toBe(agent.userId);
    expect(hb[0]!.dedupe_key).toMatch(new RegExp(`^handback:${n.enrollmentId}:`));
    const claims = (await h.su.query<{ claim_kind: string; text: string; needs_review: boolean; snippet: string; verbatim_verified: boolean }>(
      'SELECT c.claim_kind, c.text, c.needs_review, e.snippet, e.verbatim_verified FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1 ORDER BY c.ordinal', [hb[0]!.id])).rows;
    expect(claims.map((x) => x.claim_kind)).toEqual(['client_statement', 'sent_summary']);
    expect(claims[0]!.snippet).toBe('Can we push the showing to Friday?');
    expect(claims.every((x) => x.verbatim_verified && !x.needs_review)).toBe(true);
    expect((await h.su.query("SELECT 1 FROM priority_feed_items WHERE user_id = $1 AND item_type = 'handback' AND assistant_action_id = $2", [agent.userId, hb[0]!.id])).rows).toHaveLength(1);
    expect((await h.su.query("SELECT kind, priority FROM notifications WHERE user_id = $1 AND subject_id = $2", [agent.userId, hb[0]!.id])).rows[0]).toEqual({ kind: 'handback_hot', priority: 'critical' });
    expect((await h.su.query("SELECT 1 FROM jobs WHERE kind = 'assistant.enrich_handback' AND payload->>'actionId' = $1", [hb[0]!.id])).rows).toHaveLength(1);
    // a human-scheduled message is NOT cancelled by a reply (it needs a re-tap at send time instead)
  });

  it('R-AST-9: the pause covers every contact sharing the address (shared-address pause)', async () => {
    const phone = randomPhone();
    const a = await ownedContact(w.agents[0]!, { phone, firstName: 'Ann' });
    const b = await ownedContact(w.agents[1]!, { phone, firstName: 'Bob', confirmDistinct: true });
    const nb = await nurture(b.id);
    await inboundSms(h, phone, w.mainNumber, 'Hi, quick question');
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [nb.enrollmentId])).rows[0]!.state).toBe('paused');
    const paused = (await h.su.query('SELECT contact_id FROM conversations WHERE contact_id = ANY ($1) AND automation_paused_at IS NOT NULL', [[a.id, b.id]])).rows;
    expect(paused).toHaveLength(2);
    expect((await messageRow(h, nb.messageId)).status).toBe('canceled');
  });

  it('E22: a message already dispatching when the client replied goes out, and the handback says so honestly', async () => {
    const c = await ownedContact(w.agents[0]!);
    const n = await nurture(c.id);
    // TX1 of the nurture message committed first (dispatching) — the millisecond window
    const dec = randomUUID();
    await h.su.query(`INSERT INTO gate_decisions (tenant_id, id, contact_id, address_hmac, channel, purpose, initiator, action_category, phase, outcome, explanation, policy_version_id, core_rules_version, inputs, inputs_sha256, message_id, evaluated_at)
      SELECT $1, $2, $3, address_hmac, 'sms', 'informational', 'assistant', 'reminder', 'send', 'allow', 'ok', (SELECT active_policy_id FROM tenant_settings WHERE tenant_id = $1), 'core-compliance/1.1.0', '{}', repeat('0', 64), $4, now()
        FROM contact_points WHERE contact_id = $3 AND kind = 'phone'`, [w.tenantId, dec, c.id, n.messageId]);
    await h.su.query("UPDATE messages SET status = 'dispatching', dispatched_at = now(), gate_decision_id = $2 WHERE id = $1", [n.messageId, dec]);
    await inboundSms(h, c.phone, w.mainNumber, 'STOP');
    const hb = (await h.su.query("SELECT id, payload FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows[0]!;
    expect(hb.payload.sentAtSameMoment).toBe(true);
    const claims = (await h.su.query('SELECT text FROM assistant_claims WHERE action_id = $1', [hb.id])).rows.map((x) => x.text);
    expect(claims.some((t: string) => /at the same moment/.test(t))).toBe(true);
  });

  it('E28: an out-of-office email reply pauses (safe), the handback is labelled with its header evidence, and a human resumes with one tap (audited, human only)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const n = await nurture(c.id);
    await appointmentContext(c.id, agent.userId!);
    // an email from the agent establishes the reply token (Reply-To r+{token}@in.…)
    const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Here are the details.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Out of office', text: 'I am away until Monday.', headers: { 'Auto-Submitted': 'auto-replied' } });
    expect(r.statusCode).toBe(200);
    const msg = (await h.su.query("SELECT is_auto_reply FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows[0]!;
    expect(msg.is_auto_reply).toBe(true);
    const hb = (await h.su.query("SELECT id, payload, explanation FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows[0]!;
    expect(hb.payload.autoReply).toBe(true);
    const ev = (await h.su.query("SELECT e.snippet FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1 AND e.locator->>'field' LIKE 'header:%'", [hb.id])).rows;
    expect(ev[0]!.snippet).toBe('Auto-Submitted: auto-replied');
    const resume = await call<{ resumedEnrollments: number }>(agent, 'POST', `/contacts/${c.id}/automation/resume`);
    expect(resume.status).toBe(200);
    expect(resume.body.resumedEnrollments).toBe(1);
    expect((await h.su.query('SELECT state, resumed_by_user_id FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]).toEqual({ state: 'active', resumed_by_user_id: agent.userId });
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'automation.resumed' AND entity_id = $2", [w.tenantId, c.id])).rows).toHaveLength(1);
  });

  it('E61: an email reply from an unknown address attaches through the reply token and only SUGGESTS adding the address', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await appointmentContext(c.id, agent.userId!);
    await call(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hi', body: 'Checking in.', idempotencyKey: `e-${randomUUID()}` });
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: 'jane.work@elsewhere.test', to: replyTo, subject: 'Re: Hi', text: 'Replying from work' });
    expect((await h.su.query("SELECT contact_id FROM messages WHERE direction = 'inbound' AND from_address = 'jane.work@elsewhere.test'")).rows[0]!.contact_id).toBe(c.id);
    expect((await h.su.query("SELECT 1 FROM contact_points WHERE address = 'jane.work@elsewhere.test'")).rows).toHaveLength(0);
    const feed = (await h.su.query("SELECT reasons FROM priority_feed_items WHERE user_id = $1 AND contact_id = $2 AND dedupe_key LIKE 'new_address:%'", [agent.userId, c.id])).rows;
    expect(feed[0]!.reasons[0].code).toBe('UNKNOWN_SENDER_ADDRESS');
  });
});

describe('unknown senders, released numbers, old numbers (R-CONSENT-4, R-TEN-8, E17, E55)', () => {
  it('R-CONSENT-4: a first text from an unknown number creates an Unknown contact through routing with an express informational basis; a human reply needs no confirmation', async () => {
    const phone = randomPhone();
    await inboundSms(h, phone, w.mainNumber, 'Hi, is the house on Elm still available?');
    const c = (await h.su.query<{ id: string; display_name: string; ownership_state: string }>("SELECT c.id, c.display_name, c.ownership_state FROM contacts c JOIN contact_points p ON p.contact_id = c.id WHERE p.address = $1 AND c.tenant_id = $2", [phone, w.tenantId])).rows[0]!;
    expect(c.display_name).toMatch(/^Unknown \(\d{3}\) \d{3}-\d{4}$/);
    expect(['offered', 'unassigned', 'in_pond', 'owned']).toContain(c.ownership_state);
    const ev = (await h.su.query("SELECT source, consent_level, purpose FROM consent_events WHERE contact_id = $1", [c.id])).rows;
    expect(ev).toEqual([{ source: 'inbound_first_contact', consent_level: 'express', purpose: 'informational' }]);
  });

  it('R-TEN-8 E55: inbound to a released number is never delivered (unrouted); nothing is stored for the tenant', async () => {
    await freshReauth(h, w.owner);
    const extra = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking' });
    expect((await call(w.owner, 'POST', `/numbers/${extra.body.number.id}/release`)).status).toBe(200);
    const phone = randomPhone();
    const s = sid();
    expect((await inboundSms(h, phone, extra.body.number.e164, 'hello?', s)).statusCode).toBe(200);
    expect((await h.su.query("SELECT status, tenant_id FROM webhook_events WHERE provider_event_id = $1", [`sms:${s}`])).rows[0]).toEqual({ status: 'unrouted', tenant_id: null });
    expect((await h.su.query('SELECT 1 FROM messages WHERE from_address = $1', [phone])).rows).toHaveLength(0);
    // and another tenant cannot take it during the 90-day quarantine (cross-tenant trigger)
    const q = await h.su.query<{ quarantine_until: Date; released_at: Date }>('SELECT quarantine_until, released_at FROM phone_numbers WHERE id = $1', [extra.body.number.id]);
    expect(q.rows[0]!.quarantine_until.getTime() - q.rows[0]!.released_at.getTime()).toBeGreaterThanOrEqual(90 * 86_400_000);
  });

  it('E17: a client texting the old owner\'s number after a reassignment reaches the current owner; the old owner gets a content-free notice', async () => {
    const [a, b] = w.agents as [NonNullable<typeof w.agents[0]>, NonNullable<typeof w.agents[0]>];
    await freshReauth(h, w.owner);
    const direct = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'agent_direct', assignedUserId: a.userId, registrationId: w.registrationId });
    const c = await ownedContact(a);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reassign`, { commandId: randomUUID(), toUserId: b.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    await inboundSms(h, c.phone, direct.body.number.e164, 'Are we still on for Saturday?');
    expect((await h.su.query("SELECT kind FROM notifications WHERE user_id = $1 AND subject_type = 'message'", [b.userId])).rows.length).toBeGreaterThan(0);
    const old = (await h.su.query<{ title: string; body: string | null }>("SELECT title, body FROM notifications WHERE user_id = $1 AND subject_type = 'phone_number'", [a.userId])).rows;
    expect(old).toHaveLength(1);
    expect(old[0]!.title).not.toMatch(/Saturday|\+1/);
    expect(old[0]!.body).toBeNull();
  });

  it('a missed inbound call pauses automation and lands in the feed', async () => {
    const c = await ownedContact(w.agents[0]!);
    const n = await nurture(c.id);
    const r = await telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: sid('CA'), From: c.phone, To: w.mainNumber, CallStatus: 'no-answer', Direction: 'inbound' });
    expect(r.statusCode).toBe(200);
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]!.state).toBe('paused');
    expect((await h.su.query("SELECT status, direction FROM calls WHERE contact_id = $1", [c.id])).rows[0]).toEqual({ status: 'no_answer', direction: 'inbound' });
  });
});

describe('agent alert texts (E60)', () => {
  it('E60 R-GATE-10: an agent texting STOP from their alert phone stops alert texts (recipient user); the next alert is suppressed by the gate and never sent; Admins are told', async () => {
    const agent = w.agents[1]!;
    const phone = randomPhone();
    const ch = await agent.post('/api/me/alert-phone', { phone });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    await inboundSms(h, phone, w.mainNumber, 'STOP');
    expect((await h.su.query('SELECT 1 FROM messages WHERE from_address = $1', [phone])).rows).toHaveLength(0);
    const n = randomUUID();
    const d = randomUUID();
    await h.su.query("INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, dedupe_key) VALUES ($1,$2,$3,'lead_offer','critical','New lead offer',$4)", [w.tenantId, n, agent.userId, `t:${n}`]);
    await h.su.query("INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'sms','alert_phone','pending',now())", [w.tenantId, d, n]);
    const r = await dispatchAgentAlertSms(d, w.deps, w.tenantId);
    expect(r.kind).toBe('suppressed');
    expect((r as { reasons: string[] }).reasons).toContain('CONSENT_REVOKED');
    expect(smsTo(phone)).toHaveLength(0);
    expect((await h.su.query('SELECT status FROM notification_deliveries WHERE id = $1', [d])).rows[0]!.status).toBe('suppressed');
    expect((await h.su.query("SELECT 1 FROM notifications WHERE tenant_id = $1 AND subject_type = 'membership' AND subject_id = $2", [w.tenantId, agent.userId])).rows.length).toBeGreaterThan(0);
  });
});

void suFixture;
