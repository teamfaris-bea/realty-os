// b18 review B18S-5 (owner product boundary, 2026-11-14): a module 26 trigger message (a price drop, a home value, an
// anniversary, a deal date) is automated contact, so none goes to a person a lead source marked "No automated contact
// for leads from this source" sent: the firing is skipped with a visible reason (SOURCE_NO_AUTOMATED_CONTACT), never
// silently and never sent; a person from another source still gets theirs. A made-up source; fakes only.
// Round 3 item 3 (OQ-B18-S6): a draft a firing wrote for the owner to approve (the conversation was paused) stays
// automated. It is withdrawn when the setting is turned on, its card closes and its run says why; approving one for a
// covered person is refused with a sentence, and the database refuses its message too (0100).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, messagesOf, ownedContact } from '../assistant/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { freshReauth, inboundSms } from '../comms/testing.js';
import { AUTOMATED_DRAFT_REFUSAL, NO_AUTOMATED_CONTACT_LABEL, NO_AUTOMATED_CONTACT_SKIP_TEXT, SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, SOURCE_UNCLASSIFIED_SKIP_TEXT, UNCLASSIFIED_DRAFT_REFUSAL, UNCLASSIFIED_DRAFT_WITHDRAWN_EARLIER, isSourceGuardViolation } from '../leads/automatedContact.js';
import { importedPerson } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { type NurtureWorld, approveTemplate, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;
let marked: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'behavior_alerts');
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' })).body.source.id;
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

let n = 7700;
async function dropFor(contactId: string): Promise<void> {
  const k = (n += 1);
  const lid = await mlsRecord(h, w, k, { ListPrice: 500000 });
  await follow(h, w.tenantId, lid, contactId);
  await mlsRecord(h, w, k, { ListPrice: 460000 });
  await firingsDue(h, contactId);
}
const alerts = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');

describe('R-LSRC-8 B18S-5: no module 26 trigger message for a lead from a source marked "No automated contact"', () => {
  it('B18S-5 E727: a price-drop firing for such a person is skipped SOURCE_NO_AUTOMATED_CONTACT with a sentence and nothing is sent; another person gets the alert', async () => {
    const c = await ownedContact(w.agents[0]!);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [c.id, marked]);
    const plain = await ownedContact(w.agents[0]!);
    await dropFor(c.id);
    await dropFor(plain.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('skipped_ineligible');
    const skip = (run!.trigger_ref as { skip?: { reason: string; text: string } }).skip;
    expect(skip?.reason).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(skip?.text).toContain(NO_AUTOMATED_CONTACT_LABEL);
    expect((await alerts(plain.id)).map((m) => m.status)).toEqual(['sent']);
  });
});

/** A person whose conversation is paused (they wrote in), so a price-drop firing becomes a draft for the owner (R-NURT-5). */
async function triggerDraft(agent: TestClient): Promise<{ id: string; phone: string; draftId: string }> {
  const c = await ownedContact(agent);
  const k = (n += 1);
  await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
  expect((await inboundSms(h, c.phone, w.mainNumber, 'Still looking, thanks')).statusCode).toBe(200);
  await mlsRecord(h, w, k, { ListPrice: 460000 });
  await firingsDue(h, c.id);
  await reconcileAndRun(h, w.tenantId);
  const [run] = await triggerRuns(h, c.id);
  expect(run!.status).toBe('converted_to_draft');
  const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
  expect(d).toMatchObject({ kind: 'message_draft', autonomy: 'requires_approval', status: 'proposed' });
  expect((await h.su.query<{ k: string }>("SELECT trigger_ref->>'kind' AS k FROM assistant_actions WHERE id = $1", [d.id])).rows[0]!.k).toBe('trigger_run');
  return { id: c.id, phone: c.phone, draftId: d.id };
}
const fromSource = (contactId: string, sourceId: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, sourceId]);
const draftRow = async (id: string) => (await h.su.query<{ status: string; payload: Record<string, unknown> }>('SELECT status, payload FROM assistant_actions WHERE id = $1', [id])).rows[0]!;
const cardStates = async (actionId: string) => (await h.su.query<{ state: string }>('SELECT state FROM priority_feed_items WHERE assistant_action_id = $1', [actionId])).rows.map((r) => r.state);
const approve = (c: TestClient, actionId: string) => call<{ result: string }>(c, 'POST', `/assistant/actions/${actionId}/approve`, { commandId: randomUUID() });
type Runs = { runs: { status: string; skip: { reason: string; text: string } | null; assistantActionId: string | null }[] };

