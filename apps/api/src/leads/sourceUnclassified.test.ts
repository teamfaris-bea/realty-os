// R-LSRC-9 (owner decision 2026-11-14; migration 0101): an imported person whose source nobody has reviewed is
// "unclassified": an unmapped label, a label two lead sources hold, or no label at all. They get no automated contact on
// exactly the paths where a marked source's person gets none, because every path asks the same definer; the reason is
// its own code, SOURCE_UNCLASSIFIED, with its own sentence (the imported source has not been reviewed yet; an Owner
// reviews it under Lead sources), never the marked source's "the Owner turned this on". A person's own one-to-one call,
// text and email still go, and the STOP confirmation and HELP reply the person asked for still go. The Owner's mapping
// lifts it (an unmarked source) or keeps the person refused for the other reason (a marked source). Made-up labels and
// sources; no partner is named. Fakes only.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollOnDealClosed } from '../assistant/enrollments.js';
import { sendFirstResponse } from '../assistant/firstResponse.js';
import { approvedPlaybook, depsOf, enrollmentRow, messagesOf, runJobs, smsStep } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { runBulkAction } from '../bulk/run.js';
import { confirm, draft, itemsOf, marketingReady } from '../bulk/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, call, commsWorld, decisionsFor, freshReauth, inboundSms, messageRow, ownedContact, randomPhone, sendText } from '../comms/testing.js';
import { closedDeal } from '../nurture/testing.js';
import { changeStage, decisionsOf, enrollmentsOf, setStage } from '../stageAutomation/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, SOURCE_UNCLASSIFIED_SENTENCE, noAutomatedContact, noInstantReplySentence, notResumedSentence, sourceDenySentence, sourceGuardViolation, sourceStopReason } from './automatedContact.js';
import { importedPerson } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let plan: { id: string; versionId: string; name: string };
let plain: { id: string; name: string };
let marked: { id: string; name: string };

const textStep = (key: string) => smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] });

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  agent = w.agents[0]!;
  await marketingReady(h, w);
  await freshReauth(h, w.owner);
  plain = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'referral' })).body.source;
  marked = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (test)', kind: 'referral' })).body.source;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', { kind: 'nurture', scope: 'team', name: 'Check-in (test)', steps: [textStep('check_in')] });
  const v = c.body.playbook.versions[0]!;
  expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  expect((await setStage(w.owner, c.body.playbook.id, 'active')).status).toBe(200);
  plan = { id: c.body.playbook.id, versionId: v.id, name: 'Check-in (test)' };
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** fixture only: the person came in an import whose label nobody has mapped (leads/testing.ts importedPerson) */
const unreviewed = (contactId: string, o: { label?: string | null } = {}) => importedPerson(h, w.tenantId, w.owner.userId!, contactId, o);
const enroll = (c: TestClient, contactId: string) => call<{ enrollment: { id: string } }>(c, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: plan.id });
const automated = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.initiator !== 'human');
const asUser = (c: TestClient): UserActor => c.actor() as UserActor;
const sys = () => systemActor(w.tenantId, 'worker');
const refusalOf = (contactId: string) => withTenantTx(sys(), (tx) => noAutomatedContact(tx, contactId), { db: h.database });
const mapLabel = async (label: string, leadSourceId: string | null) => {
  await freshReauth(h, w.owner);
  return call<{ pausing: number; stopping: number; withdrawn: number }>(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId });
};

/** The words of an unclassified refusal: what it is, who reviews it and where; never the marked source's setting. */
function expectUnclassifiedWords(text: string | null | undefined): void {
  expect(text).toMatch(/imported source has not been reviewed yet/);
  expect(text).toMatch(/an Owner reviews it under Lead sources/i);
  expect(text).not.toContain(NO_AUTOMATED_CONTACT_LABEL);
  expect(text).not.toMatch(/is on for|turned this on|Owner setting/);
}

