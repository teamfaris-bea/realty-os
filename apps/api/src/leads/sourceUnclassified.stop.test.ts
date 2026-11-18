// R-LSRC-9 A4 (owner decision 2026-11-14; migration 0101): becoming unclassified stops things at once, from the API, in
// the request's own transaction and in bounded work. A mapping removed: that label's people only have their running
// plans asked for a step (which stops them, due or not), their live AI care asked for a turn (isa/sourceNoAiCare.test.ts)
// and their pending plan or alert drafts withdrawn, with the reason; the audit row counts what was asked. Classified to
// an unmarked source: the refusal lifts. Classified to a marked source: refused for that reason. In both directions, the
// list tells the truth after every change. An import's no-label group is one row, classified per import, mappable like
// a label. A dry run changes nothing for anyone; only the commit does. Made-up labels and sources; fakes only.
import { createHash, randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApprovedPlaybook, actionsOf, appointment, approvedPlaybook, enrollmentRow, messagesOf, runJobs, smsStep } from '../assistant/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type CommsWorld, type TestContact, commsWorld, ownedContact } from '../comms/testing.js';
import { type ImportsHarness, approve as approveStage, batchOf, call, commitStage, csvBase64, dryRunStage, freshReauth, importsHarness, records, verify } from '../imports/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, noAutomatedContact } from './automatedContact.js';
import { importedPerson } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let agent: TestClient;
let admin: TestClient;
let plain: { id: string; name: string };
let marked: { id: string; name: string };
let twoStep: ApprovedPlaybook;

const MONEY_PLACE = 'our office to go over your offer';
const h = () => ih.h;

