// b18 round 3 item 3 (owner boundary B18S-5; R-LSRC-8, E727, OQ-B18-S6): a draft a plan step wrote stays automated
// even when a person taps it. A draft made before the person's lead source was marked "No automated contact for leads
// from this source" does not outlive the mark:
//   - turning the setting on withdraws the pending plan-step drafts of the source's people and closes their cards;
//   - a plan the step runner stops for the source withdraws them too;
//   - a marked source sending the person again withdraws them (at intake, in the inquiry's transaction);
//   - approving one for a covered person is refused 409 SOURCE_NO_AUTOMATED_CONTACT with an honest sentence, and
//     one approved before the mark and still queued is blocked at dispatch.
// A person's own one-to-one text still goes. Made-up sources; fakes only; no partner is named.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApprovedPlaybook, actionsOf, appointment, approvedPlaybook, enrollmentRow, messagesOf, runJobs, smsStep, stepNow } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, type TestContact, call, commsWorld, decisionsFor, freshReauth, messageRow, ownedContact, sendText } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { AUTOMATED_DRAFT_REFUSAL, NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT, withdrawnDraftsSentence } from './automatedContact.js';
import { postIntake } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let marked: { id: string; token: string };
let confirmPlan: ApprovedPlaybook;
let twoStep: ApprovedPlaybook;

