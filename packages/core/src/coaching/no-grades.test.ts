// R-COACH-6: no numeric overall score, grade, rank, percentage, leaderboard, tone or sentiment field
// is produced. This walks every key of real outputs (CallScore, Fix, TrendItem) recursively.
//
// Two keys are allowed by name: `metCount` and `scoredCount`. They are the "6 of 8 checks"
// numerator and denominator that the call_scores row requires (met_count, scored_count with
// met_count <= scored_count) and that R-COACH-2 says the UI shows; neither is an overall score.
// (Neither actually matches the pattern today, but the allowance is explicit so a rename such as
// `score` → `scoredCount` stays a deliberate decision.)
import { describe, expect, it } from 'vitest';
import { RUBRIC_V1, dailyFix, scoreFromClaims, trend } from './index.js';
import { TODAY, allMetExcept, claim, ref, scoreOf, scored, transcript } from './testing/fixtures.js';

const FORBIDDEN = /score$|grade|rank|percent|sentiment|tone|overall|leader/i;
const ALLOWED = new Set(['metCount', 'scoredCount']);

function keysOf(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

const offending = (v: unknown) => [...keysOf(v)].filter((k) => FORBIDDEN.test(k) && !ALLOWED.has(k));

describe('R-COACH-6 no score, grade or sentiment fields', () => {
  const score = scoreFromClaims(
    [claim('introduced_self', 'met', [ref('this is Dana Reyes with Harbor Realty', 0)]), claim('asked_financing', 'missed', [ref('Not yet', 5)]), claim('recapped_call', 'not_applicable', [])],
    RUBRIC_V1,
    transcript(),
  );
  const fix = dailyFix(
    [1, 2, 3].map((n) => scored(n, n, allMetExcept('asked_financing'), { asked_financing: [ref('Not yet', 5)] })),
    [],
    TODAY,
  );
  const items = trend([1, 2, 3, 4, 5].map(() => scoreOf(allMetExcept('asked_timeline'))), [1, 2, 3, 4, 5].map(() => scoreOf(allMetExcept())));

  it('R-COACH-6: CallScore output has only counts, statuses and verified quotes', () => {
    expect(offending(score)).toEqual([]);
    expect(Object.keys(score).sort()).toEqual(['items', 'metCount', 'rubricVersion', 'scoredCount']);
  });

  it('R-COACH-6: Fix output has no score, grade or rank', () => {
    expect(fix).not.toBeNull();
    expect(offending(fix)).toEqual([]);
  });

  it('R-COACH-6: TrendItem output has no overall score or leaderboard position', () => {
    expect(items.length).toBeGreaterThan(0);
    expect(offending(items)).toEqual([]);
  });

  it('R-COACH-6: the checker itself catches forbidden keys', () => {
    expect(offending({ a: [{ overallScore: 1 }], grade: 'B', b: { sentimentLabel: 'x', percentMet: 3 } }).sort()).toEqual(['grade', 'overallScore', 'percentMet', 'sentimentLabel']);
  });
});
