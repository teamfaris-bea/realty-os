// b18 review B18S-5 (owner product boundary, 2026-11-14): a referral partner is not an AI cohort, and its first-week
// email introduction does not permit this CRM's autonomous texting, calling or mass enrolment. The Owner's lead-source
// setting is therefore "No automated contact for leads from this source" (0094's lead_sources.no_ai_care, read through
// app.person_no_ai_care_source over every record and inquiry of the person, 0096): it blocks the automatic first
// response, every plan enrolment (automatic, bulk, and by hand: OQ-B18-S5's conservative default), bulk sends, and any
// automated message already queued (dispatch TX1 and 0098's database guards). A person's own one-to-one call, text and
// email still go. The sources here are made-up test sources: no partner is named in code, seeds or tests. Fakes only.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollOnDealClosed } from '../assistant/enrollments.js';
import { sendFirstResponse } from '../assistant/firstResponse.js';
import { approvedPlaybook, depsOf, enrollmentRow, messagesOf, runJobs, smsStep, stepNow } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { runBulkAction } from '../bulk/run.js';
import { confirm, draft, itemsOf, marketingReady } from '../bulk/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, call, commsWorld, decisionsFor, freshReauth, inboundSms, messageRow, ownedContact, randomEmail, randomPhone, sendText } from '../comms/testing.js';
import { closedDeal } from '../nurture/testing.js';
import { changeStage, decisionsOf, enrollmentsOf, setStage } from '../stageAutomation/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT, isSourceGuardViolation, notResumedSentence } from './automatedContact.js';
import { postIntake } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let marked: { id: string; token: string };
let plan: { id: string; versionId: string; name: string };

const FR = ['assistant.first_response', 'comms.dispatch'];
const textStep = (key: string) => smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] });

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  agent = w.agents[0]!;
  await marketingReady(h, w);
  const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' });
  marked = { id: src.body.source.id, token: src.body.ingestToken };
  await freshReauth(h, w.owner);
  const on = await call<{ source: { noAiCareSentence: string } }>(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true });
  expect(on.status).toBe(200);
  // a team plan the Owner approves; a stage entry into 'active' starts it too
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', { kind: 'nurture', scope: 'team', name: 'Check-in (test)', steps: [textStep('check_in')] });
  const v = c.body.playbook.versions[0]!;
  expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  expect((await setStage(w.owner, c.body.playbook.id, 'active')).status).toBe(200);
  plan = { id: c.body.playbook.id, versionId: v.id, name: 'Check-in (test)' };
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** fixture only: the person came from the marked source (the intake writes original_lead_source_id; the test sets it) */
const markLead = (contactId: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, marked.id]);
const enroll = (c: TestClient, contactId: string) => call<{ enrollment: { id: string } }>(c, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: plan.id });
const automated = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.initiator !== 'human');
const asUser = (c: TestClient): UserActor => c.actor() as UserActor;

