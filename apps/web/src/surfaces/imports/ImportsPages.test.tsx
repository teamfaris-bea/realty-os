// Staged imports in jsdom. The stage machine itself (R-IMPORT-2 approval CHECK, R-IMPORT-3 order
// trigger, R-IMPORT-4 commit of exactly the reviewed snapshot, R-IMPORT-5 verification) is enforced
// and proven by api/imports against Postgres; these tests prove the page: counts first and nothing
// promised, the per-record review list, approval bound to the snapshot hash, the commit waiting for
// earlier categories, verification only after a matching recount and every side-by-side check, and
// re-auth on every import call.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, leadAdminApp } from '../admin/lib/testing.js';
import type { ImportBatch, ImportCategory, ImportStage } from '../admin/lib/types.js';
import { blockingEarlier, canSkipStage, canUndoStage, consentNeedsDryRunToSkip, nextStep, ordered, reconciles, recordSummary, spotChecksReady, toBase64 } from './lib.js';

const SNAP = 'b'.repeat(64);
const BID = '01900000-0000-7000-8000-0000000b0001';
const SEQ: Record<ImportCategory, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6 };

function stage(category: ImportCategory, status: string, over: Partial<ImportStage> = {}): ImportStage {
  return { id: `st-${category}`, category, seq: SEQ[category], status, counts: null, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null, ...over };
}

function batch(stages: ImportStage[], over: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: BID,
    source: 'fub_api',
    status: 'dry_run',
    sourceCounts: { contacts: 1200 },
    snapshotSha256: SNAP,
    snapshotAt: '2026-11-10T10:00:00.000Z',
    snapshotError: null,
    fileLabel: null,
    csv: null,
    createdAt: '2026-11-10T09:00:00.000Z',
    createdByUserId: 'u',
    revertedAt: null,
    stages,
    connectionTest: ['1,200 contacts in Follow Up Boss', '310 had texting permission there'],
    ...over,
  };
}

const counts = { source: 1200, willImport: 1150, imported: null, needsReview: 30, rejected: 5, duplicate: 15 };

function importFake(b: ImportBatch) {
  return new FakeFetch()
    .on(`GET /imports/${BID}`, { status: 200, body: { batch: b } })
    .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [] } })
    .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } })
    .on('GET /members', { status: 200, body: { members: [], invites: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } });
}