interface LabelRow {
  label: string;
  people: number;
  leadSourceId: string | null;
  leadSourceName: string | null;
  noAutomatedContact: boolean;
  inReview: boolean;
  unlabeledImportId: string | null;
  sentence: string;
}
type Mapped = { label: LabelRow; pausing: number; stopping: number; withdrawn: number };

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 2, others: ['admin'] });
  agent = w.agents[0]!;
  admin = w.others[0]!;
  await freshReauth(h(), w.owner);
  plain = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'referral' })).body.source;
  marked = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (test)', kind: 'referral' })).body.source;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  // a reminder whose first step names a place that mentions an offer (so it becomes a draft for the owner, E35), then
  // a second step a day later: the plan is still running, and its first step's draft waits
  twoStep = await approvedPlaybook(w.owner, {
    kind: 'reminder',
    scope: 'team',
    name: 'Confirm, then remind (test)',
    steps: [
      smsStep({ key: 'place', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a reminder: we meet at {{appointment_place}}. Reply here to change it.', slots: ['first_name', 'appointment_place'] }),
      smsStep({ key: 'later', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a quick reminder from us about tomorrow.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
}, 300_000);
afterAll(async () => {
  await ih?.close();
});

const put = async (c: TestClient, body: Record<string, unknown>) => {
  await freshReauth(h(), c);
  return call<Mapped>(c, 'PUT', '/lead-sources/import-labels', body);
};
const mapLabel = (label: string, leadSourceId: string | null) => put(w.owner, { label, leadSourceId });
const refusalOf = (contactId: string) => withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => noAutomatedContact(tx, contactId), { db: h().database });
const enroll = (contactId: string, o: { anchor?: unknown } = {}) => call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: twoStep.playbookId, ...(o.anchor ? { anchor: o.anchor } : {}) });
const actionRow = async (id: string) => (await h().su.query<{ status: string; payload: Record<string, unknown> }>('SELECT status, payload FROM assistant_actions WHERE id = $1', [id])).rows[0]!;
const cardStates = async (actionId: string) => (await h().su.query<{ state: string }>('SELECT state FROM priority_feed_items WHERE assistant_action_id = $1', [actionId])).rows.map((r) => r.state);
const listRow = async (label: string) => (await call<{ labels: LabelRow[] }>(w.owner, 'GET', '/lead-sources/import-labels')).body.labels.find((l) => l.label === label);
const lastAudit = async (reason: string) => (await h().su.query<{ changes: Record<string, { to: unknown }>; actor_user_id: string | null; occurred_at: Date }>('SELECT changes, actor_user_id, occurred_at FROM audit_log WHERE tenant_id = $1 AND reason = $2 ORDER BY seq DESC LIMIT 1', [w.tenantId, reason])).rows[0];

/** A person in the two-step plan: its first step's draft waits for the owner, its second step is due tomorrow. */
async function running(): Promise<{ c: TestContact; enrollmentId: string; draftId: string }> {
  const c = await ownedContact(agent);
  const appt = await appointment(h(), w, c.id, agent.userId!, { location: MONEY_PLACE });
  const e = await enroll(c.id, { anchor: { kind: 'appointment', id: appt } });
  expect(e.status).toBe(201);
  await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
  const d = (await actionsOf(h(), c.id)).find((x) => x.kind === 'message_draft')!;
  expect(d).toMatchObject({ autonomy: 'requires_approval', status: 'proposed' });
  expect((await enrollmentRow(h(), e.body.enrollment.id)).state).toBe('active');
  return { c, enrollmentId: e.body.enrollment.id, draftId: d.id };
}

describe('R-LSRC-9 A4: a mapping change makes the people\'s state follow it at once, in both directions', () => {
  it('R-LSRC-9 E732: removing a mapping stops that label\'s running plan at once (its next step is a day away), withdraws its pending draft with the reason, counts both in the answer and the audit, and touches nobody of another label; the list says "not reviewed yet"', async () => {
    const a = await running();
    const b = await running();
    const la = (await importedPerson(h(), w.tenantId, w.owner.userId!, a.c.id, { label: `Northgate label ${randomUUID().slice(0, 6)} (test)` })).label!;
    const lb = (await importedPerson(h(), w.tenantId, w.owner.userId!, b.c.id, { label: `Hillside label ${randomUUID().slice(0, 6)} (test)` })).label!;
    // the Owner reviews both labels (an unmarked source): nothing is refused, nothing is stopped
    const ma = await mapLabel(la, plain.id);
    expect([ma.status, ma.body.stopping, ma.body.withdrawn, ma.body.pausing]).toEqual([200, 0, 0, 0]);
    expect(ma.body.label).toMatchObject({ label: la, people: 1, leadSourceId: plain.id, inReview: false, noAutomatedContact: false, unlabeledImportId: null });
    expect((await mapLabel(lb, plain.id)).status).toBe(200);
    expect(await refusalOf(a.c.id)).toBeNull();
    expect((await enrollmentRow(h(), a.enrollmentId)).state).toBe('active');
    expect((await actionRow(a.draftId)).status).toBe('proposed');

    // the Owner removes the first label's mapping
    const off = await mapLabel(la, null);
    expect(off.status).toBe(200);
    expect([off.body.stopping, off.body.withdrawn, off.body.pausing]).toEqual([1, 1, 0]);
    expect(off.body.label).toMatchObject({ label: la, people: 1, leadSourceId: null, leadSourceName: null, inReview: true, noAutomatedContact: false });
    expect(off.body.label.sentence).toBe(`"${la}" (1 person): not reviewed yet. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.`);
    expect(await listRow(la)).toMatchObject({ inReview: true, leadSourceId: null });
    expect(await refusalOf(a.c.id)).toBe(SOURCE_UNCLASSIFIED);
    // in the request's own transaction: the draft is withdrawn for that reason and its card closed
    expect(await actionRow(a.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_UNCLASSIFIED } } });
    expect(await cardStates(a.draftId)).toEqual(['done']);
    // at once: the step the request asked for stops the plan, though its next step is not due until tomorrow
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    const row = await enrollmentRow(h(), a.enrollmentId);
    expect(row).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    expect((await messagesOf(h(), a.c.id)).filter((m) => m.initiator !== 'human')).toEqual([]);
    // the other label's person: untouched
    expect(await refusalOf(b.c.id)).toBeNull();
    expect(await enrollmentRow(h(), b.enrollmentId)).toMatchObject({ state: 'active', stop_reason: null });
    expect((await actionRow(b.draftId)).status).toBe('proposed');
    expect(await cardStates(b.draftId)).toEqual(['open']);
    // the audit: who, when, which sources, the label and its digest, and what was asked to stop (R-LSRC-10 M3: the
    // label is named in its audit row, classified plain on purpose; the digest names it exactly)
    const au = (await lastAudit('LEAD_SOURCE_IMPORT_LABEL_UNMAPPED'))!;
    expect(au.actor_user_id).toBe(w.owner.userId);
    expect(au.changes).toMatchObject({
      fromLeadSourceIds: { to: [plain.id] },
      plansStoppingCount: { to: 1 },
      draftsWithdrawnCount: { to: 1 },
      aiCarePausingCount: { to: 0 },
    });
    expect(au.changes['labelSha256']!.to).toBe(createHash('sha256').update(la, 'utf8').digest('hex'));
    expect(au.changes['importLabel']).toEqual({ from: null, to: la });
    expect(au.changes).not.toHaveProperty('label'); // never under a key the redaction would not know
    expect(au.changes).not.toHaveProperty('toLeadSourceId'); // removed: no source holds it now
  });

  it('R-LSRC-9 E735 (A5): for people already imported before the rule (a plan and a draft still there, a label nobody ever mapped), the Owner\'s next act on that label stops what is still running, though no mapping changes; the audit names the team, not a source', async () => {
    const a = await running(); // the plan and its draft exist; then the fixture makes them an already-imported person
    const label = (await importedPerson(h(), w.tenantId, w.owner.userId!, a.c.id, { label: `Old label ${randomUUID().slice(0, 6)} (test)` })).label!;
    expect(await refusalOf(a.c.id)).toBe(SOURCE_UNCLASSIFIED); // the refusals already hold
    expect((await enrollmentRow(h(), a.enrollmentId)).state).toBe('active'); // nothing has stopped it yet
    const r = await mapLabel(label, null); // "not mapped" confirmed: nothing to remove
    expect([r.status, r.body.stopping, r.body.withdrawn]).toEqual([200, 1, 1]);
    expect(r.body.label).toMatchObject({ label, inReview: true, leadSourceId: null });
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), a.enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    const au = (await h().su.query<{ entity_type: string; entity_id: string; changes: Record<string, { to: unknown }> }>("SELECT entity_type, entity_id, changes FROM audit_log WHERE tenant_id = $1 AND reason = 'LEAD_SOURCE_IMPORT_LABEL_UNMAPPED' ORDER BY seq DESC LIMIT 1", [w.tenantId])).rows[0]!;
    expect([au.entity_type, au.entity_id]).toEqual(['tenant', w.tenantId]);
    expect(au.changes).toMatchObject({ plansStoppingCount: { to: 1 }, draftsWithdrawnCount: { to: 1 } });
  });

  it('R-LSRC-9 E733: marked to unmarked and back: a label mapped to a marked source refuses its people for THAT reason; moved to an unmarked source the refusal lifts and the list says so; moved back it is refused again', async () => {
    const c = await ownedContact(agent);
    const label = (await importedPerson(h(), w.tenantId, w.owner.userId!, c.id, { label: `Moved label ${randomUUID().slice(0, 6)} (test)` })).label!;
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);
    const toMarked = await mapLabel(label, marked.id);
    expect(toMarked.body.label).toMatchObject({ leadSourceId: marked.id, noAutomatedContact: true, inReview: false });
    expect(toMarked.body.label.sentence).toBe(`"${label}" (1 person): mapped to ${marked.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches the people imported with it.`);
    expect(await refusalOf(c.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect((await enroll(c.id)).code).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    // a wrong pick is undone by moving the label: the people follow the current mapping
    const toPlain = await mapLabel(label, plain.id);
    expect(toPlain.body.label).toMatchObject({ leadSourceId: plain.id, leadSourceName: plain.name, noAutomatedContact: false, inReview: false });
    expect(toPlain.body.label.sentence).toBe(`"${label}" (1 person): mapped to ${plain.name}.`);
    expect(await listRow(label)).toMatchObject({ leadSourceId: plain.id, noAutomatedContact: false, inReview: false });
    expect(await refusalOf(c.id)).toBeNull();
    const e = await enroll(c.id);
    expect(e.status).toBe(201);
    // and back: the running plan is stopped for the marked source's reason
    const back = await mapLabel(label, marked.id);
    expect([back.status, back.body.stopping]).toEqual([200, 1]);
    expect(await refusalOf(c.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    // a move has its own audit reason (R-LSRC-10 M3: mapped, re-mapped and un-mapped are told apart)
    expect((await lastAudit('LEAD_SOURCE_IMPORT_LABEL_REMAPPED'))!.changes).toMatchObject({ fromLeadSourceIds: { to: [plain.id] }, toLeadSourceId: { to: marked.id }, plansStoppingCount: { to: 1 }, importLabel: { to: label } });
  });

  it('R-LSRC-9 E734: people imported with NO label are one row per import, classified by the Owner like a label ({ unlabeledImportId }): the Owner only; classified, the refusal lifts for that import\'s people and not another import\'s; removed, their running plan stops; a marked source keeps them refused for that reason', async () => {
    const c = await ownedContact(agent);
    const d = await ownedContact(agent);
    const first = await importedPerson(h(), w.tenantId, w.owner.userId!, c.id, { label: null });
    const second = await importedPerson(h(), w.tenantId, w.owner.userId!, d.id, { label: null });
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);
    expect(await refusalOf(d.id)).toBe(SOURCE_UNCLASSIFIED);
    // only the Owner (the Admin who runs imports gets 404), only this tenant's import, and never a blank label
    expect((await put(admin, { unlabeledImportId: first.batchId, leadSourceId: plain.id })).status).toBe(404);
    expect((await put(w.owner, { unlabeledImportId: randomUUID(), leadSourceId: plain.id })).status).toBe(404);
    expect((await put(w.owner, { label: '', leadSourceId: plain.id })).status).toBe(422);
    expect((await put(w.owner, { label: 'x', unlabeledImportId: first.batchId, leadSourceId: plain.id })).status).toBe(422);
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);

    const on = await put(w.owner, { unlabeledImportId: first.batchId, leadSourceId: plain.id });
    expect(on.status).toBe(200);
    expect(on.body.label).toMatchObject({ label: '', unlabeledImportId: first.batchId, people: 1, leadSourceId: plain.id, leadSourceName: plain.name, inReview: false, noAutomatedContact: false });
    expect(on.body.label.sentence).toBe(`No source label in one file import (1 person): counted as ${plain.name}.`);
    expect(await refusalOf(c.id)).toBeNull();
    expect(await refusalOf(d.id)).toBe(SOURCE_UNCLASSIFIED); // another import's no-label group is its own
    const e = await enroll(c.id);
    expect(e.status).toBe(201);
    expect((await lastAudit('LEAD_SOURCE_IMPORT_UNLABELED_MAPPED'))!.changes).toMatchObject({ importBatchId: { to: first.batchId }, toLeadSourceId: { to: plain.id } });

    const off = await put(w.owner, { unlabeledImportId: first.batchId, leadSourceId: null });
    expect([off.status, off.body.stopping]).toEqual([200, 1]);
    expect(off.body.label).toMatchObject({ unlabeledImportId: first.batchId, leadSourceId: null, inReview: true });
    expect(off.body.label.sentence).toBe('No source label in one file import (1 person): not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.');
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });

    const toMarked = await put(w.owner, { unlabeledImportId: second.batchId, leadSourceId: marked.id });
    expect(toMarked.body.label).toMatchObject({ unlabeledImportId: second.batchId, leadSourceId: marked.id, noAutomatedContact: true, inReview: false });
    expect(await refusalOf(d.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
  });
});

