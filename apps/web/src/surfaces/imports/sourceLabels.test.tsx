// R-LSRC-10 W1, W2 (owner decision 2026-11-14; E728, E744, E748 to E751): "Review sources" is a step of every import, Follow Up
// Boss and CSV alike. From the snapshot until the contacts are imported it sits above the categories: every label found,
// exactly as imported, with its people and its state, the people with no label as their own row, a Confirm on an
// exact-match suggestion and an explicit Map button (changing the dropdown alone sends nothing). The import may run with
// labels left in review, and the screen says plainly what that means; the contacts category repeats it next to Approve
// and Import, and the summary after the import repeats it with the people actually imported. Only the Owner gets
// controls. The rows carry the API's own sentences (lead-sources/testing.tsx reviewSentence). Labels and sources are
// made up.
//
// E755 (migration 0103): a label mapped to a source with "No automated contact for leads from this source" on covers the
// people an import COMMITTED, not a person the file only matched. An import's own row says so in numbers (the API's
// sentence, shown as it is), and the row carries a warning chip while someone of the file is not covered, in the step
// before the import and in the summary after it.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, leadAdminApp } from '../admin/lib/testing.js';
import type { ImportBatch, ImportCategory, ImportStage } from '../admin/lib/types.js';
import { NO_LABEL_FIELD, OWNER_MAPS_LABELS, type ImportLabelView } from '../lead-sources/ImportLabels.js';
import { IN_REVIEW_MEANS } from '../lead-sources/reviewWords.js';
import { labelRow, overview, source } from '../lead-sources/testing.js';
import { type ParityResponse, sourceReviewIsAStep } from './lib.js';

const SNAP = 'd'.repeat(64);
const BID = '01900000-0000-7000-8000-0000000b0028';
const MARKED = { id: '01900000-0000-7000-8000-00000000528a', name: 'Northgate Referrals', noAiCare: true };
const OPEN = { id: '01900000-0000-7000-8000-00000000528b', name: 'Open houses' };
const SEQ: Record<ImportCategory, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6 };
const NOW = () => new Date().toISOString();

function stage(category: ImportCategory, status: string, over: Partial<ImportStage> = {}): ImportStage {
  return { id: `st-${category}`, category, seq: SEQ[category], status, counts: null, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null, ...over };
}

function batch(stages: ImportStage[], over: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: BID, source: 'fub_api', status: 'dry_run', sourceCounts: { contacts: 9 }, snapshotSha256: SNAP, snapshotAt: '2026-11-10T10:00:00.000Z', snapshotError: null,
    fileLabel: null, csv: null, createdAt: '2026-11-10T09:00:00.000Z', createdByUserId: 'u', revertedAt: null, stages, connectionTest: ['9 contacts found in Follow Up Boss.'], ...over,
  } as ImportBatch;
}

// what an import's review looks like before anything is imported: one label nobody knows, one exact match of a lead
// source's name (suggested, never applied), one label an Owner mapped earlier, and the people with no label
const unknown = labelRow('Sunday flyer', { people: 2 });
const suggested = labelRow(' open houses', { people: 3, suggest: OPEN });
const mapped = labelRow('Northgate referral desk', { people: 3, mappedTo: MARKED, file: { kind: 'fub_api', matchedOnly: 0, open: true }, id: 'r1', firstSeen: { importId: BID, kind: 'fub_api', at: '2026-11-02T15:00:00.000Z' }, changedBy: { userId: 'u1', name: 'Olive Owner' }, changedAt: '2026-11-03T16:00:00.000Z' });
const blank = labelRow('', { unlabeledImportId: BID, people: 1 });
const ROWS = [unknown, suggested, mapped, blank];

const parity = (labels: ImportLabelView[]): ParityResponse => ({
  options: { stageMap: {}, keepStageAsTag: true, fields: {} },
  stages: [],
  tags: { distinct: 0, existing: 0, toCreate: 0, overLimit: 0, sourceLinks: 0, links: 0, protectedNew: 0, optOutTagged: 0, overLimitNames: [] },
  fields: [],
  existingFields: [],
  blockers: [],
  lines: ['No stages in the source.'],
  report: [],
  sourceLabels: labels,
});