describe('R-LSRC-9 A2 A3: an unclassified imported person gets no automated contact, with its own reason (owner decision 2026-11-14)', () => {
  it('R-LSRC-9 E729: the one path every caller asks returns WHICH reason applies: none for a native person, SOURCE_UNCLASSIFIED for an unreviewed import, and the marked source wins when both apply', async () => {
    const native = await ownedContact(agent);
    expect(await refusalOf(native.id)).toBeNull();
    const c = await ownedContact(agent);
    const { label } = await unreviewed(c.id);
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);
    expectUnclassifiedWords(SOURCE_UNCLASSIFIED_SENTENCE);
    for (const s of [sourceDenySentence(SOURCE_UNCLASSIFIED), noInstantReplySentence(SOURCE_UNCLASSIFIED), notResumedSentence(1, SOURCE_UNCLASSIFIED)]) expectUnclassifiedWords(s);
    // both apply: an unreviewed label, and a label the Owner mapped to a marked source
    const both = await ownedContact(agent);
    await unreviewed(both.id);
    const partner = await unreviewed(both.id, { label: `Partner label ${randomUUID().slice(0, 6)} (test)` });
    expect((await mapLabel(partner.label!, marked.id)).status).toBe(200);
    expect(await refusalOf(both.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(sourceDenySentence(SOURCE_NO_AUTOMATED_CONTACT)).toContain(NO_AUTOMATED_CONTACT_LABEL);
    // classified to an unmarked source: lifted
    expect((await mapLabel(label!, plain.id)).status).toBe(200);
    expect(await refusalOf(c.id)).toBeNull();
    expect((await enroll(agent, c.id)).status).toBe(201);
  });

  it('R-LSRC-9 E729: no 60-second first response; its reason is SOURCE_UNCLASSIFIED and its explanation (the lead card\'s line) says the imported source has not been reviewed yet, never that a setting is on', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const c = await ownedContact(agent);
    await unreviewed(c.id);
    const r = await sendFirstResponse(systemActor(w.tenantId, 'assistant'), c.id, depsOf(h));
    expect(r).toMatchObject({ kind: 'not_sent', reason: SOURCE_UNCLASSIFIED, explanation: noInstantReplySentence(SOURCE_UNCLASSIFIED) });
    expect(noInstantReplySentence(SOURCE_UNCLASSIFIED)).toMatch(/^No instant reply was sent: /);
    expectUnclassifiedWords(noInstantReplySentence(SOURCE_UNCLASSIFIED));
    expect(await automated(c.id)).toEqual([]);
  });

  it('R-LSRC-9 E729: a hand enrolment is refused 409 SOURCE_UNCLASSIFIED (details.reason source_unclassified, with the sentence) and nothing is written; the database refuses the row with the same code', async () => {
    const c = await ownedContact(agent);
    await unreviewed(c.id);
    const r = await call<{ error: { details: { reason: string; sentence: string } } }>(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: plan.id });
    expect([r.status, r.code]).toEqual([409, SOURCE_UNCLASSIFIED]);
    const details = r.body.error.details;
    expect(details.reason).toBe('source_unclassified');
    expectUnclassifiedWords(details.sentence);
    expect(await enrollmentsOf(h, c.id)).toEqual([]);
    const refused = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state, current_step)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${plan.id}::uuid, ${plan.versionId}::uuid, ${c.id}::uuid, 'new_lead', 'active', 0)`.execute(tx), { db: h.database }).then(() => null, (e: unknown) => e);
    expect(sourceGuardViolation(refused)).toBe(SOURCE_UNCLASSIFIED);
    expectUnclassifiedWords((refused as Error).message);
  });

  it('R-LSRC-9 E729: no plan starts on its own: a stage entry records the skip source_unclassified (not source_no_automated_contact) and a closed deal enrolls nobody', async () => {
    const c = await ownedContact(agent);
    await unreviewed(c.id);
    const s = await changeStage(agent, c.id, 'active');
    expect(s.status).toBe(200);
    expect(s.body.automation).toEqual({ skipped: 'source_unclassified', plan: plan.name });
    expect((await decisionsOf(h, c.id)).map((d) => [d.outcome, d.reason])).toEqual([['skipped', 'source_unclassified']]);
    expect(await enrollmentsOf(h, c.id)).toEqual([]);
    await approvedPlaybook(agent, { templateKey: 'post_closing' });
    const buyer = await ownedContact(agent);
    await unreviewed(buyer.id);
    const deal = await closedDeal(h, w.tenantId, buyer.id, agent.userId!, new Date(Date.now() - 60_000));
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), deal, depsOf(h))).toEqual([]);
    expect(await enrollmentsOf(h, buyer.id)).toEqual([]);
  });

  it('R-LSRC-9 E730: a running plan stops at its next step job with stop_reason source_unclassified and sends nothing; a paused one cannot be resumed, by the plan route (409 SOURCE_UNCLASSIFIED), by "Resume automation" (200, notResumed with the sentence) or in the database', async () => {
    const c = await ownedContact(agent);
    const e = await enroll(agent, c.id);
    expect(e.status).toBe(201);
    await unreviewed(c.id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h, e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    expect(sourceStopReason(SOURCE_UNCLASSIFIED)).toBe('source_unclassified');
    expect(await automated(c.id)).toEqual([]);

    const d = await ownedContact(agent);
    const p = await enroll(agent, d.id);
    expect((await call(agent, 'POST', `/enrollments/${p.body.enrollment.id}/pause`)).status).toBe(200);
    await unreviewed(d.id);
    const r = await call(agent, 'POST', `/enrollments/${p.body.enrollment.id}/resume`);
    expect([r.status, r.code]).toEqual([409, SOURCE_UNCLASSIFIED]);
    const guard = await withTenantTx(asUser(agent), (tx) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, resumed_by_user_id = app.user_id()
      WHERE tenant_id = app.tenant_id() AND id = ${p.body.enrollment.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (err: unknown) => err);
    expect(sourceGuardViolation(guard)).toBe(SOURCE_UNCLASSIFIED);
    expect(await enrollmentRow(h, p.body.enrollment.id)).toMatchObject({ state: 'paused' });

    // "Resume automation" after a reply paused the plan: only the conversation pause lifts
    const f = await ownedContact(agent);
    const q = await enroll(agent, f.id);
    expect((await inboundSms(h, f.phone, w.mainNumber, 'Yes, still looking. Can we talk later?')).statusCode).toBe(200);
    expect(await enrollmentRow(h, q.body.enrollment.id)).toMatchObject({ state: 'paused', pause_reason: 'client_reply' });
    await unreviewed(f.id);
    const res = await call<{ resumedEnrollments: number; notResumed: { enrollments: number; code: string; sentence: string } | null }>(agent, 'POST', `/contacts/${f.id}/automation/resume`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resumedEnrollments: 0, notResumed: { enrollments: 1, code: SOURCE_UNCLASSIFIED, sentence: notResumedSentence(1, SOURCE_UNCLASSIFIED) } });
    expect(notResumedSentence(1, SOURCE_UNCLASSIFIED)).toMatch(/^1 plan was not resumed: /);
    expect(await enrollmentRow(h, q.body.enrollment.id)).toMatchObject({ state: 'paused', pause_reason: 'client_reply' });
  });

  it('R-LSRC-9 E729: an automated message already queued is blocked at dispatch with SOURCE_UNCLASSIFIED and its own sentence; a system message too; the database refuses a direct move to dispatching with the same code', async () => {
    const c = await ownedContact(agent);
    expect((await enroll(agent, c.id)).status).toBe(201);
    await runJobs(h, w.tenantId, ['playbook.step'], 3, ['default']); // the step queues its text; dispatch has not run
    const [queued] = await automated(c.id);
    expect(queued?.status).toBe('queued');
    await unreviewed(c.id);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, queued!.id);
    expect([m.status, m.status_reason]).toEqual(['blocked', SOURCE_UNCLASSIFIED]);
    const [dec] = await decisionsFor(h, { messageId: queued!.id });
    expect(dec!.reason_codes).toContain(SOURCE_UNCLASSIFIED);
    expect(dec!.reason_codes).not.toContain(SOURCE_NO_AUTOMATED_CONTACT);
    expectUnclassifiedWords(dec!.explanation);
    expect(h.providers.telephony.sms.filter((x) => x.to === c.phone && x.body.includes('checking in'))).toEqual([]);

    // a system message (a saved-search alert) queued for them
    const q = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'email', subject: 'Homes for you', body: 'Two homes match your search.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    expect(q.ok).toBe(true);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const alert = await messageRow(h, (q as { messageId: string }).messageId);
    expect([alert.status, alert.status_reason]).toEqual(['blocked', SOURCE_UNCLASSIFIED]);
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toEqual([]);

    // the database backstop, on the UPDATE that activates
    const q2 = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'email', subject: 'Homes for you', body: 'One more home.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    const moved = await withTenantTx(sys(), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${(q2 as { messageId: string }).messageId}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: unknown) => e);
    expect(sourceGuardViolation(moved)).toBe(SOURCE_UNCLASSIFIED);
  });

  it('R-LSRC-9 E731: a person\'s own one-to-one text, email and call still go; the STOP confirmation and the HELP reply the person asked for still go', async () => {
    const c = await ownedContact(agent);
    await unreviewed(c.id);
    const t = await sendText(agent, c.id, 'Hi Jane, this is Sam from the team. Do you have a minute today?');
    expect([t.status, t.body.result]).toEqual([200, 'sent']);
    const e = await sendText(agent, c.id, 'Hi Jane, following up on your question about the house.', { channel: 'email', subject: 'Your question' });
    expect([e.status, e.body.result]).toEqual([200, 'sent']);
    expect(h.providers.telephony.sms.filter((x) => x.to === c.phone)).toHaveLength(1);
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toHaveLength(1);
    const ch = await agent.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    const d = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect([d.status, d.body.result]).toEqual([200, 'dialing']);
    // the keyword replies are answers the person asked for, not outreach: exactly the marked-source exemption (a team
    // whose policy makes the platform the confirmation sender, as comms/inbound.test.ts path 8)
    const w2 = await commsWorld(h, { agents: 1 });
    expect((await call(w2.owner, 'POST', '/compliance-policies', { optOutConfirmationSender: 'platform', activate: true })).status).toBe(201);
    const k = await ownedContact(w2.agents[0]!);
    await importedPerson(h, w2.tenantId, w2.owner.userId!, k.id);
    expect((await inboundSms(h, k.phone, w2.mainNumber, 'HELP')).statusCode).toBe(200);
    await runJobs(h, w2.tenantId, ['comms.dispatch']);
    expect((await inboundSms(h, k.phone, w2.mainNumber, 'STOP')).statusCode).toBe(200);
    await runJobs(h, w2.tenantId, ['comms.dispatch']);
    const replies = (await messagesOf(h, k.id)).filter((x) => x.initiator === 'system');
    expect(replies.map((x) => `${x.action_category}:${x.status}`)).toEqual(['help_reply:sent', 'opt_out_confirmation:sent']);
    expect(h.providers.telephony.sms.filter((x) => x.to === k.phone)).toHaveLength(2);
    // and no wider: another system message to them is still refused
    const q = await withTenantTx(systemActor(w2.tenantId, 'worker'), (tx, now) => queueOutboundInTx(tx, w2.deps, { contactId: k.id, channel: 'email', subject: 'Homes for you', body: 'Two homes match your search.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    await runJobs(h, w2.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, (q as { messageId: string }).messageId)).status_reason).toBe(SOURCE_UNCLASSIFIED);
  });

  it('R-LSRC-9 E729: bulk enroll and bulk email leave them out and count them as SOURCE_UNCLASSIFIED, at the draft and again at the run; the finished title says "imported source not reviewed yet"', async () => {
    const [a, b, late] = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)];
    await unreviewed(a.id);
    const d = await draft(agent, { kind: 'enroll', selection: { contactIds: [a.id, b.id, late.id] }, playbookId: plan.id });
    expect(d.status).toBe(201);
    expect(d.body.action.preflight).toEqual({ [SOURCE_UNCLASSIFIED]: 1 });
    expect(d.body.action.targetCount).toBe(2);
    await unreviewed(late.id); // imported after the draft: the run leaves them out too
    expect((await confirm(agent, d.body.action.id)).status).toBe(200);
    await runBulkAction(d.body.action.id, w.deps, w.tenantId);
    expect((await itemsOf(h, d.body.action.id)).find((i) => i.contact_id === late.id)).toMatchObject({ status: 'skipped', reason_code: SOURCE_UNCLASSIFIED });
    expect((await enrollmentsOf(h, a.id)).length + (await enrollmentsOf(h, late.id)).length).toBe(0);
    expect((await enrollmentsOf(h, b.id)).map((e) => e.enrolled_by)).toEqual(['bulk']);

    const [x, y, z] = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)];
    await unreviewed(x.id);
    const tpl = (await call<{ template: { id: string } }>(agent, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `B ${randomUUID().slice(0, 6)}`, subject: 'For {{contact.first_name}}', body: 'Hi {{contact.first_name}}, new homes this week.' })).body.template.id;
    const m = await draft(agent, { kind: 'email', selection: { contactIds: [x.id, y.id, z.id] }, templateId: tpl });
    expect(m.body.action.preflight).toEqual({ [SOURCE_UNCLASSIFIED]: 1 });
    await unreviewed(z.id);
    await confirm(agent, m.body.action.id);
    await runBulkAction(m.body.action.id, w.deps, w.tenantId);
    expect((await itemsOf(h, m.body.action.id)).find((i) => i.contact_id === z.id)).toMatchObject({ status: 'skipped', reason_code: SOURCE_UNCLASSIFIED, message_id: null });
    expect(h.providers.email.sent.filter((e) => e.to === x.email || e.to === z.email)).toEqual([]);
    expect(h.providers.email.sent.filter((e) => e.to === y.email)).toHaveLength(1);
    const n = (await h.su.query<{ title: string }>("SELECT title FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [m.body.action.id])).rows[0]!;
    expect(n.title).toBe('Emailed 1 of 3: 2 imported source not reviewed yet');
  });
});
