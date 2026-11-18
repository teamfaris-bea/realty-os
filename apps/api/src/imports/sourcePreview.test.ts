// R-LSRC-8, R-LSRC-9, E735, E755 (migration 0103): a preview has no side effects, for a MARKED source too.
//
// A label the Owner mapped to a lead source marked "No automated contact for leads from this source" (and an import's
// no-label group counted as that source) covers a person only once an import COMMITS a record onto them. A dry run
// that merely matches a person already in the CRM, a record left waiting for a person's review and an abandoned import
// refuse them nothing and stop nothing: their plan keeps running and a new plan may start. The commit that attaches the
// record to them is what refuses them, and stops their plan then. Before 0103 the dry run alone refused the matched
// person as the marked source's lead, their plan stopped at its next step for good, and abandoning the import changed
// nothing. Made-up labels and sources; fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, auditRows, enrollmentRow, runJobs, smsStep } from '../assistant/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, randomPhone } from '../comms/testing.js';
import { SOURCE_NO_AUTOMATED_CONTACT, noAutomatedContact } from '../leads/automatedContact.js';
import { askPlanForAStep } from '../leads/sourceStop.js';
import { systemActor } from '../worker/systemActor.js';
import { type ImportsHarness, type RecordView, approve, call, commitStage, csvBase64, dryRunStage, freshReauth, importsHarness, records, verify, writtenBulkPhone } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let agent: TestClient;
let marked: { id: string; name: string };
let planId: string;
let csv: string;
const native: Record<'nia' | 'oz' | 'quin', { id: string; phone: string }> = { nia: { id: '', phone: '' }, oz: { id: '', phone: '' }, quin: { id: '', phone: '' } };
let niaPlan: string;

const h = () => ih.h;
const PARTNER = 'Partner file (preview test)';

