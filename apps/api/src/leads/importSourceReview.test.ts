// R-LSRC-10 (owner decision 2026-11-14, the review half; migration 0102): the source review of every import.
//
//   1. A visible source review is part of every import: the preview (GET /imports/:id/parity) and the summary
//      (GET /imports/:id/report) carry one row per source label found and one for the people with no label, with the
//      same states and counts as the CRM-wide list (GET /lead-sources/import-labels).
//   2. Only exact known matches are suggested (core suggestLeadSource), and a suggestion is never applied until the
//      Owner confirms it (POST /lead-sources/import-labels/confirm).
//   3. The label is kept exactly as imported, with where it was first committed (which import, which kind, when) and
//      how many people carry it; who mapped it and when is recorded and audited.
//   4. An ambiguous or unmapped label, and the people imported with no label, stay in review (no automated contact)
//      until the Owner classifies them; the no-label group is one row, mappable like a label.
//   5. Nobody infers that one label means another.
// A preview has no side effects: only the commit writes a review record or changes anyone's state. Made-up labels and
// sources; fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, enrollmentRow, smsStep } from '../assistant/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, randomPhone } from '../comms/testing.js';
import { type ImportsHarness, call, csvBase64, dryRunStage, freshReauth, fullStage, importsHarness, writtenBulkPhone } from '../imports/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, noAutomatedContact } from './automatedContact.js';
import { importedPerson } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let agent: TestClient;
let admin: TestClient;
let northgate: { id: string; name: string };
let open: { id: string; name: string };
let marked: { id: string; name: string };
let batchId: string;
let fay: string;
let fayPlan: string;

const h = () => ih.h;
/** U+1F3E0: one character, two UTF-16 units. */
const HOUSE = '\u{1F3E0}';
/** Read by core suggestLeadSource as the lead source "Northgate Referrals" (capitals and outer spaces aside): suggested, never applied. */
const SUGGESTED = '  northgate REFERRALS ';
/** The emoji takes units 499 and 500: the old cut at 500 would have split it. Longer than every older cut. */
const LONG = `${'a'.repeat(499)}${HOUSE}${'b'.repeat(40)}`;
const WALK_IN = 'Walk-in (test)';

interface Row {
  id: string | null;
  label: string;
  unlabeledImportId: string | null;
  people: number;
  committedPeople: number;
  state: 'mapped' | 'suggested' | 'ambiguous' | 'in_review';
  leadSourceId: string | null;
  leadSourceName: string | null;
  noAutomatedContact: boolean;
  inReview: boolean;
  suggestion: { leadSourceId: string; leadSourceName: string; noAutomatedContact: boolean } | null;
  firstSeen: { importId: string; kind: string; at: string } | null;
  changedBy: { userId: string; name: string } | null;
  changedAt: string | null;
  sentence: string;
}
type Answer = { label: Row; pausing: number; stopping: number; withdrawn: number };

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 1, others: ['admin'] });
  agent = w.agents[0]!;
  admin = w.others[0]!;
  await freshReauth(h(), w.owner);
  await freshReauth(h(), admin);
  const src = async (name: string, kind: string) => (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name, kind })).body.source;
  northgate = await src('Northgate Referrals', 'referral');
  open = await src('Open houses (test)', 'open_house');
  marked = await src('Partner referrals (test)', 'referral');
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  // Fay is already in the CRM, in a running plan, before any import
  const plan = await approvedPlaybook(w.owner, {
    kind: 'nurture',
    scope: 'team',
    name: 'Two check-ins (review test)',
    steps: [
      smsStep({ key: 'first', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] }),
      smsStep({ key: 'second', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in again.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
  const fayPhone = randomPhone();
  fay = (await ownedContact(agent, { phone: fayPhone, firstName: 'Fay' })).id;
  const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${fay}/enrollments`, { playbookId: plan.playbookId });
  expect(e.status).toBe(201);
  fayPlan = e.body.enrollment.id;
  // the file: five new people and Fay again (matched by her phone)
  const row = (first: string, phone: string, source: string) => `${first},Filed,${phone},${first.toLowerCase()}.filed.${randomUUID().slice(0, 6)}@example.com,"${source.replace(/"/g, '""')}"`;
  const csv = ['First Name,Last Name,Mobile Phone,Email,Source', row('Ada', writtenBulkPhone(5101), SUGGESTED), row('Bo', writtenBulkPhone(5102), LONG), row('Cy', writtenBulkPhone(5103), WALK_IN), row('Di', writtenBulkPhone(5104), ''), row('Ed', writtenBulkPhone(5105), WALK_IN), row('Fay', fayPhone, WALK_IN)].join('\n');
  const up = await call<{ batch: { id: string } }>(admin, 'POST', '/imports', { source: 'csv', fileName: 'review.csv', fileBase64: csvBase64(`${csv}\n`) });
  expect(up.status).toBe(201);
  batchId = up.body.batch.id;
  expect((await call(admin, 'POST', `/imports/${batchId}/snapshot`)).status).toBe(202);
  await ih.drain();
}, 300_000);
afterAll(async () => {
  await ih?.close();
});