describe('import helpers', () => {
  it('a commit waits for every earlier category to be verified or skipped', () => {
    const st = [stage('contacts', 'committed'), stage('ownership', 'skipped'), stage('notes', 'approved')];
    expect(blockingEarlier(st[2]!, st).map((s) => s.category)).toEqual(['contacts']);
    expect(blockingEarlier(st[2]!, [stage('contacts', 'verified'), st[1]!, st[2]!])).toEqual([]);
    expect(ordered([stage('consent', 'pending'), stage('contacts', 'pending')]).map((s) => s.category)).toEqual(['contacts', 'consent']);
  });

  it('what each status needs next; nothing can be dry-run before the snapshot exists', () => {
    const b = { snapshotSha256: SNAP, status: 'dry_run' };
    expect(nextStep(stage('contacts', 'pending'), b)).toBe('dry_run');
    expect(nextStep(stage('contacts', 'pending'), { ...b, snapshotSha256: null })).toBe('none');
    expect(nextStep(stage('contacts', 'dry_run_ready'), b)).toBe('review');
    expect(nextStep(stage('contacts', 'approved'), b)).toBe('commit');
    expect(nextStep(stage('contacts', 'committed'), b)).toBe('verify');
    expect(nextStep(stage('contacts', 'committing'), b)).toBe('running');
    expect(nextStep(stage('contacts', 'verified'), b)).toBe('done');
    expect(nextStep(stage('contacts', 'approved'), { ...b, status: 'reverted' })).toBe('none');
  });

  it('counts reconcile only when every source record is accounted for; spot checks need every sample marked', () => {
    expect(reconciles(counts)).toBe(true);
    expect(reconciles({ ...counts, rejected: 4 })).toBe(false);
    expect(spotChecksReady([{ sourceRef: 'a' }, { sourceRef: 'b' }], new Map([['a', true]]))).toBe(false);
    expect(spotChecksReady([{ sourceRef: 'a' }], new Map([['a', false]]))).toBe(true);
    expect(spotChecksReady([], new Map())).toBe(true);
  });

  it('summarises records and encodes files', () => {
    expect(recordSummary({ displayName: 'Jane Doe', phones: ['+14155550100'], emails: ['j@x.test'] })).toBe('Jane Doe · +14155550100 · j@x.test');
    expect(recordSummary({ personRef: 'p:9', preview: 'Called about 12 Oak' })).toBe('“Called about 12 Oak”');
    expect(recordSummary(null)).toBe('No details');
    expect(toBase64(new TextEncoder().encode('name,phone\n'))).toBe(btoa('name,phone\n'));
  });

  it('offers Skip and per-category Undo only where the server would accept them (M7)', () => {
    // consent: the server refuses a skip before its dry run (consent_dry_run_required) unless contacts are skipped
    // or a CSV maps no consent column (stages.ts consentSkipBlocker)
    const fub = { source: 'fub_api' as const, csv: null, status: 'dry_run' };
    const pending = [stage('contacts', 'verified'), stage('consent', 'pending')];
    expect(consentNeedsDryRunToSkip(pending[1]!, pending, fub)).toBe(true);
    expect(canSkipStage(pending[1]!, pending, fub)).toBe(false);
    const ready = [stage('contacts', 'verified'), stage('consent', 'dry_run_ready')];
    expect(canSkipStage(ready[1]!, ready, fub)).toBe(true);
    const noContacts = [stage('contacts', 'skipped'), stage('consent', 'pending')];
    expect(canSkipStage(noContacts[1]!, noContacts, fub)).toBe(true);
    const csvNoConsent = { source: 'csv' as const, csv: { headers: ['Name'], mapping: [{ field: 'full_name' }] }, status: 'dry_run' };
    expect(canSkipStage(pending[1]!, pending, csvNoConsent)).toBe(true);
    const csvConsent = { ...csvNoConsent, csv: { headers: ['Name', 'DNC'], mapping: [{ field: 'full_name' }, { field: 'do_not_contact' }] } };
    expect(canSkipStage(pending[1]!, pending, csvConsent)).toBe(false);
    expect(canSkipStage(stage('notes', 'pending'), pending, fub)).toBe(true);
    // undo runs latest category first (IMPORT_REVERT_ORDER): only the last imported category offers it
    const st = [stage('contacts', 'verified'), stage('ownership', 'verified'), stage('notes', 'committed'), stage('messages', 'skipped')];
    expect(st.filter((x) => canUndoStage(x, st, fub)).map((x) => x.category)).toEqual(['notes']);
    expect(canUndoStage(st[2]!, st, { status: 'reverted' })).toBe(false);
  });
});

