import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ContactId, UserId } from '../foundation/index.js';
import {
  type Counts,
  SPOT_CHECKS,
  batchReport,
  buildExistingIndex,
  buildVerification,
  commitPlan,
  dryRun,
  mapFub,
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