interface Row {
  label: string;
  unlabeledImportId: string | null;
  people: number;
  committedPeople: number;
  state: string;
  leadSourceId: string | null;
  noAutomatedContact: boolean;
  sentence: string;
}

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h(), w.owner);
  marked = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (preview test)', kind: 'referral' })).body.source;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  // the Owner mapped the partner's label ahead of any import
  expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: PARTNER, leadSourceId: marked.id })).status).toBe(200);
  const plan = await approvedPlaybook(w.owner, {
    kind: 'nurture',
    scope: 'team',
    name: 'Two check-ins (preview test)',
    steps: [
      smsStep({ key: 'first', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] }),
      smsStep({ key: 'second', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in again.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
  planId = plan.playbookId;
  // three native people, already in the CRM with an owner; Nia is in a running plan
  for (const [k, firstName] of [['nia', 'Nia'], ['oz', 'Oz'], ['quin', 'Quin']] as const) {
    const phone = randomPhone();
    native[k] = { id: (await ownedContact(agent, { phone, firstName })).id, phone };
  }
  const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${native.nia.id}/enrollments`, { playbookId: planId });
  expect(e.status).toBe(201);
  niaPlan = e.body.enrollment.id;
  // the partner's file: the three people again (by phone), and one new person. Quin's row has no source label.
  const row = (first: string, phone: string, source: string) => `${first},Filed,${phone},${first.toLowerCase()}.filed.${randomUUID().slice(0, 6)}@example.com,"${source}"`;
  csv = `${['First Name,Last Name,Mobile Phone,Email,Source', row('Nia', native.nia.phone, PARTNER), row('Oz', native.oz.phone, PARTNER), row('Pip', writtenBulkPhone(5301), PARTNER), row('Quin', native.quin.phone, '')].join('\n')}\n`;
}, 300_000);
afterAll(async () => {
  await ih?.close();
});

const refusalOf = (contactId: string) => withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => noAutomatedContact(tx, contactId), { db: h().database });
const upload = async (): Promise<string> => {
  const up = await call<{ batch: { id: string } }>(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'partner.csv', fileBase64: csvBase64(csv) });
  expect(up.status).toBe(201);
  expect((await call(w.owner, 'POST', `/imports/${up.body.batch.id}/snapshot`)).status).toBe(202);
  await ih.drain();
  return up.body.batch.id;
};
const preview = async (batchId: string) => (await call<{ sourceLabels: Row[] }>(w.owner, 'GET', `/imports/${batchId}/parity`)).body.sourceLabels;
const list = async () => (await call<{ labels: Row[] }>(w.owner, 'GET', '/lead-sources/import-labels')).body.labels;
const mapGroup = async (batchId: string) => {
  await freshReauth(h(), w.owner);
  return call(w.owner, 'PUT', '/lead-sources/import-labels', { unlabeledImportId: batchId, leadSourceId: marked.id });
};
/** The plan's step job, now: the step runner asks whether anything automatic may go to the person before any due check. */
const stepNow = async (enrollmentId: string) => {
  await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => askPlanForAStep(tx, enrollmentId, now), { db: h().database });
  await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
};
const matchedRecord = (rs: RecordView[], contactId: string) => rs.find((r) => r.matchContactId === contactId)!;

describe('R-LSRC-8 E735 E755: a dry run, a record waiting for review and an abandoned import block nobody, under a label mapped to a marked source and in a no-label group counted as one', () => {
  let first: string;
  let ozPlan: string;

  it('the dry run matches three people already here and imports nobody: none of them is refused, a plan starts for one by hand, a running plan runs on at its next step, and the review rows count nobody as imported', async () => {
    first = await upload();
    expect((await mapGroup(first)).status).toBe(200);
    const d = await dryRunStage(ih, w.owner, first, 'contacts');
    expect(d.status).toBe('dry_run_ready');
    const rs = await records(w.owner, first, 'contacts');
    expect(rs.map((r) => [r.outcome, r.targetId]).sort()).toEqual([['needs_review', null], ['needs_review', null], ['needs_review', null], ['will_import', null]]);
    for (const p of Object.values(native)) expect(matchedRecord(rs, p.id).outcome).toBe('needs_review');

    for (const p of Object.values(native)) expect(await refusalOf(p.id)).toBeNull();
    // a person may enrol Oz by hand (before 0103: 409 SOURCE_NO_AUTOMATED_CONTACT, on a preview alone)
    const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${native.oz.id}/enrollments`, { playbookId: planId });
    expect([e.status, e.code ?? null]).toEqual([201, null]);
    ozPlan = e.body.enrollment.id;
    // Nia's running plan is asked for a step: it is not stopped
    await stepNow(niaPlan);
    expect(await enrollmentRow(h(), niaPlan)).toMatchObject({ state: 'active', stop_reason: null });

    // the rows say what is true: mapped to the marked source, and nobody imported with them yet
    const rows = await preview(first);
    expect(rows.map((r) => [r.label, r.unlabeledImportId, r.people, r.committedPeople, r.state, r.leadSourceId, r.noAutomatedContact])).toEqual([
      [PARTNER, null, 3, 0, 'mapped', marked.id, true],
      ['', first, 1, 0, 'mapped', marked.id, true],
    ]);
    expect((await list()).map((r) => [r.label, r.unlabeledImportId, r.people])).toEqual([[PARTNER, null, 0], ['', first, 0]]);
  }, 300_000);

  it('abandoning the import changes nothing for them either: still not refused, both plans running', async () => {
    const a = await call(w.owner, 'POST', `/imports/${first}/abandon`);
    expect(a.status).toBe(200);
    for (const p of Object.values(native)) expect(await refusalOf(p.id)).toBeNull();
    await stepNow(niaPlan);
    await stepNow(ozPlan);
    expect((await enrollmentRow(h(), niaPlan)).state).toBe('active');
    expect((await enrollmentRow(h(), ozPlan)).state).toBe('active');
    expect((await auditRows(h(), w.tenantId, 'import.committed')).filter((x) => x.reason === 'CONTACTS_COMMIT_SOURCE_NOT_REVIEWED_STOPPED')).toEqual([]);
  }, 300_000);

  it('the commit that attaches the record to a person is what refuses them: Nia (a reviewer attached her row) and Quin (attached, no label, the group counted as the marked source) are the marked source\'s people from then on and Nia\'s plan stops; Oz, whose row was left waiting, is untouched', async () => {
    const second = await upload();
    expect((await mapGroup(second)).status).toBe(200);
    const d = await dryRunStage(ih, w.owner, second, 'contacts');
    const rs = await records(w.owner, second, 'contacts');
    // the reviewer attaches Nia's and Quin's rows to the people they matched; Oz's row is left waiting
    for (const p of [native.nia, native.quin]) {
      const r = await call(w.owner, 'POST', `/imports/${second}/records/${matchedRecord(rs, p.id).id}/review`, { decision: 'merge', mergeIntoContactId: p.id });
      expect(r.status).toBe(200);
    }
    // still a preview: a decision on a row is not an import
    for (const p of Object.values(native)) expect(await refusalOf(p.id)).toBeNull();
    expect((await approve(w.owner, second, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    const s = await commitStage(ih, w.owner, second, 'contacts');
    expect(s.status).toBe('committed');
    expect((await verify(w.owner, second, 'contacts')).res.status).toBe(200);

    const after = await records(w.owner, second, 'contacts');
    expect([matchedRecord(after, native.nia.id).targetId, matchedRecord(after, native.quin.id).targetId, matchedRecord(after, native.oz.id).targetId]).toEqual([native.nia.id, native.quin.id, null]);
    expect(await refusalOf(native.nia.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(await refusalOf(native.quin.id)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    const pip = (await h().su.query<{ id: string }>('SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = $2', [second, 'Pip'])).rows[0]!.id;
    expect(await refusalOf(pip)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    // the commit asked Nia's plan for a step, and that stops it, for the marked source's reason; it is audited
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), niaPlan)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    const stops = (await auditRows(h(), w.tenantId, 'import.committed')).filter((x) => x.reason === 'CONTACTS_COMMIT_SOURCE_NOT_REVIEWED_STOPPED');
    expect(stops).toHaveLength(1);
    expect((stops[0]!.changes as Record<string, { to: unknown }>)['plansStoppingCount']!.to).toBe(1);
    const again = await call(agent, 'POST', `/contacts/${native.nia.id}/enrollments`, { playbookId: planId });
    expect([again.status, again.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);

    // Oz: only matched, in both imports. Nothing is refused, and his plan runs on
    expect(await refusalOf(native.oz.id)).toBeNull();
    await stepNow(ozPlan);
    expect((await enrollmentRow(h(), ozPlan)).state).toBe('active');

    // the CRM-wide list counts the people an import committed, and only them: Nia and Pip under the label, Quin in this
    // import's no-label group, nobody in the abandoned import's
    expect((await list()).map((r) => [r.label, r.unlabeledImportId, r.people, r.leadSourceId])).toEqual([
      [PARTNER, null, 2, marked.id],
      ['', second, 1, marked.id],
      ['', first, 0, marked.id],
    ]);
  }, 300_000);
});
