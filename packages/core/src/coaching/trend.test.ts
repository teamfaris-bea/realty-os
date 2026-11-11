import { describe, expect, it } from 'vitest';
import { trend, type CallScore, type ItemStatus } from './index.js';
import { scoreOf } from './testing/fixtures.js';

/** `met` met + `missed` missed (+ `review` needs_review) reviews of one item. */
function windowOf(key: string, met: number, missed: number, review = 0): CallScore[] {
  const mk = (s: ItemStatus) => scoreOf({ [key]: s });
  return [...Array.from({ length: met }, () => mk('met')), ...Array.from({ length: missed }, () => mk('missed')), ...Array.from({ length: review }, () => mk('needs_review'))];
}
const at = (items: ReturnType<typeof trend>, key: string) => items.find((i) => i.key === key);

describe('R-COACH-7 improving / slipping', () => {
  it('R-COACH-7: per-item met rate in each window with n on each side', () => {
    const t = trend(windowOf('asked_timeline', 2, 4), windowOf('asked_timeline', 5, 1));
    expect(at(t, 'asked_timeline')).toEqual({
      key: 'asked_timeline',
      label: 'Asked about timeline',
      before: { met: 2, n: 6, metRate: 2 / 6 },
      after: { met: 5, n: 6, metRate: 5 / 6 },
      direction: 'improving',
    });
    expect(at(trend(windowOf('asked_timeline', 5, 1), windowOf('asked_timeline', 2, 4)), 'asked_timeline')?.direction).toBe('slipping');
  });

  it('R-COACH-7: needs at least 5 scored calls per window (needs_review does not count)', () => {
    const t = trend(windowOf('recapped_call', 1, 3, 4), windowOf('recapped_call', 5, 0));
    expect(at(t, 'recapped_call')).toMatchObject({ before: { met: 1, n: 4 }, after: { met: 5, n: 5 }, direction: 'not_enough_data' });
    expect(at(t, 'introduced_self')).toEqual({ key: 'introduced_self', label: 'Introduced self and brokerage', before: { met: 0, n: 0, metRate: null }, after: { met: 0, n: 0, metRate: null }, direction: 'not_enough_data' });
  });

  it('R-COACH-7: a change under 10 percentage points is steady; exactly 10 is not; the threshold is a parameter', () => {
    // 5/10 → 6/10 is +10 points exactly
    expect(at(trend(windowOf('asked_timeline', 5, 5), windowOf('asked_timeline', 6, 4)), 'asked_timeline')?.direction).toBe('improving');
    // 10/20 → 11/20 is +5 points
    expect(at(trend(windowOf('asked_timeline', 10, 10), windowOf('asked_timeline', 11, 9)), 'asked_timeline')?.direction).toBe('steady');
    expect(at(trend(windowOf('asked_timeline', 5, 5), windowOf('asked_timeline', 6, 4), { steadyBelowPoints: 15 }), 'asked_timeline')?.direction).toBe('steady');
    expect(at(trend(windowOf('asked_timeline', 2, 1), windowOf('asked_timeline', 3, 0), { minScored: 3 }), 'asked_timeline')?.direction).toBe('improving');
  });

  it('R-COACH-7: compares the same rubric version only (another version throws)', () => {
    const v2: CallScore = { ...scoreOf({ asked_timeline: 'met' }), rubricVersion: 'rubric/2' };
    expect(() => trend(windowOf('asked_timeline', 5, 0), [v2])).toThrow(/one rubric version/);
  });

  it('R-COACH-7: aggregates only — no quotes, call ids or contact ids; disabled items are omitted', () => {
    const t = trend(windowOf('asked_timeline', 5, 0), windowOf('asked_timeline', 5, 0), { disabledKeys: ['recapped_call'] });
    expect(t.map((i) => i.key)).not.toContain('recapped_call');
    const json = JSON.stringify(t);
    expect(json).not.toMatch(/quote|callId|contactId|snippet|claimId/i);
    for (const i of t) expect(Object.keys(i).sort()).toEqual(['after', 'before', 'direction', 'key', 'label']);
  });

  it('rejects bad parameters', () => {
    expect(() => trend([], [], { minScored: 0 })).toThrow(RangeError);
    expect(() => trend([], [], { steadyBelowPoints: -1 })).toThrow(RangeError);
  });
});