describe('R-LSRC-8 B18S-5: "No automated contact for leads from this source" (owner boundary 2026-11-14)', () => {
  it('B18S-5 E727: the setting is named honestly; its sentence says nothing automatic reaches the source\'s leads and that one-to-one calls, texts and emails stay allowed', async () => {
    const ov = await call<{ sources: { id: string; noAiCare: boolean; noAiCareSentence: string }[] }>(w.owner, 'GET', '/lead-sources/overview');
    const s = ov.body.sources.find((x) => x.id === marked.id)!;
    expect(s.noAiCare).toBe(true);
    expect(NO_AUTOMATED_CONTACT_LABEL).toBe('No automated contact for leads from this source');
    expect(s.noAiCareSentence.startsWith(`${NO_AUTOMATED_CONTACT_LABEL}: on.`)).toBe(true);
    expect(s.noAiCareSentence).toMatch(/one to one/);
    expect(s.noAiCareSentence).not.toMatch(/No AI care/);
  });

  it('B18S-5 E727: the 60-second first response is not sent, by text or by email, to a lead the marked source sends; the lead card says why; a lead from another source still gets it', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const phone = randomPhone();
    const email = randomEmail();
    const textLead = await postIntake(h, marked.token, { inquiryType: 'buy', fullName: 'Rae Referral', phones: [phone], emails: [email] });
    expect([200, 201]).toContain(textLead.statusCode);
    const emailOnly = await postIntake(h, marked.token, { inquiryType: 'buy', fullName: 'Eli Referral', phones: [], emails: [randomEmail()] });
    expect([200, 201]).toContain(emailOnly.statusCode);
    await runJobs(h, w.tenantId, FR);
    for (const r of [textLead, emailOnly]) {
      const id = (JSON.parse(r.body) as { contactId: string }).contactId;
      expect(await automated(id)).toEqual([]);
      const again = await sendFirstResponse(systemActor(w.tenantId, 'assistant'), id, depsOf(h));
      expect(again).toMatchObject({ kind: 'not_sent', reason: SOURCE_NO_AUTOMATED_CONTACT });
      expect(await automated(id)).toEqual([]);
    }
    expect(h.providers.telephony.sms.filter((x) => x.to === phone)).toEqual([]);
    expect(h.providers.email.sent.filter((x) => x.to === email)).toEqual([]);
    const id = (JSON.parse(textLead.body) as { contactId: string }).contactId;
    const cards = (await h.su.query<{ reasons: { code: string; text: string }[] }>("SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND state IN ('open','snoozed')", [id])).rows;
    const why = cards.flatMap((c) => c.reasons).find((r) => r.code === SOURCE_NO_AUTOMATED_CONTACT);
    expect(why?.text).toMatch(/No instant reply was sent/);
    expect(why?.text).toContain(NO_AUTOMATED_CONTACT_LABEL);
    // the source's routing preview says the instant reply is off for it, and on for the world's own source
    expect((await call<{ firstResponse: string }>(w.owner, 'POST', `/lead-sources/${marked.id}/preview`, {})).body.firstResponse).toBe('off');
    expect((await call<{ firstResponse: string }>(w.owner, 'POST', `/lead-sources/${w.sourceId}/preview`, {})).body.firstResponse).toBe('queued');
    // control: a lead from the world's own source still gets the instant text
    const open = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Oli Open', phones: [randomPhone()], emails: [randomEmail()] });
    await runJobs(h, w.tenantId, FR);
    expect((await automated((JSON.parse(open.body) as { contactId: string }).contactId)).map((m) => m.action_category)).toEqual(['speed_to_lead_reply']);
  });

  it('B18S-5 OQ-B18-S5: a person enrolling one such lead into a plan by hand is refused 409 SOURCE_NO_AUTOMATED_CONTACT and nothing is written; the database refuses an enrollment row too; another lead still enrolls', async () => {
    const c = await ownedContact(agent);
    await markLead(c.id);
    const r = await enroll(agent, c.id);
    expect([r.status, r.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    expect(await enrollmentsOf(h, c.id)).toEqual([]);
    expect(await automated(c.id)).toEqual([]);
    await expect(withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state, current_step)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${plan.id}::uuid, ${plan.versionId}::uuid, ${c.id}::uuid, 'new_lead', 'active', 0)`.execute(tx), { db: h.database })).rejects.toThrow(/SOURCE_NO_AUTOMATED_CONTACT/);
    const ok = await ownedContact(agent);
    expect((await enroll(agent, ok.id)).status).toBe(201);
  });

  it('B18S-5 E727: no plan starts on its own for such a lead: a stage entry skips the plan (source_no_automated_contact) and a closed deal enrolls nobody; another lead starts both', async () => {
    const c = await ownedContact(agent);
    await markLead(c.id);
    const s = await changeStage(agent, c.id, 'active');
    expect(s.status).toBe(200);
    expect(s.body.automation).toEqual({ skipped: 'source_no_automated_contact', plan: plan.name });
    expect((await decisionsOf(h, c.id)).map((d) => [d.outcome, d.reason])).toEqual([['skipped', 'source_no_automated_contact']]);
    expect(await enrollmentsOf(h, c.id)).toEqual([]);
    const other = await ownedContact(agent);
    expect((await changeStage(agent, other.id, 'active')).body.automation).toEqual({ started: plan.name });

    await approvedPlaybook(agent, { templateKey: 'post_closing' }); // the agent's own post-closing plan
    const buyer = await ownedContact(agent);
    await markLead(buyer.id);
    const deal = await closedDeal(h, w.tenantId, buyer.id, agent.userId!, new Date(Date.now() - 60_000));
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), deal, depsOf(h))).toEqual([]);
    expect(await enrollmentsOf(h, buyer.id)).toEqual([]);
    const plain = await ownedContact(agent);
    const deal2 = await closedDeal(h, w.tenantId, plain.id, agent.userId!, new Date(Date.now() - 60_000));
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), deal2, depsOf(h))).toHaveLength(1);
  });

  it('B18S-5 E727: a plan already running for a person the source then turns out to have sent stops at its next step (stop_reason source_no_automated_contact) and sends nothing; a paused one cannot be resumed, by the API or the database', async () => {
    const c = await ownedContact(agent);
    const e = await enroll(agent, c.id);
    expect(e.status).toBe(201);
    await markLead(c.id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h, e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    expect(await automated(c.id)).toEqual([]);

    const d = await ownedContact(agent);
    const p = await enroll(agent, d.id);
    expect((await call(agent, 'POST', `/enrollments/${p.body.enrollment.id}/pause`)).status).toBe(200);
    await markLead(d.id);
    const r = await call(agent, 'POST', `/enrollments/${p.body.enrollment.id}/resume`);
    expect([r.status, r.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    await expect(withTenantTx(asUser(agent), (tx) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, resumed_by_user_id = app.user_id()
      WHERE tenant_id = app.tenant_id() AND id = ${p.body.enrollment.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/SOURCE_NO_AUTOMATED_CONTACT/);
    expect(await enrollmentRow(h, p.body.enrollment.id)).toMatchObject({ state: 'paused' });
  });

  it('B18S-5 E727 (round 3 item 4): turning the setting on stops that source\'s live plans at once, though their next step is not due until tomorrow; the answer counts only this source\'s plans; in a mixed set, another marked source\'s plan still waiting to stop is not counted, and an unmarked person\'s plan keeps running', async () => {
    const slow = await approvedPlaybook(w.owner, {
      kind: 'nurture',
      scope: 'team',
      name: 'Two check-ins (test)',
      steps: [textStep('first'), { ...textStep('second'), delay: { anchor: 'previous_step', offsetSeconds: 86_400 } }],
    });
    const made = async (name: string) => (await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind: 'portal' })).body;
    const hillside = await made('Hillside Referrals (test)');
    const router = await made('Routing Desk (test)');
    const turnOn = async (id: string) => {
      await freshReauth(h, w.owner);
      return call<{ pausing: number; stopping: number }>(w.owner, 'PUT', `/lead-sources/${id}/ai-care`, { noAiCare: true });
    };
    const fromSource = (contactId: string, sourceId: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, sourceId]);
    // three people in the plan: its first text went, the second is due tomorrow
    const running = async () => {
      const c = await ownedContact(agent);
      const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: slow.playbookId });
      expect(e.status).toBe(201);
      return { c, id: e.body.enrollment.id };
    };
    const a = await running();
    const b = await running();
    const plain = await running();
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    // past the runner's check-back on the first text: the plan now waits for the second step, a day after the first
    for (const x of [a, b, plain]) await stepNow(h, w.tenantId, x.id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const x of [a, b, plain]) {
      const row = await enrollmentRow(h, x.id);
      expect(row.state).toBe('active');
      expect(row.next_step_due_at!.getTime()).toBeGreaterThan(Date.now() + 12 * 3_600_000);
      expect((await automated(x.c.id)).map((m) => m.status)).toEqual(['sent']);
    }
    await fromSource(a.c.id, hillside.source.id);
    await fromSource(b.c.id, router.source.id);
    // the first source: one plan, its own. No job has run yet, so that plan is still live when the second is turned on
    const first = await turnOn(hillside.source.id);
    expect([first.status, first.body.stopping, first.body.pausing]).toEqual([200, 1, 0]);
    expect((await enrollmentRow(h, a.id)).state).toBe('active');
    const second = await turnOn(router.source.id);
    expect([second.status, second.body.stopping, second.body.pausing]).toEqual([200, 1, 0]);
    // at once: the steps the route asked for stop both plans, though neither's next step is due
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const x of [a, b]) {
      const row = await enrollmentRow(h, x.id);
      expect(row).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
      expect(row.next_step_due_at === null || row.next_step_due_at.getTime() > Date.now()).toBe(true);
      expect((await automated(x.c.id)).map((m) => m.status)).toEqual(['sent']);
    }
    // the person from no marked source: still in the plan, still waiting for tomorrow
    expect(await enrollmentRow(h, plain.id)).toMatchObject({ state: 'active', stop_reason: null });
    // a marked source sending a person again stops their running plan at once too (the intake asks for the step)
    const again = await postIntake(h, marked.token, { inquiryType: 'buy', fullName: 'Jane Doe', phones: [plain.c.phone], emails: [plain.c.email] });
    expect([200, 201]).toContain(again.statusCode);
    expect((JSON.parse(again.body) as { contactId: string }).contactId).toBe(plain.c.id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h, plain.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    expect((await automated(plain.c.id)).map((m) => m.status)).toEqual(['sent']);
  });

  it('B18S-5 E727 (round 3 item 2): "Resume automation" for such a person whose plan a reply paused lifts only the conversation pause; the plan stays paused and the answer says how many were not resumed and why (never a 500)', async () => {
    const c = await ownedContact(agent);
    const e = await enroll(agent, c.id);
    expect(e.status).toBe(201);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Yes, still looking. Can we talk later?')).statusCode).toBe(200);
    expect(await enrollmentRow(h, e.body.enrollment.id)).toMatchObject({ state: 'paused', pause_reason: 'client_reply' });
    await markLead(c.id);
    const r = await call<{ resumedEnrollments: number; notResumed: { enrollments: number; code: string; sentence: string } | null }>(agent, 'POST', `/contacts/${c.id}/automation/resume`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resumedEnrollments: 0, notResumed: { enrollments: 1, code: SOURCE_NO_AUTOMATED_CONTACT, sentence: notResumedSentence(1) } });
    expect(notResumedSentence(1)).toBe(`1 plan was not resumed: "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting). Call, text or email them one to one.`);
    expect(notResumedSentence(2)).toMatch(/^2 plans were not resumed: /);
    expect(await enrollmentRow(h, e.body.enrollment.id)).toMatchObject({ state: 'paused', pause_reason: 'client_reply' });
    expect((await h.su.query<{ automation_paused_at: Date | null }>('SELECT automation_paused_at FROM conversations WHERE contact_id = $1', [c.id])).rows[0]!.automation_paused_at).toBeNull();
    // the audit row says what was lifted and what was left
    const au = (await h.su.query<{ reason: string }>("SELECT reason FROM audit_log WHERE action = 'automation.resumed' AND entity_id = $1 ORDER BY seq DESC LIMIT 1", [c.id])).rows[0];
    expect(au?.reason).toBe('HUMAN_RESUME_CONVERSATION_ONLY');
    // a second tap has nothing left to lift: the clear 409 the route always gave, not a 500
    const again = await call(agent, 'POST', `/contacts/${c.id}/automation/resume`);
    expect([again.status, again.code]).toEqual([409, 'AUTOMATION_NOT_PAUSED']);
    // a source marked between the route's check and its write is refused by 0098's guard: the route maps exactly that error to 409
    const guard = await withTenantTx(asUser(agent), (tx) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, resumed_by_user_id = app.user_id()
      WHERE tenant_id = app.tenant_id() AND id = ${e.body.enrollment.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (err: unknown) => err);
    expect(isSourceGuardViolation(guard)).toBe(true);
    expect(isSourceGuardViolation(new Error('SOURCE_NO_AUTOMATED_CONTACT: not from the database'))).toBe(false);
    expect(isSourceGuardViolation({ code: '23514', message: 'RESUME_REQUIRES_HUMAN: another guard' })).toBe(false);
    // a person not marked resumes as before
    const d = await ownedContact(agent);
    const p = await enroll(agent, d.id);
    expect((await inboundSms(h, d.phone, w.mainNumber, 'Sounds good, talk soon.')).statusCode).toBe(200);
    const ok = await call<{ resumedEnrollments: number; notResumed: unknown }>(agent, 'POST', `/contacts/${d.id}/automation/resume`);
    expect([ok.status, ok.body]).toEqual([200, { resumedEnrollments: 1, notResumed: null }]);
    expect(await enrollmentRow(h, p.body.enrollment.id)).toMatchObject({ state: 'active' });
  });

  it('B18S-5 E727: an automated message already queued for such a person is blocked at dispatch (SOURCE_NO_AUTOMATED_CONTACT, with the sentence); a system message too; the database guard refuses one moved to dispatching directly', async () => {
    const c = await ownedContact(agent);
    expect((await enroll(agent, c.id)).status).toBe(201);
    await runJobs(h, w.tenantId, ['playbook.step'], 3, ['default']); // the step queues its text; dispatch has not run
    const [queued] = await automated(c.id);
    expect(queued?.status).toBe('queued');
    await markLead(c.id);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, queued!.id);
    expect([m.status, m.status_reason]).toEqual(['blocked', SOURCE_NO_AUTOMATED_CONTACT]);
    const [dec] = await decisionsFor(h, { messageId: queued!.id });
    expect(dec!.reason_codes).toContain(SOURCE_NO_AUTOMATED_CONTACT);
    expect(dec!.explanation).toContain(NO_AUTOMATED_CONTACT_LABEL);
    expect(h.providers.telephony.sms.filter((x) => x.to === c.phone && x.body.includes('checking in'))).toEqual([]);

    // a system message (a saved-search alert) queued for them
    const sys = systemActor(w.tenantId, 'worker');
    const q = await withTenantTx(sys, (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'email', subject: 'Homes for you', body: 'Two homes match your search.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    expect(q.ok).toBe(true);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const alert = await messageRow(h, (q as { messageId: string }).messageId);
    expect([alert.status, alert.status_reason]).toEqual(['blocked', SOURCE_NO_AUTOMATED_CONTACT]);
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toEqual([]);

    // the database backstop: an automated message moved to dispatching without dispatch TX1
    const q2 = await withTenantTx(sys, (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'email', subject: 'Homes for you', body: 'One more home.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    await expect(withTenantTx(sys, (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${(q2 as { messageId: string }).messageId}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/SOURCE_NO_AUTOMATED_CONTACT/);
  });

  it('B18S-5 E727: a person\'s own one-to-one text, email and call to such a lead still go', async () => {
    const c = await ownedContact(agent);
    await markLead(c.id);
    const t = await sendText(agent, c.id, 'Hi Jane, this is Sam from the team. Do you have a minute today?');
    expect([t.status, t.body.result]).toEqual([200, 'sent']);
    const e = await sendText(agent, c.id, 'Hi Jane, following up on your question about the house.', { channel: 'email', subject: 'Your question' });
    expect([e.status, e.body.result]).toEqual([200, 'sent']);
    expect(h.providers.telephony.sms.filter((x) => x.to === c.phone)).toHaveLength(1);
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toHaveLength(1);
    // a call: the agent's alert phone is the bridge
    const ch = await agent.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    const d = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect([d.status, d.body.result]).toEqual([200, 'dialing']);
  });

  it('B18S-5 E727: bulk enroll and bulk email leave such leads out and count them (SOURCE_NO_AUTOMATED_CONTACT), at the draft and again at the run', async () => {
    const [a, b, late] = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)];
    await markLead(a.id);
    const d = await draft(agent, { kind: 'enroll', selection: { contactIds: [a.id, b.id, late.id] }, playbookId: plan.id });
    expect(d.status).toBe(201);
    expect(d.body.action.preflight).toEqual({ [SOURCE_NO_AUTOMATED_CONTACT]: 1 });
    expect(d.body.action.targetCount).toBe(2);
    await markLead(late.id); // marked after the draft: the run leaves them out too
    expect((await confirm(agent, d.body.action.id)).status).toBe(200);
    await runBulkAction(d.body.action.id, w.deps, w.tenantId);
    expect((await itemsOf(h, d.body.action.id)).find((i) => i.contact_id === late.id)).toMatchObject({ status: 'skipped', reason_code: SOURCE_NO_AUTOMATED_CONTACT });
    expect((await enrollmentsOf(h, a.id)).length + (await enrollmentsOf(h, late.id)).length).toBe(0);
    expect((await enrollmentsOf(h, b.id)).map((e) => e.enrolled_by)).toEqual(['bulk']);
    const v = await call<{ action: { counts: { byReason: Record<string, number>; done: number } } }>(agent, 'GET', `/bulk-actions/${d.body.action.id}`);
    expect(v.body.action.counts).toMatchObject({ done: 1, byReason: { [SOURCE_NO_AUTOMATED_CONTACT]: 2 } });

    const [x, y, z] = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)];
    await markLead(x.id);
    const tpl = (await call<{ template: { id: string } }>(agent, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `B ${randomUUID().slice(0, 6)}`, subject: 'For {{contact.first_name}}', body: 'Hi {{contact.first_name}}, new homes this week.' })).body.template.id;
    const m = await draft(agent, { kind: 'email', selection: { contactIds: [x.id, y.id, z.id] }, templateId: tpl });
    expect(m.body.action.preflight).toEqual({ [SOURCE_NO_AUTOMATED_CONTACT]: 1 });
    await markLead(z.id);
    await confirm(agent, m.body.action.id);
    await runBulkAction(m.body.action.id, w.deps, w.tenantId);
    expect((await itemsOf(h, m.body.action.id)).find((i) => i.contact_id === z.id)).toMatchObject({ status: 'skipped', reason_code: SOURCE_NO_AUTOMATED_CONTACT, message_id: null });
    expect(h.providers.email.sent.filter((e) => e.to === x.email || e.to === z.email)).toEqual([]);
    expect(h.providers.email.sent.filter((e) => e.to === y.email)).toHaveLength(1);
    const n = (await h.su.query<{ title: string }>("SELECT title FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [m.body.action.id])).rows[0]!;
    expect(n.title).toBe('Emailed 1 of 3: 2 no automated contact (their lead source)');
  });
});
