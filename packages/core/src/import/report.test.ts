import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ContactId, UserId } from '../foundation/index.js';
import {
  type Counts,
  NO_DOCUMENTED,
  SPOT_CHECKS,
  batchReport,
  buildExistingIndex,
  buildVerification,
  commitPlan,
  dryRun,
  expectedAfterCommit,
  mapFub,
  notImportedLines,
  optOutPreview,
  reconciles,
  reportLines,
  spotCheckSample,
  verificationReport,
} from './index.js';
import { FUB_EXPORT, T0, USERS, emptyIndexInput, existingContact, testKey } from './testing/fixtures.js';

const ADMIN = '00000000-0000-7000-8000-0000000000ad' as UserId;
const counts = (source: number, imported: number, needs_review: number, rejected: number, duplicate: number): Counts => ({ source, imported, needs_review, rejected, duplicate });

describe('verification (R-IMPORT-5)', () => {
  it('R-IMPORT-5 the recount matches only when every count is equal and both sides reconcile exactly', () => {
    expect(verificationReport(counts(10, 6, 2, 1, 1), counts(10, 6, 2, 1, 1))).toEqual({ matches: true, diffs: [], reconciles: { source: true, db: true } });
    expect(verificationReport(counts(10, 6, 2, 1, 1), counts(10, 5, 3, 1, 1))).toEqual({
      matches: false,
      diffs: [
        { key: 'imported', source: 6, db: 5 },
        { key: 'needs_review', source: 2, db: 3 },
      ],
      reconciles: { source: true, db: true },
    });
    // Equal but not reconciling (a lost record) is not a match.
    expect(verificationReport(counts(10, 6, 2, 1, 0), counts(10, 6, 2, 1, 0)).matches).toBe(false);
  });

  it('R-IMPORT-5 property: verificationReport matches iff the two sides are equal and reconcile', () => {
    const c = fc.tuple(fc.nat(50), fc.nat(50), fc.nat(50), fc.nat(50)).map(([a, b, d, e]) => counts(a + b + d + e, a, b, d, e));
    fc.assert(
      fc.property(c, c, (x, y) => {
        const same = JSON.stringify(x) === JSON.stringify(y);
        expect(verificationReport(x, y).matches).toBe(same);
      }),
    );
  });

  it('R-IMPORT-5 20 side-by-side spot checks: a deterministic sample per seed, all must be checked and match, recorded with the verifier', () => {
    const refs = Array.from({ length: 500 }, (_, i) => `fub:people/${i}`);
    const sample = spotCheckSample(refs, 'stage-1');
    expect(sample).toHaveLength(SPOT_CHECKS);
    expect(spotCheckSample(refs, 'stage-1')).toEqual(sample);
    expect(spotCheckSample(refs, 'stage-2')).not.toEqual(sample);
    expect(spotCheckSample(refs.slice(0, 3), 'x')).toHaveLength(3);

    const exp = counts(500, 500, 0, 0, 0);
    const base = { expected: exp, db: exp, sample, verifierUserId: ADMIN, at: T0 };
    expect(buildVerification({ ...base, db: counts(500, 499, 0, 1, 0), spotChecks: [] })).toMatchObject({ ok: false, code: 'RECOUNT_MISMATCH' });
    expect(buildVerification({ ...base, spotChecks: sample.slice(0, 19).map((r) => ({ sourceRef: r, matches: true })) })).toEqual({ ok: false, code: 'SPOT_CHECKS_INCOMPLETE', sourceRefs: [sample[19]] });
    expect(buildVerification({ ...base, sample: sample.slice(0, 5), spotChecks: [] })).toMatchObject({ ok: false, code: 'SPOT_CHECKS_INCOMPLETE' });
    expect(buildVerification({ ...base, spotChecks: sample.map((r, i) => ({ sourceRef: r, matches: i !== 7 })) })).toEqual({ ok: false, code: 'SPOT_CHECK_FAILED', sourceRefs: [sample[7]] });
    const ok = buildVerification({ ...base, spotChecks: sample.map((r) => ({ sourceRef: r, matches: true })) });
    expect(ok).toMatchObject({ ok: true, verification: { verifiedByUserId: ADMIN, verifiedAt: T0, recount: { expected: exp, db: exp } } });
    expect(ok.ok && ok.verification.spotChecks).toHaveLength(20);
    // Fewer than 20 imported: every imported record is checked.
    const small = counts(3, 3, 0, 0, 0);
    const s3 = spotCheckSample(['a', 'b', 'c'], 'x');
    expect(buildVerification({ expected: small, db: small, sample: s3, spotChecks: s3.map((r) => ({ sourceRef: r, matches: true })), verifierUserId: ADMIN, at: T0 }).ok).toBe(true);
  });

  it('E230 R-IMPORT-5 owner decision B4: a planned assignment the commit brought in unassigned (its member could no longer hold leads) moves from imported to rejected: a documented outcome, never a mismatch', () => {
    const approved = counts(7, 4, 0, 2, 1);
    const db = counts(7, 2, 0, 4, 1);
    expect(expectedAfterCommit(approved, { unassigned: 2 })).toEqual(db);
    expect(expectedAfterCommit(approved, NO_DOCUMENTED)).toEqual(approved);
    const sample = ['fub:people/1', 'fub:people/3'];
    const spotChecks = sample.map((r) => ({ sourceRef: r, matches: true }));
    const base = { expected: approved, db, sample, spotChecks, verifierUserId: ADMIN, at: T0 };
    // before B4: the two people of the suspended member stalled the stage for ever
    expect(buildVerification(base)).toMatchObject({ ok: false, code: 'RECOUNT_MISMATCH' });
    const ok = buildVerification({ ...base, documented: { unassigned: 2 } });
    expect(ok).toMatchObject({ ok: true, verification: { recount: { approved, expected: db, db }, documented: { unassigned: 2 } } });
    // the documented count explains exactly those records: it never hides another difference
    expect(buildVerification({ ...base, documented: { unassigned: 1 } })).toEqual({
      ok: false,
      code: 'RECOUNT_MISMATCH',
      diffs: [
        { key: 'imported', source: 3, db: 2 },
        { key: 'rejected', source: 3, db: 4 },
      ],
    });
    expect(buildVerification({ ...base, db: counts(7, 2, 1, 3, 1), documented: { unassigned: 2 } })).toMatchObject({ ok: false, code: 'RECOUNT_MISMATCH' });
    // more documented than the approval planned to import can never reconcile
    expect(expectedAfterCommit(approved, { unassigned: 5 }).imported).toBe(-1);
    expect(buildVerification({ ...base, db: counts(7, 0, 0, 6, 1), documented: { unassigned: 5 } })).toMatchObject({ ok: false, code: 'RECOUNT_MISMATCH' });
  });

  it('E230 property: the documented outcome keeps the expectation reconciling, and a real recount verifies only when exactly those k records moved', () => {
    const c = fc.tuple(fc.nat(50), fc.nat(50), fc.nat(50), fc.nat(50)).map(([a, b, d, e]) => counts(a + b + d + e, a, b, d, e));
    fc.assert(
      fc.property(c, fc.nat(60), fc.nat(60), (approved, k, m) => {
        const after = expectedAfterCommit(approved, { unassigned: k });
        expect(reconciles(after)).toBe(true);
        // a real recount: some of the planned imports (never more) were brought in unassigned at the commit
        const moved = m % (approved.imported + 1);
        const db = { ...approved, imported: approved.imported - moved, rejected: approved.rejected + moved };
        expect(verificationReport(after, db).matches).toBe(moved === k);
      }),
    );
  });

  it('the report counts reconcile exactly for a real dry run → commit plan of the golden fixture', () => {
    const idx = buildExistingIndex(emptyIndexInput());
    for (const c of ['contacts', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
      const raws = c === 'contacts' || c === 'consent' ? FUB_EXPORT.people : c === 'notes' ? FUB_EXPORT.notes : c === 'messages' ? [...FUB_EXPORT.textMessages, ...FUB_EXPORT.emails] : FUB_EXPORT.calls;
      const d = dryRun(c, raws.map((r) => mapFub(c, r, USERS)), idx);
      const p = commitPlan(d, [], d.snapshotSha256, idx);
      expect(p.ok && reconciles(p.expected), c).toBe(true);
      expect(p.ok && p.expected.source, c).toBe(raws.length);
    }
  });
});

describe('report rows and copy', () => {
  it('rows come in stage order with a reconciliation flag', () => {
    const rows = batchReport([
      { category: 'consent', counts: counts(3, 1, 1, 1, 0) },
      { category: 'contacts', counts: counts(5, 4, 0, 1, 0) },
      { category: 'notes', counts: counts(2, 1, 0, 0, 0) },
    ]);
    expect(rows.map((r) => [r.category, r.reconciles])).toEqual([
      ['contacts', true],
      ['notes', false],
      ['consent', true],
    ]);
  });

  it('copy is plain, says will/did honestly, and every number in it is one of the counts', () => {
    const c = counts(1204, 1180, 12, 9, 3);
    const dry = reportLines('contacts', 'dry_run', c, 'Follow Up Boss');
    expect(dry).toEqual(['1,204 contacts in Follow Up Boss.', '1,180 will be imported · 12 need your review · 9 will not be imported (see reasons) · 3 already here or nothing new.']);
    expect(reportLines('contacts', 'committed', counts(1, 1, 1, 0, 0), 'your file')).toEqual(['1 contact in your file.', '1 imported · 1 needs your review · 0 not imported (see reasons) · 0 already here or nothing new.']);
    const consent = reportLines('consent', 'committed', counts(400, 380, 0, 0, 20), 'Follow Up Boss', { textingPermission: 312, emailPermission: 200, optedOut: 41, doNotContact: 1 });
    expect(consent.slice(2)).toEqual([
      "312 contacts had texting permission in Follow Up Boss. We kept that as history; the assistant won't text them automatically until they confirm.",
      '41 contacts had opted out. They stay opted out.',
      '1 contact was marked do not contact. That stays.',
    ]);
    const allowed = new Set(['400', '380', '0', '20', '312', '41', '1']);
    for (const line of consent) for (const num of line.match(/\d[\d,]*/g) ?? []) expect(allowed.has(num.replace(/,/g, ''))).toBe(true);
    expect(reportLines('call_recordings', 'committed', counts(2, 2, 0, 0, 0), 'Follow Up Boss')[2]).toBe('Imported recordings are labelled "recording notice unknown" and are not transcribed.');
  });

  it('E233 R-IMPORT-1 owner decision B7: what Follow Up Boss has that the import never brings over, said plainly; every number is a count', () => {
    const tail = "Realty OS doesn't bring tasks or appointments over: finish or note the open ones in Follow Up Boss before you switch.";
    expect(notImportedLines({ tasks: 1240, appointments: 85 }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 1,240 tasks and 85 appointments. ${tail}`]);
    expect(notImportedLines({ tasks: 1, appointments: 1 }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 1 task and 1 appointment. ${tail}`]);
    expect(notImportedLines({ tasks: 0, appointments: 3 }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 0 tasks and 3 appointments. ${tail}`]);
    expect(notImportedLines({ tasks: 0, appointments: 0 }, 'Follow Up Boss')).toEqual(["Follow Up Boss has no tasks or appointments. Realty OS doesn't bring tasks or appointments over."]);
    // a count it could not read is said so, never guessed, and the warning stays
    expect(notImportedLines({ tasks: 12, appointments: null }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 12 tasks; we could not count its appointments. ${tail}`]);
    expect(notImportedLines({ tasks: null, appointments: 1 }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 1 appointment; we could not count its tasks. ${tail}`]);
    expect(notImportedLines({ tasks: null, appointments: null }, 'Follow Up Boss')).toEqual([`We could not count tasks or appointments in Follow Up Boss. ${tail}`]);
    // a CSV file has neither: nothing is said
    expect(notImportedLines({ tasks: null, appointments: null }, 'your file')).toEqual([]);
    fc.assert(
      fc.property(fc.option(fc.nat(100_000), { nil: null }), fc.option(fc.nat(100_000), { nil: null }), (tasks, appointments) => {
        const nums = (notImportedLines({ tasks, appointments }, 'Follow Up Boss').join(' ').match(/\d[\d,]*/g) ?? []).map((x) => Number(x.replace(/,/g, '')));
        for (const x of nums) expect([tasks, appointments]).toContain(x);
      }),
      { numRuns: 200 },
    );
  });

  it('E233 a count the latest counting could not read again keeps its earlier number, said with when it was taken, never as what Follow Up Boss holds now (review F4)', () => {
    const tail = "Realty OS doesn't bring tasks or appointments over: finish or note the open ones in Follow Up Boss before you switch.";
    // one count failed again at the snapshot: the other is the snapshot's, the kept one says when it was counted
    expect(notImportedLines({ tasks: 3, appointments: 85, kept: { tasks: 'connection_test' } }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 85 appointments; we could not count its tasks again (it had 3 tasks at the connection test). ${tail}`]);
    expect(notImportedLines({ tasks: 1240, appointments: 1, kept: { appointments: 'connection_test' } }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 1,240 tasks; we could not count its appointments again (it had 1 appointment at the connection test). ${tail}`]);
    // neither could be counted again
    expect(notImportedLines({ tasks: 3, appointments: 1, kept: { tasks: 'connection_test', appointments: 'connection_test' } }, 'Follow Up Boss')).toEqual([`We could not count tasks or appointments in Follow Up Boss again (at the connection test it had 3 tasks and 1 appointment). ${tail}`]);
    expect(notImportedLines({ tasks: 3, appointments: 85, kept: { tasks: 'connection_test', appointments: 'snapshot' } }, 'Follow Up Boss')).toEqual([`We could not count tasks or appointments in Follow Up Boss again (it had 3 tasks at the connection test and 85 appointments at an earlier snapshot). ${tail}`]);
    // one was never counted: no "again"
    expect(notImportedLines({ tasks: 3, appointments: null, kept: { tasks: 'connection_test' } }, 'Follow Up Boss')).toEqual([`We could not count tasks or appointments in Follow Up Boss (it had 3 tasks at the connection test). ${tail}`]);
    // "no tasks or appointments" only when both were counted just now; a kept marker on a count we never had says nothing
    expect(notImportedLines({ tasks: 0, appointments: 0, kept: { tasks: 'connection_test' } }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 0 appointments; we could not count its tasks again (it had 0 tasks at the connection test). ${tail}`]);
    expect(notImportedLines({ tasks: null, appointments: 4, kept: { tasks: 'connection_test' } }, 'Follow Up Boss')).toEqual([`Follow Up Boss has 4 appointments; we could not count its tasks. ${tail}`]);
    const step = fc.option(fc.constantFrom('connection_test' as const, 'snapshot' as const), { nil: undefined });
    fc.assert(
      fc.property(fc.option(fc.nat(100_000), { nil: null }), fc.option(fc.nat(100_000), { nil: null }), step, step, (tasks, appointments, kt, ka) => {
        const kept = { ...(kt ? { tasks: kt } : {}), ...(ka ? { appointments: ka } : {}) };
        const line = notImportedLines({ tasks, appointments, kept }, 'Follow Up Boss').join(' ');
        for (const x of (line.match(/\d[\d,]*/g) ?? []).map((v) => Number(v.replace(/,/g, '')))) expect([tasks, appointments]).toContain(x);
        // a kept count is never said as what Follow Up Boss has now
        if (kt && tasks !== null) expect(line).not.toContain(`has ${tasks.toLocaleString('en-US')} task`);
        if (ka && appointments !== null) expect(line).not.toContain(`has ${appointments.toLocaleString('en-US')} appointment`);
      }),
      { numRuns: 300 },
    );
  });

  it('report copy never claims a count it was not given (property)', () => {
    const n = fc.nat(100_000);
    fc.assert(
      fc.property(n, n, n, n, (a, b, d, e) => {
        const c = counts(a + b + d + e, a, b, d, e);
        const nums = reportLines('notes', 'dry_run', c, 'your file')
          .join(' ')
          .match(/\d[\d,]*/g)
          ?.map((x) => Number(x.replace(/,/g, '')));
        for (const x of nums ?? []) expect([c.source, a, b, d, e]).toContain(x);
      }),
      { numRuns: 200 },
    );
  });

  it('E39 R-CONSENT-3 the preview of a re-imported, previously opted-out address says it will stay opted out', () => {
    const idx = buildExistingIndex(
      emptyIndexInput({
        contacts: [existingContact({ contactId: '00000000-0000-7000-8000-0000000c0009' as ContactId, ownershipState: 'closed', closedReason: 'deleted', phones: ['+13125550145'] })],
        optedOut: [
          { key: testKey('phone', '+13125550145'), channel: 'sms' },
          { key: testKey('phone', '+13125550145'), channel: 'voice' },
        ],
      }),
    );
    const d = dryRun('contacts', [mapFub('contacts', FUB_EXPORT.people[1], USERS)], idx);
    const r = d.records[0];
    expect(r?.action?.kind).toBe('create_contact');
    expect(optOutPreview(r?.staysOptedOut ?? [])).toBe('Opted out of texts and calls. Will stay opted out.');
    expect(optOutPreview([])).toBeNull();
    expect(optOutPreview(['email', 'sms', 'voice'])).toBe('Opted out of texts, calls and email. Will stay opted out.');
  });
});