describe('R-LSRC-9 A4: only a committed import makes anyone unclassified; the commit stops what was running, the preview nothing', () => {
  it('R-LSRC-9 E735: a dry run that matches a person already here changes nothing for them (no refusal, plan running, draft pending, no audit); the commit that attaches the record makes them unclassified and stops their plan and withdraws their draft, counted in the audit; a person whose label the Owner already mapped keeps their plan', async () => {
    const hit = await running();
    const kept = await running();
    const known = `Known label ${randomUUID().slice(0, 6)} (test)`;
    const fresh = `New label ${randomUUID().slice(0, 6)} (test)`;
    expect((await mapLabel(known, plain.id)).status).toBe(200); // reviewed before the import: an exact known label
    const csv = `First Name,Last Name,Mobile Phone,Email,Source\nJane,Doe,${hit.c.phone},${hit.c.email},"${fresh}"\nJane,Doe,${kept.c.phone},${kept.c.email},"${known}"\n`;
    const up = await call<{ batch: { id: string } }>(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'matched.csv', fileBase64: csvBase64(csv) });
    expect(up.status).toBe(201);
    expect((await call(w.owner, 'POST', `/imports/${up.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.owner, up.body.batch.id);
    const dry = await dryRunStage(ih, w.owner, b.id, 'contacts');
    expect(dry.status).toBe('dry_run_ready');

    // the preview has no side effect on anyone
    const before = await records(w.owner, b.id, 'contacts');
    expect(before.map((r) => r.matchContactId).sort()).toEqual([hit.c.id, kept.c.id].sort());
    for (const p of [hit, kept]) {
      expect(await refusalOf(p.c.id)).toBeNull();
      expect((await enrollmentRow(h(), p.enrollmentId)).state).toBe('active');
      expect((await actionRow(p.draftId)).status).toBe('proposed');
    }
    expect(await lastAudit('CONTACTS_COMMIT_SOURCE_NOT_REVIEWED_STOPPED')).toBeUndefined();

    // the reviewer attaches both records to the people they matched, approves and commits
    for (const r of before) {
      if (r.outcome === 'needs_review') expect((await call(w.owner, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'merge', mergeIntoContactId: r.matchContactId })).status).toBe(200);
    }
    const again = await batchOf(w.owner, b.id);
    const sha = again.stages.find((s) => s.category === 'contacts')!.dryRunSha256 as string;
    expect((await approveStage(w.owner, b.id, 'contacts', sha)).status).toBe(200);
    const done = await commitStage(ih, w.owner, b.id, 'contacts');
    expect(done.status).toBe('committed');
    expect((await verify(w.owner, b.id, 'contacts')).res.status).toBe(200);
    const after = await records(w.owner, b.id, 'contacts');
    expect(after.map((r) => r.outcome)).toEqual(['imported', 'imported']);

    // committed: the unreviewed label's person is unclassified; in the commit's own transaction their draft is withdrawn
    expect(await refusalOf(hit.c.id)).toBe(SOURCE_UNCLASSIFIED);
    expect(await actionRow(hit.draftId)).toMatchObject({ status: 'invalidated', payload: { withdrawn: { reason: SOURCE_UNCLASSIFIED } } });
    const au = (await lastAudit('CONTACTS_COMMIT_SOURCE_NOT_REVIEWED_STOPPED'))!;
    expect(au.changes).toMatchObject({ importBatchId: { to: b.id }, plansStoppingCount: { to: 1 }, draftsWithdrawnCount: { to: 1 }, aiCarePausingCount: { to: 0 } });
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), hit.enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    // the reviewed label's person is classified: left alone
    expect(await refusalOf(kept.c.id)).toBeNull();
    expect(await enrollmentRow(h(), kept.enrollmentId)).toMatchObject({ state: 'active', stop_reason: null });
    expect((await actionRow(kept.draftId)).status).toBe('proposed');
  }, 300_000);
});