function fake(b: ImportBatch, labels: () => ImportLabelView[]) {
  return new FakeFetch()
    .on(`GET /imports/${BID}`, { status: 200, body: { batch: b } })
    .on(`GET /imports/${BID}/report`, () => ({ status: 200, body: { source: 'Follow Up Boss', categories: [], parity: null, sourceLabels: labels() } }))
    .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } })
    .on(`GET /imports/${BID}/parity`, () => ({ status: 200, body: parity(labels()) }))
    .on('GET /lead-sources/overview', { status: 200, body: overview([source({ id: MARKED.id, name: MARKED.name, noAiCare: true, noAiCareSentence: 'on' }), source({ id: OPEN.id, name: OPEN.name })]) })
    .on('GET /members', { status: 200, body: { members: [], invites: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } });
}

const step = async () => within(await screen.findByRole('region', { name: 'Review sources' }));
const row = (s: ReturnType<typeof within>, name: string) => within(s.getByRole('group', { name }));
const writes = (f: FakeFetch) => f.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/lead-sources/import-labels'));

describe('R-LSRC-10 W1: Review sources is a step of every import', () => {
  it('R-LSRC-10 E748 E728: a Follow Up Boss import shows the step above the categories, before any dry run: every label as imported, its people and state, the no-label group as its own row, and what "in review" means', async () => {
    const f = fake(batch([stage('contacts', 'pending')]), () => ROWS);
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = await step();
    expect(await s.findByText(/^Follow Up Boss gives each person's source as a label, shown here exactly as it was imported\./)).toBeInTheDocument();
    // the step says what choosing a lead source does: it sets automated contact, never lead counts or reports
    expect(s.getByText("Follow Up Boss gives each person's source as a label, shown here exactly as it was imported. Until an Owner chooses a lead source for a label, the people imported with it are in review. Once one is chosen, automated contact for them follows that source's setting; lead counts and reports do not change. A match is only ever suggested, never applied for you.")).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Review sources' }).textContent).not.toMatch(/counts as one of your lead sources|count as leads/);
    for (const r of ROWS) expect(await s.findByText(r.sentence)).toBeInTheDocument();
    // the label is shown exactly as imported (its leading space is kept), and each row says its state in words
    expect(row(s, 'Source label " open houses"').getByText('" open houses"', { normalizer: (t) => t })).toBeInTheDocument();
    expect(row(s, 'Source label "Sunday flyer"').getByText('In review')).toBeInTheDocument();
    expect(row(s, 'Source label " open houses"').getByText('In review · a match is suggested')).toBeInTheDocument();
    expect(row(s, 'Source label "Northgate referral desk"').getByText('Mapped · no automated contact')).toBeInTheDocument();
    expect(row(s, 'People imported with no source label').getByText('No source label')).toBeInTheDocument();
    expect(row(s, 'Source label "Northgate referral desk"').getByText(/^First imported .* from Follow Up Boss\. Mapping last changed by Olive Owner, /)).toBeInTheDocument();
    expect(row(s, 'Source label "Sunday flyer"').getByText('Not imported yet: seen in a preview only.')).toBeInTheDocument();
    // the plain statement: how much is in review, that the import may run anyway, and what it means for those people
    expect(s.getByText('Still in review: 2 labels and the people with no source label (6 people). You can run the import with these left in review.')).toBeInTheDocument();
    expect(s.getByText(IN_REVIEW_MEANS)).toBeInTheDocument();
    expect(IN_REVIEW_MEANS).toMatch(/no automated contact .* until an Owner chooses a lead source\. Anyone on the team can still call, text or email them one to one\.$/);
    expect(s.getByRole('link', { name: 'Lead sources' })).toHaveAttribute('href', '/admin/lead-sources#review-sources');
    // it is a step of the flow: after the stage map, before the categories; and on the page once
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Review sources')).toBeGreaterThan(-1);
    expect(headings.indexOf('Review sources')).toBeLessThan(headings.indexOf('Categories'));
    expect(screen.getAllByRole('region', { name: 'Review sources' })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/SOURCE_UNCLASSIFIED|in_review|source_unclassified/);
  });

  it('R-LSRC-10 E748 E728: a CSV import shows the same step, worded for a file', async () => {
    const csv: ImportBatch['csv'] = { headers: ['First Name', 'Source'], mapping: [{ field: 'first_name' }, { field: 'lead_source' }] };
    leadAdminApp(fake(batch([stage('contacts', 'dry_run_ready')], { source: 'csv', fileLabel: 'old-crm.csv', csv }), () => ROWS), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = await step();
    expect(await s.findByText(/^Your file gives each person's source as a label, shown here exactly as it was imported\./)).toBeInTheDocument();
    for (const r of ROWS) expect(await s.findByText(r.sentence)).toBeInTheDocument();
    expect(await s.findByRole('button', { name: 'Confirm Open houses' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Columns')).toBeLessThan(headings.indexOf('Review sources'));
    expect(headings.indexOf('Review sources')).toBeLessThan(headings.indexOf('Categories'));
  });

  it('R-LSRC-10 E749: changing the dropdown maps nothing; the explicit button does, with the label exactly as received', async () => {
    let labels = ROWS;
    const f = fake(batch([stage('contacts', 'pending')]), () => labels);
    const after = labelRow('Sunday flyer', { people: 2, mappedTo: OPEN });
    f.on('PUT /lead-sources/import-labels', () => {
      labels = [after, suggested, mapped, blank];
      return { status: 200, body: { label: after, pausing: 0, stopping: 0, withdrawn: 0 } };
    });
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const u = userEvent.setup();
    const s = await step();
    const r = row(await step(), 'Source label "Sunday flyer"');
    const pick = await r.findByLabelText('Lead source for "Sunday flyer"');
    expect(pick).toHaveValue('');
    expect(r.queryByRole('button', { name: /^Map to/ })).toBeNull();
    await u.selectOptions(pick, OPEN.id);
    // only a choice so far: nothing was sent, and the row says what applying it will do
    expect(writes(f)).toHaveLength(0);
    expect(r.getByText(/^Automated contact for the people imported with this will follow the setting of Open houses\. Lead counts and reports do not change\./)).toBeInTheDocument();
    await u.selectOptions(pick, MARKED.id);
    expect(writes(f)).toHaveLength(0);
    expect(r.getByText('Northgate Referrals has "No automated contact for leads from this source" on: nothing automatic will go to the people imported with this, and plans running for them stop.')).toBeInTheDocument();
    await u.click(r.getByRole('button', { name: 'Cancel' }));
    expect(pick).toHaveValue('');
    await u.selectOptions(pick, OPEN.id);
    await u.click(r.getByRole('button', { name: 'Map to Open houses' }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(writes(f)[0]).toMatchObject({ method: 'PUT', path: '/lead-sources/import-labels', body: { label: 'Sunday flyer', leadSourceId: OPEN.id } });
    expect(await s.findByText(after.sentence, { selector: '[role="status"]' })).toBeInTheDocument();
    await waitFor(() => expect(s.getByText('Still in review: 1 label and the people with no source label (4 people). You can run the import with these left in review.')).toBeInTheDocument());
  });

  it('R-LSRC-10 E750 E741: an exact-match suggestion is only suggested; Confirm asks the server for exactly the source shown, and a suggestion that changed meanwhile maps nothing and reloads the list', async () => {
    let labels = ROWS;
    let answer: 'ok' | 'changed' = 'changed';
    const f = fake(batch([stage('contacts', 'pending')]), () => labels);
    const done = labelRow(' open houses', { people: 3, mappedTo: OPEN });
    f.on('POST /lead-sources/import-labels/confirm', () => {
      if (answer === 'changed') return err(409, 'IMPORT_LABEL_SUGGESTION_CHANGED', { state: 'ambiguous', suggestedLeadSourceId: null, leadSourceId: null });
      labels = [unknown, done, mapped, blank];
      return { status: 200, body: { label: done, pausing: 0, stopping: 0, withdrawn: 0 } };
    });
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const u = userEvent.setup();
    const s = await step();
    const r = row(await step(), 'Source label " open houses"');
    // suggested is not mapped: the dropdown is not pre-set to the suggestion
    expect(await r.findByLabelText('Lead source for " open houses"')).toHaveValue('');
    const before = f.callsTo(`GET /imports/${BID}/parity`).length;
    await u.click(r.getByRole('button', { name: 'Confirm Open houses' }));
    expect(await r.findByText('The suggestion for this label changed while you were looking at it. The list now shows what is true. Nothing was changed.')).toBeInTheDocument();
    expect(r.queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect(f.callsTo(`GET /imports/${BID}/parity`).length).toBeGreaterThan(before));
    expect(f.callsTo('POST /lead-sources/import-labels/confirm')[0]!.body).toEqual({ label: ' open houses', leadSourceId: OPEN.id });
    answer = 'ok';
    await u.click(r.getByRole('button', { name: 'Confirm Open houses' }));
    expect(await s.findByText(done.sentence, { selector: '[role="status"]' })).toBeInTheDocument();
    await waitFor(() => expect(row(s, 'Source label " open houses"').getByText('Mapped')).toBeInTheDocument());
    expect(f.callsTo('PUT /lead-sources/import-labels')).toHaveLength(0);
  });

  it("R-LSRC-10 E744 E749: the people imported with no source label are their own row, and the Owner's choice for it asks the server by the import, never with an empty label (which the server refuses)", async () => {
    let labels = [unknown, blank];
    const counted = labelRow('', { unlabeledImportId: BID, people: 1, mappedTo: MARKED });
    const f = fake(batch([stage('contacts', 'pending')]), () => labels);
    f.on('PUT /lead-sources/import-labels', () => {
      labels = [unknown, counted];
      return { status: 200, body: { label: counted, pausing: 1, stopping: 2, withdrawn: 1 } };
    });
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const u = userEvent.setup();
    const s = await step();
    const r = row(await step(), 'People imported with no source label');
    expect(r.getByText(blank.sentence)).toBeInTheDocument();
    await u.selectOptions(await r.findByLabelText(NO_LABEL_FIELD), MARKED.id);
    expect(writes(f)).toHaveLength(0);
    await u.click(r.getByRole('button', { name: 'Map to Northgate Referrals' }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(writes(f)[0]!.body).toEqual({ unlabeledImportId: BID, leadSourceId: MARKED.id });
    // mapped to a marked source: the counts are that source's own words
    expect(await s.findByText(`${counted.sentence} AI care already running for 1 of its leads will pause. 2 plans running for its leads will stop. 1 draft a plan or an alert wrote for them was withdrawn.`)).toBeInTheDocument();
    await waitFor(() => expect(row(s, 'People imported with no source label').getByText(counted.sentence)).toBeInTheDocument());
  });

  it('R-LSRC-10 E748: next to Approve and Import of the contacts category the page says what is still in review, and that the import may run anyway', async () => {
    const DRY = 'e'.repeat(64);
    const counts = { source: 9, willImport: 9, imported: null, needsReview: 0, rejected: 0, duplicate: 0 };
    leadAdminApp(fake(batch([stage('contacts', 'dry_run_ready', { counts, dryRunSha256: DRY })]), () => ROWS), `/imports/${BID}`, 'admin', { reauthenticatedAt: NOW() });
    const card = within((await screen.findByRole('heading', { name: '1. Contacts' })).closest('article')!);
    expect(await card.findByText('Still in review: 2 labels and the people with no source label (6 people). You can run the import with these left in review.')).toBeInTheDocument();
    expect(card.getByText(/^Those people get no automated contact until an Owner chooses a lead source in "Review sources" above, or later under Lead sources\./)).toBeInTheDocument();
    // nothing waits on the review: the approval is offered as before
    expect(card.getByRole('button', { name: 'Approve these 9 records' })).toBeEnabled();
  });

  it('R-LSRC-10 E748: when every source of the import is mapped the step says so, and the contacts category carries no reminder', async () => {
    const all = [labelRow('Sunday flyer', { people: 2, mappedTo: OPEN }), mapped];
    leadAdminApp(fake(batch([stage('contacts', 'approved')]), () => all), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = await step();
    expect(await s.findByText('Every source in this import is mapped to a lead source.')).toBeInTheDocument();
    expect(s.queryByText(IN_REVIEW_MEANS)).toBeNull();
    const card = within(screen.getByRole('heading', { name: '1. Contacts' }).closest('article')!);
    expect(card.queryByText(/Still in review/)).toBeNull();
  });

  it('R-LSRC-10 E748: the summary after the import repeats the review with the people it actually brought in, once, with the same controls for the Owner', async () => {
    const imported = [
      labelRow('Sunday flyer', { people: 2, committedPeople: 2, id: 'r0', firstSeen: { importId: BID, kind: 'fub_api', at: '2026-11-10T11:00:00.000Z' } }),
      labelRow(' open houses', { people: 3, committedPeople: 2, mappedTo: OPEN }),
      labelRow('', { unlabeledImportId: BID, people: 1, committedPeople: 1 }),
    ];
    const b = batch([stage('contacts', 'verified')]);
    expect(sourceReviewIsAStep(b)).toBe(false);
    leadAdminApp(fake(b, () => imported), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = within(await screen.findByRole('region', { name: 'Review sources' }));
    expect(s.getByRole('heading', { level: 3, name: 'Review sources' })).toBeInTheDocument();
    expect(s.getByText('Still in review after this import: 1 label and the people with no source label (3 people imported).')).toBeInTheDocument();
    expect(s.getByText(IN_REVIEW_MEANS)).toBeInTheDocument();
    for (const r of imported) expect(s.getByText(r.sentence)).toBeInTheDocument();
    expect(await row(s, 'Source label "Sunday flyer"').findByLabelText('Lead source for "Sunday flyer"')).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Review sources' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { level: 2, name: 'Review sources' })).toBeNull();
  });

  it('R-LSRC-10 E748: a summary with nothing left in review says so', async () => {
    leadAdminApp(fake(batch([stage('contacts', 'committed')]), () => [labelRow('Sunday flyer', { people: 2, committedPeople: 2, mappedTo: OPEN })]), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = within(await screen.findByRole('region', { name: 'Review sources' }));
    expect(s.getByText('Every source this import brought in is mapped to a lead source.')).toBeInTheDocument();
    expect(s.queryByText(IN_REVIEW_MEANS)).toBeNull();
  });

  it('R-LSRC-10 E755: before the import, a row mapped to a marked source says how many people of the file are already in the CRM and not covered by the mapping, and carries a warning chip; a row with nobody of the kind carries none', async () => {
    const partner = labelRow('Partner file', { people: 3, mappedTo: MARKED, file: { kind: 'csv', matchedOnly: 2, open: true } });
    expect(partner.matchedOnlyPeople).toBe(2);
    expect(partner.sentence).toBe(
      '"Partner file": 3 people in this file. None has been imported from this file yet. The label is mapped to Northgate Referrals, which has "No automated contact for leads from this source" on: that covers a person once their row is imported or attached, not before. 2 were already in the CRM and are not imported from this file, so this mapping does not cover them unless their row is attached. 1 other is not imported yet.',
    );
    const csv: ImportBatch['csv'] = { headers: ['First Name', 'Source'], mapping: [{ field: 'first_name' }, { field: 'lead_source' }] };
    leadAdminApp(fake(batch([stage('contacts', 'dry_run_ready')], { source: 'csv', fileLabel: 'partner.csv', csv }), () => [partner, mapped]), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = await step();
    const r = within(await s.findByRole('group', { name: 'Source label "Partner file"' }));
    expect(r.getByText(partner.sentence)).toBeInTheDocument();
    expect(r.getByText('Mapped · no automated contact')).toBeInTheDocument();
    expect(r.getByText('2 people already in the CRM are not covered')).toBeInTheDocument();
    // the old claim is not on the page for a row that counts the file's people
    expect(s.queryByText(/nothing automatic reaches the people imported with it/)).toBeNull();
    const other = row(s, 'Source label "Northgate referral desk"');
    expect(other.getByText(mapped.sentence)).toBeInTheDocument();
    expect(other.queryByText(/not covered/)).toBeNull();
  });

  it('R-LSRC-10 E755: the summary after the import says both numbers for a row mapped to a marked source: the people imported and covered, and the person already in the CRM whom the mapping does not cover, with the same chip', async () => {
    const partner = labelRow('Partner file', { people: 3, committedPeople: 2, mappedTo: MARKED, file: { kind: 'csv', matchedOnly: 1, open: false }, id: 'r7', firstSeen: { importId: BID, kind: 'csv', at: '2026-11-10T11:00:00.000Z' } });
    const group = labelRow('', { unlabeledImportId: BID, people: 1, committedPeople: 1, mappedTo: MARKED, file: { kind: 'csv', matchedOnly: 0, open: false } });
    expect(partner.sentence).toBe(
      '"Partner file": 3 people in this file. 2 were imported or attached and get no automated contact, because the label is mapped to Northgate Referrals, which has "No automated contact for leads from this source" on. 1 was already in the CRM and is not imported from this file, so this mapping does not cover them: their row is not attached.',
    );
    expect(group.sentence).toBe('No source label: 1 person in this file. 1 was imported or attached and gets no automated contact, because the people of this import with no source label are counted as Northgate Referrals, which has "No automated contact for leads from this source" on.');
    const b = batch([stage('contacts', 'verified')], { source: 'csv', fileLabel: 'partner.csv', csv: { headers: ['First Name', 'Source'], mapping: [{ field: 'first_name' }, { field: 'lead_source' }] } });
    expect(sourceReviewIsAStep(b)).toBe(false);
    leadAdminApp(fake(b, () => [partner, group]), `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const s = within(await screen.findByRole('region', { name: 'Review sources' }));
    expect(s.getByRole('heading', { level: 3, name: 'Review sources' })).toBeInTheDocument();
    const r = within(await s.findByRole('group', { name: 'Source label "Partner file"' }));
    expect(r.getByText(partner.sentence)).toBeInTheDocument();
    expect(r.getByText('1 person already in the CRM is not covered')).toBeInTheDocument();
    const g = row(s, 'People imported with no source label');
    expect(g.getByText(group.sentence)).toBeInTheDocument();
    expect(g.queryByText(/not covered/)).toBeNull();
    expect(s.queryByText(/nothing automatic reaches/)).toBeNull();
  });

  it('R-LSRC-10 E751: an Admin runs the import and reads the review, with no control the server would refuse', async () => {
    const f = fake(batch([stage('contacts', 'pending')]), () => ROWS);
    leadAdminApp(f, `/imports/${BID}`, 'admin', { reauthenticatedAt: NOW() });
    const s = await step();
    for (const r of ROWS) expect(await s.findByText(r.sentence)).toBeInTheDocument();
    expect(s.getByText(OWNER_MAPS_LABELS)).toBeInTheDocument();
    expect(s.queryByRole('combobox')).toBeNull();
    expect(s.queryByRole('button')).toBeNull();
    // an Admin's page never asks for the Owner's list of lead sources to choose from
    expect(f.callsTo('GET /lead-sources/overview')).toHaveLength(0);
  });

  it('R-LSRC-10 E751: the step says it is loading; a failed load is one error with Try again; an import with no people has nothing to review', async () => {
    let failing = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fake(batch([stage('contacts', 'pending')]), () => []);
    f.on(`GET /imports/${BID}/parity`, async () => {
      if (!failing) return { status: 200, body: parity([]) };
      await gate;
      return err(500, 'INTERNAL_ERROR');
    });
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: NOW() });
    const u = userEvent.setup();
    const s = await step();
    expect(s.getByText('Loading the sources of this import')).toBeInTheDocument();
    release();
    const retry = await s.findByRole('button', { name: 'Try again' });
    // one failed read is one error on the page, not one per section that uses it
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    failing = false;
    await u.click(retry);
    expect(await s.findByText('This import has no people, so there is no source to review.')).toBeInTheDocument();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});