describe('Imports', () => {
  it('a new Follow Up Boss import only counts first, then opens the import', async () => {
    const created = batch([stage('contacts', 'pending')], { status: 'connection_test', snapshotSha256: null, snapshotAt: null });
    const fake = importFake(created)
      .on('GET /imports', { status: 200, body: { batches: [] } })
      .on('POST /imports', { status: 201, body: { batch: created } });
    leadAdminApp(fake, '/imports', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText(/First we only count what is there. Nothing is imported until you review and approve each category./)).toBeInTheDocument();
    await u.type(screen.getByLabelText('Follow Up Boss API key'), 'fub_secret_key_123');
    await u.click(screen.getByRole('button', { name: "Count what's there" }));
    expect(await screen.findByText('1,200 contacts in Follow Up Boss')).toBeInTheDocument();
    expect(screen.getByText('Nothing has been imported. Next, take a snapshot: every later step works from that copy.')).toBeInTheDocument();
    expect(fake.callsTo('POST /imports')[0]!.body).toEqual({ source: 'fub_api', apiKey: 'fub_secret_key_123' });
    expect(screen.queryByRole('button', { name: 'Run dry run' })).toBeNull();
  });

  it('a CSV import can take its snapshot (the step before any dry run), and offers no second one after', async () => {
    const csv: ImportBatch['csv'] = { headers: ['First Name', 'Phone'], mapping: [{ field: 'first_name' }, { field: 'phone' }] };
    const created = batch([stage('contacts', 'pending')], { source: 'csv', fileLabel: 'old-crm.csv', csv, status: 'connection_test', snapshotSha256: null, snapshotAt: null });
    const fake = importFake(created).on(`POST /imports/${BID}/snapshot`, { status: 202, body: { batch: { ...created, status: 'snapshotting' } } });
    leadAdminApp(fake, `/imports/${BID}`, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Take snapshot' }));
    await waitFor(() => expect(fake.callsTo(`POST /imports/${BID}/snapshot`)).toHaveLength(1));
  });

  it('a CSV import with its snapshot taken offers no "new snapshot" (the file cannot change)', async () => {
    const csv: ImportBatch['csv'] = { headers: ['First Name'], mapping: [{ field: 'first_name' }] };
    leadAdminApp(importFake(batch([stage('contacts', 'pending')], { source: 'csv', fileLabel: 'old-crm.csv', csv })), `/imports/${BID}`, 'owner');
    expect(await screen.findByText(/Working from the snapshot taken/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /snapshot/i })).toBeNull();
  });

  it('listing imports asks for the password first when the last confirmation is old, then loads', async () => {
    let n = 0;
    const fake = new FakeFetch()
      .on('GET /imports', () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { batches: [batch([stage('contacts', 'verified')])] } }))
      .on('POST /auth/reauth', { status: 200, body: { session: { user: { id: 'u', email: 'o@x.test', displayName: 'O' }, tenant: { id: 't', name: 'T', slug: 't', role: 'owner' }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'c2' } } });
    leadAdminApp(fake, '/imports', 'owner');
    const u = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'pw');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/1 of 1 category verified/)).toBeInTheDocument();
  });

  it('a ready dry run shows the five counts, the review list by outcome, and approval of exactly this dry run', async () => {
    // the approval presents the digest of the dry run the reviewer saw (stage.dryRunSha256: core snapshotDigest
    // of the category's records), which is NOT the batch's snapshot file digest; the server refuses any other
    // value with SNAPSHOT_CHANGED (stages.ts approveStage, E42), so sending the batch digest made Approve fail always
    const DRY = 'd'.repeat(64);
    const b = batch([stage('contacts', 'dry_run_ready', { counts, dryRunSha256: DRY })]);
    const rec = { id: '01900000-0000-7000-8000-0000000ec001', sourceRef: 'fub:person:77', outcome: 'needs_review', dryRunOutcome: 'needs_review', planned: 'create contact', issues: [{ code: 'PHONE_INVALID', severity: 'review', field: 'phone', sentence: '555-0100 has no area code, so it was left out.' }], record: { displayName: 'Jane Doe', phones: [], emails: ['jane@x.test'] }, matchContactId: null, duplicateCandidates: [], optOutNote: null, review: null, targetId: null };
    const fake = importFake(b)
      .on(`GET /imports/${BID}/stages/contacts/records?outcome=needs_review&limit=50`, { status: 200, body: { records: [rec], next: null } })
      .on(`POST /imports/${BID}/records/${rec.id}/review`, { status: 200, body: { record: { ...rec, review: { decision: 'import', byUserId: 'u', mergeIntoContactId: null } } } })
      .on(`POST /imports/${BID}/stages/contacts/approve`, { status: 200, body: { batch: b, expected: { source: 1200, imported: 1150, needs_review: 30, rejected: 5, duplicate: 15 } } });
    leadAdminApp(fake, `/imports/${BID}`, 'admin');
    const u = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: '1. Contacts' })).closest('article')!;
    for (const [l, n] of [['In the source', '1200'], ['Will import', '1150'], ['Needs review', '30'], ['Rejected', '5'], ['Possible duplicates', '15']] as const) expect(within(card).getByText(l).nextSibling?.textContent).toBe(n);
    await u.click(within(card).getByRole('button', { name: 'Review records' }));
    expect(await within(card).findByText('555-0100 has no area code, so it was left out.')).toBeInTheDocument();
    expect(within(card).getByRole('radio', { name: 'Needs review 30' })).toBeChecked();
    await u.click(within(card).getByRole('button', { name: 'Import it' }));
    expect(await within(card).findByText('Decided: import')).toBeInTheDocument();
    expect(fake.callsTo(`POST /imports/${BID}/records/${rec.id}/review`)[0]!.body).toEqual({ decision: 'import' });
    await u.click(within(card).getByRole('button', { name: 'Approve these 1150 records' }));
    await waitFor(() => expect(fake.callsTo(`POST /imports/${BID}/stages/contacts/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /imports/${BID}/stages/contacts/approve`)[0]!.body).toEqual({ snapshotSha256: DRY });
    expect(DRY).not.toBe(SNAP);
  });

  it('an approved category waits for earlier ones to be verified or skipped, and says which', async () => {
    const b = batch([stage('contacts', 'committed', { counts: { ...counts, imported: 1150 } }), stage('ownership', 'approved', { counts })]);
    leadAdminApp(importFake(b).on(`GET /imports/${BID}/stages/contacts/verification`, { status: 200, body: { expected: { source: 1, imported: 1, needs_review: 0, rejected: 0, duplicate: 0 }, db: { source: 1, imported: 1, needs_review: 0, rejected: 0, duplicate: 0 }, matches: true, diffs: [], sample: [] } }), `/imports/${BID}`, 'owner');
    const card = (await screen.findByRole('heading', { name: '2. Who owns each contact' })).closest('article')!;
    expect(within(card).getByRole('button', { name: 'Import who owns each contact' })).toBeDisabled();
    expect(within(card).getByText('Waiting for Contacts to be verified or skipped.')).toBeInTheDocument();
  });

  it('the consent category is "Opt-outs and consent history": opt-outs carry over and block sending; skipping it says what is lost', async () => {
    const b = batch([stage('contacts', 'verified'), stage('consent', 'pending')]);
    leadAdminApp(importFake(b), `/imports/${BID}`, 'owner');
    const card = (await screen.findByRole('heading', { name: '6. Opt-outs and consent history' })).closest('article')!;
    expect(within(card).getByText(/Opt-outs carry over and block texts, email or calls here/)).toBeInTheDocument();
    expect(within(card).getByText(/Opt-ins are kept as history only/)).toBeInTheDocument();
    expect(within(card).getByText(/If you skip this, opt-outs from the old system won't carry over/)).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/Texting and email permission/);
  });

  it('verify needs a matching recount and every side-by-side check marked; a mismatch blocks it', async () => {
    const b = batch([stage('contacts', 'committed', { counts: { ...counts, imported: 1150 } })]);
    const c = { source: 1200, imported: 1150, needs_review: 30, rejected: 5, duplicate: 15 };
    const sample = [
      { sourceRef: 'fub:person:1', recordId: 'r1', source: { displayName: 'Jane Doe' }, imported: { displayName: 'Jane Doe' }, same: true },
      { sourceRef: 'fub:person:2', recordId: 'r2', source: { displayName: 'Pat Lee' }, imported: { displayName: 'Pat Lee' }, same: true },
    ];
    const fake = importFake(b)
      .on(`GET /imports/${BID}/stages/contacts/verification`, { status: 200, body: { expected: c, db: c, matches: true, diffs: [], sample } })
      .on(`POST /imports/${BID}/stages/contacts/verify`, { status: 200, body: { batch: b } });
    leadAdminApp(fake, `/imports/${BID}`, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('The recount matches.')).toBeInTheDocument();
    const verify = screen.getByRole('button', { name: 'Mark verified' });
    expect(verify).toBeDisabled();
    const g1 = screen.getByRole('group', { name: 'Check fub:person:1' });
    const g2 = screen.getByRole('group', { name: 'Check fub:person:2' });
    await u.click(within(g1).getByRole('button', { name: 'Same' }));
    expect(verify).toBeDisabled();
    await u.click(within(g2).getByRole('button', { name: 'Different' }));
    expect(screen.getByText(/A record you marked different means this category should not be verified/)).toBeInTheDocument();
    expect(verify).toBeDisabled();
    await u.click(within(g2).getByRole('button', { name: 'Same' }));
    await u.click(verify);
    await waitFor(() => expect(fake.callsTo(`POST /imports/${BID}/stages/contacts/verify`)).toHaveLength(1));
    expect(fake.callsTo(`POST /imports/${BID}/stages/contacts/verify`)[0]!.body).toEqual({
      spotChecks: [
        { sourceRef: 'fub:person:1', matches: true },
        { sourceRef: 'fub:person:2', matches: true },
      ],
    });
  });

  it('a recount that does not match is shown with the differing count and cannot be verified', async () => {
    const b = batch([stage('contacts', 'committed', { counts: { ...counts, imported: 1149 } })]);
    const exp = { source: 1200, imported: 1150, needs_review: 30, rejected: 5, duplicate: 15 };
    leadAdminApp(importFake(b).on(`GET /imports/${BID}/stages/contacts/verification`, { status: 200, body: { expected: exp, db: { ...exp, imported: 1149 }, matches: false, diffs: [{ key: 'imported', source: 1150, db: 1149 }], sample: [] } }), `/imports/${BID}`, 'owner');
    expect(await screen.findByText(/The recount does not match, so this can't be verified/)).toBeInTheDocument();
    expect(screen.getByText('1149')).toHaveClass('text-danger');
    expect(screen.getByRole('button', { name: 'Mark verified' })).toBeDisabled();
  });

  it('counts that do not add up are called out before approval', async () => {
    leadAdminApp(importFake(batch([stage('contacts', 'dry_run_ready', { counts: { ...counts, rejected: 4 } })])), `/imports/${BID}`, 'owner');
    expect(await screen.findByText("These counts don't add up to the source total. Run the dry run again before approving.")).toBeInTheDocument();
  });

  it('the report shows the server-written lines; undoing a verified category is per category', async () => {
    const b = batch([stage('contacts', 'verified', { counts: { ...counts, imported: 1150 }, verifiedAt: '2026-11-10T12:00:00.000Z' })]);
    const fake = importFake(b)
      .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [{ category: 'contacts', status: 'verified', phase: 'committed', source: 1200, imported: 1150, needsReview: 30, rejected: 5, duplicate: 15, reconciles: true, lines: ['1,150 of 1,200 contacts imported. 30 need your review.'] }] } })
      .on(`POST /imports/${BID}/revert`, { status: 202, body: { batch: b, queued: 'job' } });
    leadAdminApp(fake, `/imports/${BID}`, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('1,150 of 1,200 contacts imported. 30 need your review.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Undo this category' }));
    await waitFor(() => expect(fake.callsTo(`POST /imports/${BID}/revert`)).toHaveLength(1));
    expect(fake.callsTo(`POST /imports/${BID}/revert`)[0]!.body).toEqual({ category: 'contacts' });
  });

  it('every Follow Up Boss agent is matched before ownership: unmatched people are counted and saved matches are sent', async () => {
    const b = batch([stage('contacts', 'verified'), stage('ownership', 'pending')]);
    const fake = importFake(b)
      .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [{ sourceRef: 'fub:user:5', label: 'Dana (FUB)', people: 420, target: null }], ponds: [], unmapped: 1, complete: false } })
      .on('GET /members', { status: 200, body: { members: [{ userId: '01900000-0000-7000-8000-0000000000a1', displayName: 'Ava Agent', email: '', role: 'agent', status: 'active', acceptingLeads: true, mfaEnabled: false, joinedAt: null, version: 1 }], invites: [] } })
      .on(`PUT /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } });
    leadAdminApp(fake, `/imports/${BID}`, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('1 person still to match.')).toBeInTheDocument();
    await u.selectOptions(await screen.findByLabelText('Dana (FUB) (420 contacts)'), 'user:01900000-0000-7000-8000-0000000000a1');
    await u.click(screen.getByRole('button', { name: 'Save matches' }));
    expect(await screen.findByText('Everyone is matched')).toBeInTheDocument();
    expect(fake.callsTo(`PUT /imports/${BID}/user-mappings`)[0]!.body).toEqual({ mappings: [{ sourceRef: 'fub:user:5', kind: 'user', target: { kind: 'user', userId: '01900000-0000-7000-8000-0000000000a1' } }] });
  });

  it('consent before its dry run offers no Skip (the server refuses it) and says to run the dry run first (M7)', async () => {
    const b = batch([stage('contacts', 'verified'), stage('consent', 'pending')]);
    leadAdminApp(importFake(b), `/imports/${BID}`, 'owner');
    const card = (await screen.findByRole('heading', { name: '6. Opt-outs and consent history' })).closest('article')!;
    expect(within(card).getByRole('button', { name: 'Run dry run' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Skip this category' })).toBeNull();
    expect(within(card).getByText('To skip it, run its dry run first, so you can see which opt-outs would not carry over.')).toBeInTheDocument();
  });

  it('only the last imported category offers "Undo this category" (undo runs latest first) (M7)', async () => {
    const b = batch([stage('contacts', 'verified'), stage('ownership', 'verified'), stage('notes', 'verified')]);
    leadAdminApp(importFake(b), `/imports/${BID}`, 'owner');
    const notes = (await screen.findByRole('heading', { name: '3. Notes' })).closest('article')!;
    expect(within(notes).getByRole('button', { name: 'Undo this category' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo this category' })).toHaveLength(1);
  });

  it('the tables that scroll sideways on a phone sit in a named, keyboard-focusable region (axe scrollable-region-focusable) (M7)', async () => {
    const b = batch([stage('contacts', 'committed', { counts: { ...counts, imported: 1150 } })]);
    const c = { source: 1200, imported: 1150, needs_review: 30, rejected: 5, duplicate: 15 };
    const parity = { phase: 'committed', rows: [{ category: 'stages', source: 3, imported: 3, needsReview: 0, rejected: 0, duplicate: 0 }], lines: [] };
    const fake = importFake(b)
      .on(`GET /imports/${BID}/stages/contacts/verification`, { status: 200, body: { expected: c, db: c, matches: true, diffs: [], sample: [] } })
      .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [], parity } });
    leadAdminApp(fake, `/imports/${BID}`, 'owner');
    const recount = await screen.findByRole('region', { name: 'Recount of contacts' });
    expect(recount).toHaveAttribute('tabindex', '0');
    expect(within(recount).getByRole('table')).toBeInTheDocument();
    const report = await screen.findByRole('region', { name: 'Counts for stages, tags and fields' });
    expect(report).toHaveAttribute('tabindex', '0');
    expect(within(report).getByRole('table')).toBeInTheDocument();
  });
});