describe('R-LSRC-8 B18S-5 round 3 item 3: a module 26 trigger draft made before the mark does not outlive it', () => {
  it('E727 OQ-B18-S6: turning the setting on withdraws the pending trigger draft of that source\'s person, closes its card and marks its run skipped with the reason (never "drafted: it waits"); another person keeps theirs', async () => {
    const agent = w.agents[0]!;
    const a = await triggerDraft(agent);
    const b = await triggerDraft(agent);
    const late = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'LeadRouter (test)', kind: 'portal' })).body.source.id;
    await fromSource(a.id, late);
    await freshReauth(h, w.owner);
    const on = await call<{ withdrawn: number }>(w.owner, 'PUT', `/lead-sources/${late}/ai-care`, { noAiCare: true });
    expect([on.status, on.body.withdrawn]).toEqual([200, 1]);
    expect(await draftRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    const [run] = await triggerRuns(h, a.id);
    expect(run).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: { reason: SOURCE_NO_AUTOMATED_CONTACT, text: NO_AUTOMATED_CONTACT_SKIP_TEXT } }) });
    // the person's alert history says why, in the setting's words
    const shown = await call<Runs>(agent, 'GET', `/contacts/${a.id}/trigger-runs`);
    expect(shown.body.runs.map((r) => [r.status, r.skip?.reason, r.skip?.text])).toEqual([['skipped_ineligible', SOURCE_NO_AUTOMATED_CONTACT, NO_AUTOMATED_CONTACT_SKIP_TEXT]]);
    expect(NO_AUTOMATED_CONTACT_SKIP_TEXT).toContain(NO_AUTOMATED_CONTACT_LABEL);
    // the other person's draft and run are untouched
    expect((await draftRow(b.draftId)).status).toBe('proposed');
    expect(await cardStates(b.draftId)).toEqual(['open']);
    expect((await triggerRuns(h, b.id))[0]!.status).toBe('converted_to_draft');
    expect(await alerts(a.id)).toEqual([]);
  });

  it('E727 OQ-B18-S6: approving a trigger draft for a person who has since become covered is refused 409 SOURCE_NO_AUTOMATED_CONTACT with the sentence; the draft is withdrawn, its run says why and nothing is sent; an uncovered person\'s draft is not refused for the source', async () => {
    const agent = w.agents[0]!;
    const a = await triggerDraft(agent);
    const b = await triggerDraft(agent);
    await fromSource(a.id, marked);
    const tap = await approve(agent, a.draftId);
    expect([tap.status, tap.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
    expect((tap.body as unknown as { error: { details: { reason: string; sentence: string } } }).error.details).toMatchObject({ reason: 'source_no_automated_contact', sentence: AUTOMATED_DRAFT_REFUSAL });
    expect(await draftRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_NO_AUTOMATED_CONTACT } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    expect((await triggerRuns(h, a.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: SOURCE_NO_AUTOMATED_CONTACT }) }) });
    expect(await alerts(a.id)).toEqual([]);
    expect(h.providers.telephony.sms.filter((x) => x.to === a.phone)).toEqual([]);
    const ok = await approve(agent, b.draftId);
    expect(ok.code).not.toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(ok.status).toBe(200);
    expect((await draftRow(b.draftId)).status).not.toBe('invalidated');
  });

  it('E727 0100: the database refuses the message of an approved plan-step or trigger draft moved to dispatching for such a person (app.messages_source_guard), and lets an approved reply draft through', async () => {
    const agent = w.agents[0]!;
    const a = await triggerDraft(agent);
    const queued = async (actionId: string, key: string) => {
      const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: a.id, channel: 'sms', body: 'A home you follow dropped in price.', initiator: 'assistant', purpose: 'informational', category: 'search_alert' as never, assistantActionId: actionId, idempotencyKey: key }, now), { db: h.database });
      expect(q.ok).toBe(true);
      return (q as { messageId: string }).messageId;
    };
    // the tap (the agent, as themselves), then the source turns out to have sent them
    await withTenantTx(agent.actor(), (tx) => sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now() WHERE tenant_id = app.tenant_id() AND id = ${a.draftId}::uuid`.execute(tx), { db: h.database });
    const m = await queued(a.draftId, `assistant-approve:${a.draftId}`);
    await fromSource(a.id, marked);
    const move = (id: string) => withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: unknown) => e);
    expect(isSourceGuardViolation(await move(m))).toBe(true);
    // a reply the assistant drafted to the person's own message (trigger_ref.kind 'inbound'), approved by a person, still passes
    const reply = randomUUID();
    await h.su.query(
      "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref, decided_by_user_id, decided_at, decided_by_role) VALUES ($1,$2,$3,'message_draft','novel_message','requires_approval','approved',$4,'A reply to their message.','{}'::jsonb,'{\"kind\":\"inbound\"}'::jsonb,$4,now(),'agent')",
      [w.tenantId, reply, a.id, agent.userId],
    );
    expect(await move(await queued(reply, `assistant-approve:${reply}`))).toBeNull();
  });
});

describe('R-LSRC-9 A2 A3: no module 26 trigger message, and no trigger draft, for an imported person whose source is not reviewed yet (owner decision 2026-11-14)', () => {
  it('R-LSRC-9 E729: a price-drop firing for such a person is skipped SOURCE_UNCLASSIFIED with its own sentence (the imported source has not been reviewed yet; never the setting\'s words) and nothing is sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    await dropFor(c.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('skipped_ineligible');
    const skip = (run!.trigger_ref as { skip?: { reason: string; text: string } }).skip;
    expect(skip).toEqual({ reason: SOURCE_UNCLASSIFIED, text: SOURCE_UNCLASSIFIED_SKIP_TEXT });
    expect(SOURCE_UNCLASSIFIED_SKIP_TEXT).toMatch(/imported source has not been reviewed yet \(an Owner reviews it under Lead sources\)/);
    expect(SOURCE_UNCLASSIFIED_SKIP_TEXT).not.toContain(NO_AUTOMATED_CONTACT_LABEL);
    const shown = await call<Runs>(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(shown.body.runs.map((r) => [r.status, r.skip?.reason, r.skip?.text])).toEqual([['skipped_ineligible', SOURCE_UNCLASSIFIED, SOURCE_UNCLASSIFIED_SKIP_TEXT]]);
  });

  it('R-LSRC-9 E729 E733: approving a trigger draft for a person since imported and not reviewed is refused 409 SOURCE_UNCLASSIFIED with its own sentence; the draft is withdrawn for that reason and nothing is sent; once the Owner maps the label the late tap still says it was withdrawn, and why', async () => {
    const agent = w.agents[0]!;
    const a = await triggerDraft(agent);
    const { label } = await importedPerson(h, w.tenantId, w.owner.userId!, a.id);
    const tap = await approve(agent, a.draftId);
    expect([tap.status, tap.code]).toEqual([409, SOURCE_UNCLASSIFIED]);
    expect((tap.body as unknown as { error: { details: { reason: string; sentence: string } } }).error.details).toMatchObject({ reason: 'source_unclassified', sentence: UNCLASSIFIED_DRAFT_REFUSAL });
    expect(UNCLASSIFIED_DRAFT_REFUSAL).toMatch(/imported source has not been reviewed yet/);
    expect(UNCLASSIFIED_DRAFT_REFUSAL).toMatch(/withdrawn and nothing was sent/);
    expect(UNCLASSIFIED_DRAFT_REFUSAL).not.toContain(NO_AUTOMATED_CONTACT_LABEL);
    expect(await draftRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_UNCLASSIFIED } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    expect((await triggerRuns(h, a.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: { reason: SOURCE_UNCLASSIFIED, text: SOURCE_UNCLASSIFIED_SKIP_TEXT } }) });
    expect(await alerts(a.id)).toEqual([]);
    expect(h.providers.telephony.sms.filter((x) => x.to === a.phone)).toEqual([]);
    // the Owner reviews the source (an unmarked one): the person is no longer refused, the draft stays withdrawn
    const plain = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'referral' })).body.source.id;
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId: plain })).status).toBe(200);
    const late = await approve(agent, a.draftId);
    expect([late.status, late.code]).toEqual([409, SOURCE_UNCLASSIFIED]);
    expect((late.body as unknown as { error: { details: { sentence: string } } }).error.details.sentence).toBe(UNCLASSIFIED_DRAFT_WITHDRAWN_EARLIER);
    expect(UNCLASSIFIED_DRAFT_WITHDRAWN_EARLIER).not.toContain(NO_AUTOMATED_CONTACT_LABEL);
  });
});
