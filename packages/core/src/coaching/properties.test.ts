// Property tests for core/coaching (R-COACH-2, R-COACH-4, E105, E106).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RUBRIC_V1, countItems, dailyFixResult, scoreFromClaims, verifiedRefs, type ItemStatus, type RubricClaim, type ScoredCall } from './index.js';
import { KEYS, LINES, TODAY, callId, claimId, ref, scoreOf, transcript } from './testing/fixtures.js';
import type { EvidenceRef } from '../assistant/index.js';
import { instant } from '../foundation/index.js';

const TX = transcript();

/** Refs that may or may not verify: real lines at the right or wrong segment, or made-up words. */
const arbRef: fc.Arbitrary<EvidenceRef> = fc.oneof(
  fc.tuple(fc.integer({ min: 0, max: LINES.length - 1 }), fc.integer({ min: -3, max: 3 })).map(([i, shift]) => {
    const seg = Math.min(LINES.length - 1, Math.max(0, i + shift));
    return ref((LINES[i] as [string, string])[1], seg);
  }),
  fc.string({ maxLength: 40 }).map((s) => ref(s, 0)),
  fc.constantFrom('budget is 500', 'I will call you Friday', '').map((s) => ref(s, 3)),
);

const arbClaim: fc.Arbitrary<RubricClaim> = fc.record({
  itemKey: fc.oneof(fc.constantFrom(...KEYS), fc.constantFrom('voice_tone', 'unknown')),
  status: fc.constantFrom('met' as const, 'missed' as const, 'not_applicable' as const),
  evidence: fc.array(arbRef, { maxLength: 3 }),
  claimId: fc.integer({ min: 1, max: 999 }).map(claimId),
});

const arbDisabled = fc.subarray([...KEYS]);

describe('coaching properties', () => {
  it('R-COACH-2: metCount <= scoredCount always, and the counts match the items', () => {
    fc.assert(
      fc.property(fc.array(arbClaim, { maxLength: 20 }), arbDisabled, (claims, disabled) => {
        const s = scoreFromClaims(claims, RUBRIC_V1, TX, { disabledKeys: disabled });
        expect(s.metCount).toBeLessThanOrEqual(s.scoredCount);
        expect(countItems(s.items)).toEqual({ metCount: s.metCount, scoredCount: s.scoredCount });
        expect(s.items.length).toBe(KEYS.length - disabled.length);
      }),
    );
  });

  it('R-COACH-2 E105: an item with no verifying evidence is never met or missed; its quotes all verify', () => {
    fc.assert(
      fc.property(fc.array(arbClaim, { maxLength: 20 }), (claims) => {
        const s = scoreFromClaims(claims, RUBRIC_V1, TX);
        for (const it of s.items) {
          const anyVerified = claims.filter((c) => c.itemKey === it.key && c.status === it.status).some((c) => verifiedRefs(c, TX).length > 0);
          if (it.status === 'met' || it.status === 'missed') {
            expect(anyVerified).toBe(true);
            expect(it.quotes.length).toBeGreaterThan(0);
          }
          expect(verifiedRefs({ evidence: it.quotes }, TX)).toEqual(it.quotes);
        }
      }),
    );
  });

  const arbStatus = fc.constantFrom<ItemStatus>('met', 'missed', 'not_applicable', 'needs_review');
  const arbCall: fc.Arbitrary<ScoredCall> = fc
    .tuple(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 30 * 86_400_000 }), fc.array(arbStatus, { minLength: KEYS.length, maxLength: KEYS.length }))
    .map(([n, t, statuses]) => ({
      callId: callId(n),
      occurredAt: instant(1_790_000_000_000 + t),
      score: scoreOf(Object.fromEntries(KEYS.map((k, i) => [k, statuses[i] as ItemStatus]))),
    }));

  it('R-COACH-4 E106: the daily fix never returns a dismissed key and is null with fewer than 3 scored calls', () => {
    fc.assert(
      fc.property(fc.uniqueArray(arbCall, { selector: (c) => c.callId, maxLength: 15 }), fc.subarray([...KEYS]), (calls, dismissed) => {
        const r = dailyFixResult(calls, dismissed, TODAY);
        const scoredCalls = calls.filter((c) => c.score.scoredCount > 0).length;
        if (scoredCalls < 3) expect(r).toEqual({ fix: null, reason: 'not_enough_calls' });
        if (r.fix !== null) {
          expect(dismissed).not.toContain(r.fix.itemKey);
          expect(r.fix.missedIn).toBeGreaterThan(0);
          expect(r.fix.missedIn).toBeLessThanOrEqual(r.fix.callsConsidered);
          expect(r.fix.callsConsidered).toBeLessThanOrEqual(10);
          expect(r.fix.quotes.length).toBeLessThanOrEqual(2);
        }
        // deterministic: input order does not matter
        expect(dailyFixResult([...calls].reverse(), dismissed, TODAY)).toEqual(r);
      }),
    );
  });
});