const refusalOf = (contactId: string) => withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => noAutomatedContact(tx, contactId), { db: h().database });
const preview = async (c: TestClient = w.owner) => (await call<{ sourceLabels: Row[] }>(c, 'GET', `/imports/${batchId}/parity`)).body.sourceLabels;
const summary = async (c: TestClient = w.owner) => (await call<{ sourceLabels: Row[] }>(c, 'GET', `/imports/${batchId}/report`)).body.sourceLabels;
const list = async (c: TestClient = w.owner) => (await call<{ labels: Row[]; canChange: boolean }>(c, 'GET', '/lead-sources/import-labels')).body;
const listRow = async (key: string) => (await list()).labels.find((l) => (l.unlabeledImportId ?? l.label) === key);
const put = async (c: TestClient, body: Record<string, unknown>) => {
  await freshReauth(h(), c);
  return call<Answer>(c, 'PUT', '/lead-sources/import-labels', body);
};
const confirm = async (c: TestClient, body: Record<string, unknown>) => {
  await freshReauth(h(), c);
  return call<Answer>(c, 'POST', '/lead-sources/import-labels/confirm', body);
};
const detailsOf = (r: { body: unknown }): Record<string, unknown> => (r.body as { error?: { details?: Record<string, unknown> } }).error?.details ?? {};
const person = async (first: string) => (await h().su.query<{ id: string }>('SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = $2', [batchId, first])).rows[0]!.id;
const reviewRecords = async () => (await h().su.query<{ n: number }>('SELECT count(*)::int AS n FROM import_source_labels WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
const heldLabels = async () => (await h().su.query<{ l: string[]; b: string[] }>('SELECT import_labels AS l, import_unlabeled_batches::text[] AS b FROM lead_sources WHERE tenant_id = $1 AND (cardinality(import_labels) > 0 OR cardinality(import_unlabeled_batches) > 0)', [w.tenantId])).rows;
interface AuditRow {
  reason: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  occurred_at: Date;
  changes: Record<string, { from: unknown; to: unknown } | { changed: true }>;
}
const audits = async (since: Date) =>
  (await h().su.query<AuditRow>("SELECT reason, entity_type, entity_id, actor_user_id, actor_role, occurred_at, changes FROM audit_log WHERE tenant_id = $1 AND action = 'routing.changed' AND reason LIKE 'LEAD_SOURCE_IMPORT_%' AND occurred_at >= $2 ORDER BY seq", [w.tenantId, since])).rows;
/** The value an audit row recorded for a key; null when the key is absent (a null value is not written: nothing changed to nothing). */
const to = (a: AuditRow, k: string): unknown => (a.changes[k] as { to: unknown } | undefined)?.to ?? null;

describe('R-LSRC-10 M1 M2: the import\'s own source review, before anything is imported', () => {
  it('E738 E741: the preview lists every label exactly as the file has it, and the people with no label as one row, each with its state; an exact known match is suggested and NOT applied; reading the preview and running the dry run change nobody and write nothing', async () => {
    const rows = await preview();
    expect(rows.map((r) => [r.label, r.unlabeledImportId, r.people, r.committedPeople, r.state, r.inReview, r.leadSourceId])).toEqual([
      [SUGGESTED, null, 1, 0, 'suggested', true, null],
      [WALK_IN, null, 3, 0, 'in_review', true, null],
      [LONG, null, 1, 0, 'in_review', true, null],
      ['', batchId, 1, 0, 'in_review', true, null],
    ]);
    // character for character: surrounding spaces and capitals kept, the emoji whole, nothing cut
    const long = rows.find((r) => r.label === LONG)!;
    expect([long.label.length, long.label.slice(499, 501)]).toEqual([541, HOUSE]);
    const suggested = rows.find((r) => r.state === 'suggested')!;
    expect(suggested.suggestion).toEqual({ leadSourceId: northgate.id, leadSourceName: northgate.name, noAutomatedContact: false });
    expect(suggested.sentence).toBe(
      `"${SUGGESTED}" (1 person): not reviewed yet. It reads the same as the lead source Northgate Referrals, or a label already mapped to it, apart from capital letters and spaces around it, so Northgate Referrals is suggested. Nothing is mapped until the Owner confirms it, and nothing automatic goes to the people imported with it until then.`,
    );
    expect(rows.filter((r) => r.state !== 'suggested').map((r) => r.suggestion)).toEqual([null, null, null]);
    expect(rows.find((r) => r.label === WALK_IN)!.sentence).toBe(`"${WALK_IN}" (3 people): not reviewed yet. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.`);
    expect(rows.at(-1)!.sentence).toBe('No source label in this import (1 person): not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.');
    // nothing was seen in a committed import yet, and nobody mapped anything
    expect(rows.map((r) => [r.id, r.firstSeen, r.changedBy, r.changedAt])).toEqual(rows.map(() => [null, null, null, null]));
    // the Admin who runs the import reads the same review
    expect((await preview(admin)).map((r) => [r.label, r.state])).toEqual(rows.map((r) => [r.label, r.state]));

    // a dry run is a preview: Fay, matched by her phone, keeps her plan and is refused nothing; no review record is
    // written, no label is mapped, and the CRM-wide list does not know these labels
    const d = await dryRunStage(ih, admin, batchId, 'contacts');
    expect(d.status).toBe('dry_run_ready');
    expect(await refusalOf(fay)).toBeNull();
    expect((await enrollmentRow(h(), fayPlan)).state).toBe('active');
    expect(await reviewRecords()).toBe(0);
    expect(await heldLabels()).toEqual([]);
    expect((await list()).labels).toEqual([]);
    expect((await preview()).map((r) => [r.label, r.state, r.committedPeople])).toEqual(rows.map((r) => [r.label, r.state, 0]));
  }, 300_000);

  it('E738 E739: the commit keeps each label exactly (on the import record and on the person), writes where it was first seen, and puts the people it committed in review; a person the file only matched is not blocked; the summary and the CRM-wide list then carry the same rows, states and committed counts', async () => {
    const before = Date.now();
    await fullStage(ih, admin, batchId, 'contacts');
    const stored = (await h().su.query<{ first: string; label: string | null; detail: Record<string, unknown> }>(
      `SELECT c.first_name AS first, r.normalized ->> 'leadSourceLabel' AS label, c.original_source_detail AS detail
         FROM import_records r JOIN contacts c ON c.id = r.target_id WHERE c.import_batch_id = $1 ORDER BY c.first_name`, [batchId])).rows;
    expect(stored.map((s) => [s.first, s.label, s.detail['import_source'] ?? null])).toEqual([
      ['Ada', SUGGESTED, SUGGESTED],
      ['Bo', LONG, LONG],
      ['Cy', WALK_IN, WALK_IN],
      ['Di', null, null],
      ['Ed', WALK_IN, WALK_IN],
    ]);
    // everyone the import committed is in review; the suggestion mapped nothing
    for (const first of ['Ada', 'Bo', 'Cy', 'Di', 'Ed']) expect(await refusalOf(await person(first)), first).toBe(SOURCE_UNCLASSIFIED);
    expect(await heldLabels()).toEqual([]);
    // Fay was already here with an owner: her row waits for a person's review, so the import committed nothing for
    // her. A record that only matched someone is no import evidence: she is refused nothing and her plan runs on
    expect((await h().su.query<{ outcome: string; target_id: string | null }>("SELECT outcome, target_id FROM import_records r JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND r.match_contact_id = $2", [batchId, fay])).rows).toEqual([{ outcome: 'needs_review', target_id: null }]);
    expect(await refusalOf(fay)).toBeNull();
    expect((await enrollmentRow(h(), fayPlan)).state).toBe('active');

    const l = await list();
    expect(l.canChange).toBe(true);
    expect(l.labels.map((r) => [r.label, r.unlabeledImportId, r.people, r.committedPeople, r.state, r.inReview])).toEqual([
      [SUGGESTED, null, 1, 1, 'suggested', true],
      [WALK_IN, null, 2, 2, 'in_review', true],
      [LONG, null, 1, 1, 'in_review', true],
      ['', batchId, 1, 1, 'in_review', true],
    ]);
    for (const r of l.labels) {
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.firstSeen).toMatchObject({ importId: batchId, kind: 'csv' });
      expect(Date.parse(r.firstSeen!.at)).toBeGreaterThanOrEqual(before - 1000);
      expect([r.changedBy, r.changedAt]).toEqual([null, null]);
    }
    expect(l.labels.at(-1)!.sentence).toBe('No source label in one file import (1 person): not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.');
    // the summary: the same rows, states and committed counts. Its `people` are this import's own (the file's three
    // walk-ins, Fay's waiting row among them); `committedPeople` is what the CRM-wide list counts
    const s = await summary();
    expect(s.map((r) => [r.label, r.unlabeledImportId, r.committedPeople, r.state, r.id, r.firstSeen?.importId])).toEqual(l.labels.map((r) => [r.label, r.unlabeledImportId, r.people, r.state, r.id, batchId]));
    expect(s.map((r) => r.people)).toEqual([1, 3, 1, 1]);
    expect((await summary(admin)).map((r) => r.state)).toEqual(s.map((r) => r.state));
    // the Admin reads the list and cannot change it; an agent has no such page
    const asAdmin = await list(admin);
    expect([asAdmin.canChange, asAdmin.labels.length]).toEqual([false, 4]);
    expect((await call(agent, 'GET', '/lead-sources/import-labels')).status).toBe(404);
  }, 300_000);
});

describe('R-LSRC-10 M2 M3: the Owner confirms, maps, re-maps and un-maps; the people follow; every change is recorded and audited', () => {
  it('E741: a suggestion is applied only by the Owner\'s confirmation of exactly that suggestion; anyone else gets 404, a different source or a label with no suggestion gets 409 and nothing is mapped', async () => {
    const ada = await person('Ada');
    for (const c of [admin, agent]) expect((await confirm(c, { label: SUGGESTED, leadSourceId: northgate.id })).status).toBe(404);
    const wrong = await confirm(w.owner, { label: SUGGESTED, leadSourceId: open.id });
    expect([wrong.status, wrong.code]).toEqual([409, 'IMPORT_LABEL_SUGGESTION_CHANGED']);
    expect(detailsOf(wrong)).toMatchObject({ state: 'suggested', suggestedLeadSourceId: northgate.id, leadSourceId: null });
    const none = await confirm(w.owner, { label: WALK_IN, leadSourceId: open.id });
    expect([none.status, none.code, detailsOf(none)['state']]).toEqual([409, 'IMPORT_LABEL_SUGGESTION_CHANGED', 'in_review']);
    // nobody infers that one label means another: a label that only looks like the suggested one is not it
    const lookalike = await confirm(w.owner, { label: SUGGESTED.trim(), leadSourceId: northgate.id });
    expect(lookalike.status).toBe(200); // itself an exact known match, but its own label: mapping it maps only itself
    expect(await refusalOf(ada)).toBe(SOURCE_UNCLASSIFIED);
    expect((await put(w.owner, { label: SUGGESTED.trim(), leadSourceId: null })).status).toBe(200);
    expect(await heldLabels()).toEqual([]);
    expect((await call(w.owner, 'POST', '/lead-sources/import-labels/confirm', { label: '   ', leadSourceId: northgate.id })).status).toBe(422);

    const since = new Date();
    const ok = await confirm(w.owner, { label: SUGGESTED, leadSourceId: northgate.id });
    expect(ok.status).toBe(200);
    expect(ok.body.label).toMatchObject({ label: SUGGESTED, state: 'mapped', inReview: false, leadSourceId: northgate.id, leadSourceName: northgate.name, suggestion: null, people: 1, committedPeople: 1, changedBy: { userId: w.owner.userId } });
    expect(ok.body.label.sentence).toBe(`"${SUGGESTED}" (1 person): mapped to Northgate Referrals.`);
    expect(await refusalOf(ada)).toBeNull();
    expect(await heldLabels()).toEqual([{ l: [SUGGESTED], b: [] }]);
    const [a] = await audits(since);
    expect(a).toMatchObject({ reason: 'LEAD_SOURCE_IMPORT_LABEL_SUGGESTION_CONFIRMED', entity_type: 'lead_source', entity_id: northgate.id, actor_user_id: w.owner.userId, actor_role: 'owner' });
    expect([to(a!, 'importLabel'), to(a!, 'fromLeadSourceIds'), to(a!, 'toLeadSourceId'), to(a!, 'importSourceLabelId')]).toEqual([SUGGESTED, [], northgate.id, ok.body.label.id]);
    // confirming it again changes nothing and writes no second audit row
    expect((await confirm(w.owner, { label: SUGGESTED, leadSourceId: northgate.id })).body.label.state).toBe('mapped');
    expect(await audits(since)).toHaveLength(1);
  }, 300_000);

  it('E742 E743: map, re-map and un-map a label: the list tells the truth after each, the people follow in both directions (in review, open, the marked source, in review again, open again), and each change has its audit row with the label, the old and the new source, who, when and what was asked to stop', async () => {
    const cy = await person('Cy');
    for (const c of [admin, agent]) expect((await put(c, { label: WALK_IN, leadSourceId: open.id })).status).toBe(404);
    const since = new Date();

    const mapped = await put(w.owner, { label: WALK_IN, leadSourceId: open.id });
    expect(mapped.body.label).toMatchObject({ state: 'mapped', inReview: false, leadSourceId: open.id, noAutomatedContact: false, people: 2, committedPeople: 2, changedBy: { userId: w.owner.userId } });
    expect(await refusalOf(cy)).toBeNull();
    expect(await refusalOf(fay)).toBeNull();
    const firstChange = mapped.body.label.changedAt!;

    const moved = await put(w.owner, { label: WALK_IN, leadSourceId: marked.id });
    expect(moved.body.label).toMatchObject({ state: 'mapped', inReview: false, leadSourceId: marked.id, leadSourceName: marked.name, noAutomatedContact: true });
    expect(moved.body.label.sentence).toBe(`"${WALK_IN}" (2 people): mapped to ${marked.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`);
    expect(await refusalOf(cy)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    // a MARKED source also covers a person the import only matched under this label (0099's reading, kept; OQ-B18-I4):
    // Fay is refused for that reason and her running plan is asked to stop
    expect(await refusalOf(fay)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(moved.body.stopping).toBe(1);
    expect(await listRow(WALK_IN)).toMatchObject({ state: 'mapped', leadSourceId: marked.id, noAutomatedContact: true });

    const off = await put(w.owner, { label: WALK_IN, leadSourceId: null });
    expect(off.body.label).toMatchObject({ state: 'in_review', inReview: true, leadSourceId: null, leadSourceName: null, noAutomatedContact: false, changedBy: { userId: w.owner.userId } });
    expect(Date.parse(off.body.label.changedAt!)).toBeGreaterThanOrEqual(Date.parse(firstChange));
    expect(await refusalOf(cy)).toBe(SOURCE_UNCLASSIFIED);
    expect(await refusalOf(fay)).toBeNull(); // only matched: an unreviewed label never blocks her
    expect(await listRow(WALK_IN)).toMatchObject({ state: 'in_review', inReview: true, leadSourceId: null, people: 2 });

    const back = await put(w.owner, { label: WALK_IN, leadSourceId: open.id });
    expect(back.body.label).toMatchObject({ state: 'mapped', leadSourceId: open.id, noAutomatedContact: false });
    expect(await refusalOf(cy)).toBeNull();
    // the summary of the import that brought the label tells the same truth
    expect((await summary()).find((r) => r.label === WALK_IN)).toMatchObject({ state: 'mapped', leadSourceId: open.id, people: 3, committedPeople: 2 });

    const rows = await audits(since);
    expect(rows.map((a) => [a.reason, to(a, 'fromLeadSourceIds'), to(a, 'toLeadSourceId'), to(a, 'importLabel')])).toEqual([
      ['LEAD_SOURCE_IMPORT_LABEL_MAPPED', [], open.id, WALK_IN],
      ['LEAD_SOURCE_IMPORT_LABEL_REMAPPED', [open.id], marked.id, WALK_IN],
      ['LEAD_SOURCE_IMPORT_LABEL_UNMAPPED', [marked.id], null, WALK_IN],
      ['LEAD_SOURCE_IMPORT_LABEL_MAPPED', [], open.id, WALK_IN],
    ]);
    for (const a of rows) {
      expect([a.actor_user_id, a.actor_role]).toEqual([w.owner.userId, 'owner']);
      expect(a.occurred_at.getTime()).toBeGreaterThanOrEqual(since.getTime() - 1000);
      expect(to(a, 'importSourceLabelId')).toBe(mapped.body.label.id);
      expect(Object.keys(a.changes)).toEqual(expect.arrayContaining(['aiCarePausingCount', 'plansStoppingCount', 'draftsWithdrawnCount', 'labelSha256']));
    }
    // what each change asked to stop is counted in its audit row: only the move to the marked source met a running plan
    expect(rows.map((a) => [to(a, 'plansStoppingCount'), to(a, 'aiCarePausingCount'), to(a, 'draftsWithdrawnCount')])).toEqual([[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]]);
  }, 300_000);

  it('E744: the people imported with no source label are one row the Owner maps, re-maps and un-maps like a label; nothing is ever suggested for them; each change is audited with the import', async () => {
    const di = await person('Di');
    expect(await listRow(batchId)).toMatchObject({ label: '', state: 'in_review', suggestion: null, people: 1 });
    for (const c of [admin, agent]) expect((await put(c, { unlabeledImportId: batchId, leadSourceId: open.id })).status).toBe(404);
    // a label of nothing is not how that row is mapped: the server refuses it
    expect((await put(w.owner, { label: '', leadSourceId: open.id })).status).toBe(422);
    const since = new Date();

    const on = await put(w.owner, { unlabeledImportId: batchId, leadSourceId: open.id });
    expect(on.body.label).toMatchObject({ label: '', unlabeledImportId: batchId, state: 'mapped', inReview: false, leadSourceId: open.id, people: 1, committedPeople: 1, changedBy: { userId: w.owner.userId }, firstSeen: { importId: batchId, kind: 'csv' } });
    expect(on.body.label.sentence).toBe(`No source label in one file import (1 person): counted as ${open.name}.`);
    expect(await refusalOf(di)).toBeNull();
    expect((await summary()).at(-1)).toMatchObject({ unlabeledImportId: batchId, state: 'mapped', leadSourceId: open.id, sentence: `No source label in this import (1 person): counted as ${open.name}.` });

    expect((await put(w.owner, { unlabeledImportId: batchId, leadSourceId: marked.id })).body.label).toMatchObject({ state: 'mapped', leadSourceId: marked.id, noAutomatedContact: true });
    expect(await refusalOf(di)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect((await put(w.owner, { unlabeledImportId: batchId, leadSourceId: null })).body.label).toMatchObject({ state: 'in_review', inReview: true, leadSourceId: null });
    expect(await refusalOf(di)).toBe(SOURCE_UNCLASSIFIED);
    expect(await listRow(batchId)).toMatchObject({ state: 'in_review', inReview: true, people: 1 });

    expect((await audits(since)).map((a) => [a.reason, to(a, 'importBatchId'), to(a, 'fromLeadSourceIds'), to(a, 'toLeadSourceId'), a.actor_user_id])).toEqual([
      ['LEAD_SOURCE_IMPORT_UNLABELED_MAPPED', batchId, [], open.id, w.owner.userId],
      ['LEAD_SOURCE_IMPORT_UNLABELED_REMAPPED', batchId, [open.id], marked.id, w.owner.userId],
      ['LEAD_SOURCE_IMPORT_UNLABELED_UNMAPPED', batchId, [marked.id], null, w.owner.userId],
    ]);
  }, 300_000);

  it('E741: a label that reads the same as two lead sources is ambiguous: nothing is suggested, its people stay in review, and the Owner still maps it by choosing', async () => {
    // "Harbor Desk" is a lead source's name; "HARBOR DESK" is a label the Owner already mapped to another source
    const harbor = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Harbor Desk', kind: 'referral' })).body.source;
    const gus = await ownedContact(agent);
    const hal = await ownedContact(agent);
    const first = await importedPerson(h(), w.tenantId, w.owner.userId!, gus.id, { label: 'HARBOR DESK' });
    expect((await put(w.owner, { label: 'HARBOR DESK', leadSourceId: open.id })).status).toBe(200);
    await importedPerson(h(), w.tenantId, w.owner.userId!, hal.id, { label: 'harbor desk', batchId: first.batchId });
    const row = (await listRow('harbor desk'))!;
    expect(row).toMatchObject({ state: 'ambiguous', inReview: true, suggestion: null, leadSourceId: null, people: 1 });
    expect(row.sentence).toBe('"harbor desk" (1 person): not reviewed yet. It reads the same as more than one lead source, so none is suggested. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.');
    expect(await refusalOf(hal.id)).toBe(SOURCE_UNCLASSIFIED);
    const c = await confirm(w.owner, { label: 'harbor desk', leadSourceId: harbor.id });
    expect([c.status, c.code, detailsOf(c)['state']]).toEqual([409, 'IMPORT_LABEL_SUGGESTION_CHANGED', 'ambiguous']);
    expect(await refusalOf(hal.id)).toBe(SOURCE_UNCLASSIFIED);
    // the Owner chooses: an explicit mapping, of this label only
    expect((await put(w.owner, { label: 'harbor desk', leadSourceId: harbor.id })).body.label).toMatchObject({ state: 'mapped', leadSourceId: harbor.id });
    expect(await refusalOf(hal.id)).toBeNull();
    expect(await listRow('HARBOR DESK')).toMatchObject({ state: 'mapped', leadSourceId: open.id });
  }, 300_000);
});

describe('R-LSRC-10 M5: another team reads and changes nothing of this one (R-TEN-3)', () => {
  it('E746 R-TEN-3: another team\'s Owner sees none of these labels, cannot map this team\'s label, source or no-label group, and both definers answer nothing across teams', async () => {
    const o = await commsWorld(ih.h, { agents: 1 });
    await freshReauth(h(), o.owner);
    expect((await list(o.owner)).labels).toEqual([]);
    const mine = (await call<{ source: { id: string } }>(o.owner, 'POST', '/lead-sources', { name: 'Their own source (test)', kind: 'referral' })).body.source;
    const before = JSON.stringify([await heldLabels(), await reviewRecords(), (await list()).labels]);
    // this team's source, this team's import and this team's source in a confirmation: 404 each
    for (const [m, path, body] of [
      ['PUT', '/lead-sources/import-labels', { label: WALK_IN, leadSourceId: open.id }],
      ['PUT', '/lead-sources/import-labels', { unlabeledImportId: batchId, leadSourceId: mine.id }],
      ['POST', '/lead-sources/import-labels/confirm', { label: 'Northgate Referrals', leadSourceId: northgate.id }],
      ['PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: false }],
    ] as const) {
      await freshReauth(h(), o.owner);
      expect((await call(o.owner, m, path, body)).status, `${m} ${path}`).toBe(404);
    }
    // the same label text in their own team is their own label: it maps nothing here
    expect((await put(o.owner, { label: WALK_IN, leadSourceId: mine.id })).status).toBe(200);
    expect(JSON.stringify([await heldLabels(), await reviewRecords(), (await list()).labels])).toBe(before);
    expect((await call(o.owner, 'GET', `/imports/${batchId}/parity`)).status).toBe(404);
    expect((await call(o.owner, 'GET', `/imports/${batchId}/report`)).status).toBe(404);
    // the definers, asked by the other team about a person of this one: nothing, whichever tenant id is passed
    const cy = await person('Cy');
    await put(w.owner, { label: WALK_IN, leadSourceId: marked.id });
    expect(await refusalOf(cy)).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    for (const actor of [o.owner.actor(), systemActor(o.tenantId, 'worker')]) {
      const r = await withTenantTx(actor, async (tx) => {
        return (await sql<{ a: string | null; b: boolean; c: boolean; d: string | null; e: boolean; f: boolean; n: string }>`
          SELECT app.person_source_refusal(${w.tenantId}::uuid, ${cy}::uuid) AS a, app.person_no_ai_care_source(${w.tenantId}::uuid, ${cy}::uuid) AS b,
                 app.person_from_lead_source(${w.tenantId}::uuid, ${cy}::uuid, ${marked.id}::uuid) AS c,
                 app.person_source_refusal(app.tenant_id(), ${cy}::uuid) AS d, app.person_no_ai_care_source(app.tenant_id(), ${cy}::uuid) AS e,
                 app.person_from_lead_source(app.tenant_id(), ${cy}::uuid, ${marked.id}::uuid) AS f,
                 (SELECT count(*) FROM app.import_source_people(${w.tenantId}::uuid, ${WALK_IN}::text, NULL::uuid))::text AS n`.execute(tx)).rows[0]!;
      }, { db: h().database });
      expect(r).toEqual({ a: null, b: false, c: false, d: null, e: false, f: false, n: '0' });
    }
  }, 300_000);
});