const MONEY_PLACE = 'our office to go over your offer';

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  agent = w.agents[0]!;
  const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'portal' });
  marked = { id: src.body.source.id, token: src.body.ingestToken };
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  // a one-step plan whose text names the meeting place: a place that mentions an offer makes the step a draft (E35)
  confirmPlan = await approvedPlaybook(w.owner, {
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Confirm (test)',
    steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, you are set for {{appointment_time}} at {{appointment_place}}. Reply here to change it.', slots: ['first_name', 'appointment_time', 'appointment_place'] })],
  });
  // the same first step, then a reminder a day later: the plan is still running while the first step's draft waits
  twoStep = await approvedPlaybook(w.owner, {
    kind: 'reminder',
    scope: 'team',
    name: 'Confirm, then remind (test)',
    steps: [
      smsStep({ key: 'place', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a reminder: we meet at {{appointment_place}}. Reply here to change it.', slots: ['first_name', 'appointment_place'] }),
      smsStep({ key: 'later', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a quick reminder from us about tomorrow.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** fixture only: the person came from the source (the intake writes original_lead_source_id; the test sets it) */
const fromSource = (contactId: string, sourceId: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, sourceId]);
const newSource = async (name: string) => (await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind: 'portal' })).body;
const turnOn = async (sourceId: string) => {
  await freshReauth(h, w.owner);
  return call<{ pausing: number; stopping: number; withdrawn: number }>(w.owner, 'PUT', `/lead-sources/${sourceId}/ai-care`, { noAiCare: true });
};
const approve = (c: TestClient, actionId: string, body: Record<string, unknown> = {}) =>
  call<{ result: string; messageId: string | null }>(c, 'POST', `/assistant/actions/${actionId}/approve`, { commandId: randomUUID(), ...body });
/** a refusal's details (the error body: { error: { code, details } }) */
const detailsOf = (r: { body: unknown }) => (r.body as { error?: { details?: Record<string, unknown> } }).error?.details ?? null;
const actionRow = async (id: string) => (await h.su.query<{ status: string; payload: Record<string, unknown> }>('SELECT status, payload FROM assistant_actions WHERE id = $1', [id])).rows[0]!;
const cardStates = async (actionId: string) => (await h.su.query<{ state: string }>('SELECT state FROM priority_feed_items WHERE assistant_action_id = $1', [actionId])).rows.map((r) => r.state);
const automated = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.initiator !== 'human');

/** A person with a pending draft a plan step wrote (the step named a place that mentions an offer). */
async function planDraft(plan: ApprovedPlaybook = confirmPlan): Promise<{ c: TestContact; enrollmentId: string; draftId: string }> {
  const c = await ownedContact(agent);
  const appt = await appointment(h, w, c.id, agent.userId!, { location: MONEY_PLACE });
  const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: plan.playbookId, anchor: { kind: 'appointment', id: appt } });
  expect(e.status).toBe(201);
  await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
  const d = (await actionsOf(h, c.id)).find((x) => x.kind === 'message_draft')!;
  expect(d).toMatchObject({ autonomy: 'requires_approval', status: 'proposed', owner_user_id: agent.userId });
  expect((await h.su.query<{ k: string }>("SELECT trigger_ref->>'kind' AS k FROM assistant_actions WHERE id = $1", [d.id])).rows[0]!.k).toBe('playbook_step');
  expect(await cardStates(d.id)).toEqual(['open']);
  expect(await automated(c.id)).toEqual([]);
  return { c, enrollmentId: e.body.enrollment.id, draftId: d.id };
}

describe('R-LSRC-8 B18S-5 round 3 item 3: a plan-step draft made before the mark does not outlive it', () => {
  it('E727 OQ-B18-S6: turning the setting on withdraws the pending plan-step drafts of that source\'s people and closes their cards; the answer counts them; another source\'s person keeps theirs and it still sends on a tap; a late tap on a withdrawn draft says why', async () => {
    const late = await newSource('LeadRouter (test)');
    const a = await planDraft();
    const b = await planDraft();
    await fromSource(a.c.id, late.source.id);
    const on = await turnOn(late.source.id);
    expect(on.status).toBe(200);
    expect(on.body.withdrawn).toBe(1);
    expect(withdrawnDraftsSentence(1)).toBe('1 draft a plan or an alert wrote for them was withdrawn.');
    expect(withdrawnDraftsSentence(3)).toBe('3 drafts a plan or an alert wrote for them were withdrawn.');
    expect(await actionRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    expect((await actionRow(b.draftId)).status).toBe('proposed');
    expect(await cardStates(b.draftId)).toEqual(['open']);
    // the agent's inbox no longer offers the withdrawn draft; the other is still there
    const inbox = await call<{ items: { id: string }[] }>(agent, 'GET', '/assistant/inbox');
    expect(inbox.body.items.map((i) => i.id)).not.toContain(a.draftId);
    expect(inbox.body.items.map((i) => i.id)).toContain(b.draftId);
    // a tap from a screen opened before the mark: refused with the reason, nothing sent
    const tap = await approve(agent, a.draftId);
    expect([tap.status, tap.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    expect(detailsOf(tap)).toMatchObject({ reason: 'source_no_automated_contact', sentence: AUTOMATED_DRAFT_REFUSAL });
    expect(AUTOMATED_DRAFT_REFUSAL).toBe(`This draft was written by a plan or an alert, and "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting), so it was withdrawn and nothing was sent. Call, text or email them one to one.`);
    expect(await messagesOf(h, a.c.id)).toEqual([]);
    expect(h.providers.telephony.sms.filter((x) => x.to === a.c.phone)).toEqual([]);
    // turning it on again withdraws nothing more
    expect((await turnOn(late.source.id)).body.withdrawn).toBe(0);
    // control: the other person's draft sends on a tap, as before
    const ok = await approve(agent, b.draftId);
    expect([ok.status, ok.body.result]).toEqual([200, 'sent']);
  });

  it('E727 OQ-B18-S6: approving a plan-step draft for a person who has since become covered is refused 409 SOURCE_NO_AUTOMATED_CONTACT with the sentence, as written or edited; the draft is withdrawn, its card closes and nothing is sent; the person\'s own text still goes', async () => {
    const a = await planDraft();
    await fromSource(a.c.id, marked.id); // the marked source turns out to have sent them: no route ran, the draft is still open
    expect((await actionRow(a.draftId)).status).toBe('proposed');
    const tap = await approve(agent, a.draftId);
    expect([tap.status, tap.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    expect(detailsOf(tap)).toMatchObject({ reason: 'source_no_automated_contact', sentence: AUTOMATED_DRAFT_REFUSAL });
    expect(await actionRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    // the same answer again, and for an edited body: never DRAFT_INVALIDATED's "the lead's owner changed"
    const again = await approve(agent, a.draftId, { editedPayload: { body: 'Hi Jane, see you at our office.' } });
    expect([again.status, again.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    expect(await messagesOf(h, a.c.id)).toEqual([]);
    expect(h.providers.telephony.sms.filter((x) => x.to === a.c.phone)).toEqual([]);
    // a person on the team may still text them one to one
    const own = await sendText(agent, a.c.id, 'Hi Jane, this is Sam. See you at our office on Thursday.');
    expect([own.status, own.body.result]).toEqual([200, 'sent']);
  });

  it('E727: a plan the step runner stops for the source (stop_reason source_no_automated_contact) withdraws the draft its earlier step wrote and closes the card', async () => {
    const a = await planDraft(twoStep);
    expect(await enrollmentRow(h, a.enrollmentId)).toMatchObject({ state: 'active' });
    await fromSource(a.c.id, marked.id);
    await stepNow(h, w.tenantId, a.enrollmentId);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h, a.enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    expect(await actionRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    expect(await automated(a.c.id)).toEqual([]);
  });

  it('E727: a marked source sending the person again withdraws their pending plan-step draft at intake (the inquiry\'s own transaction), and no instant reply goes', async () => {
    const a = await planDraft();
    const again = await postIntake(h, marked.token, { inquiryType: 'buy', fullName: 'Jane Doe', phones: [a.c.phone], emails: [a.c.email] });
    expect([200, 201]).toContain(again.statusCode);
    expect((JSON.parse(again.body) as { contactId: string }).contactId).toBe(a.c.id);
    // withdrawn before any job runs
    expect((await actionRow(a.draftId)).status).toBe('invalidated');
    await runJobs(h, w.tenantId, ['assistant.first_response', 'comms.dispatch']);
    expect(await actionRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    expect(await automated(a.c.id)).toEqual([]);
  });

  it('E727: a plan-step draft a person approved before the mark, whose message is still queued when the source is marked, is blocked at dispatch SOURCE_NO_AUTOMATED_CONTACT with the sentence; for another person it goes', async () => {
    const queuedApproval = async (x: { c: TestContact; draftId: string }) => {
      // the tap (the agent, as themselves) and the queue transaction (the system), without the dispatch that follows them
      await withTenantTx(agent.actor(), (tx) => sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now() WHERE tenant_id = app.tenant_id() AND id = ${x.draftId}::uuid`.execute(tx), { db: h.database });
      const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: x.c.id, channel: 'sms', body: 'Hi Jane, you are set for Thursday at our office to go over your offer.', initiator: 'assistant', purpose: 'informational', category: 'money' as never, assistantActionId: x.draftId, idempotencyKey: `assistant-approve:${x.draftId}` }, now), { db: h.database });
      expect(q.ok).toBe(true);
      return (q as { messageId: string }).messageId;
    };
    const a = await planDraft();
    const b = await planDraft();
    const ma = await queuedApproval(a);
    const mb = await queuedApproval(b);
    await fromSource(a.c.id, marked.id);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, ma);
    expect([m.status, m.status_reason]).toEqual(['blocked', SOURCE_NO_AUTOMATED_CONTACT]);
    const [dec] = await decisionsFor(h, { messageId: ma });
    expect(dec!.reason_codes).toContain(SOURCE_NO_AUTOMATED_CONTACT);
    expect(dec!.explanation).toContain(NO_AUTOMATED_CONTACT_LABEL);
    expect(h.providers.telephony.sms.filter((x) => x.to === a.c.phone)).toEqual([]);
    expect((await messageRow(h, mb)).status).toBe('sent');
  });
});
