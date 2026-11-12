// Property tests of the trends aggregate (module 54; R-COACH-7, R-COACH-8): going through the definer's counts never
// changes core's answer where the counts are shown, and answers not_enough_data where they are withheld.
import { type CallScore, RUBRIC_V1, trend } from '@realty/core/coaching';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TREND_FLOOR, type WindowedScore, mirror, toTrendScores, trendItems } from './aggregate.js';

const KEYS = RUBRIC_V1.items.map((i) => i.key);
const STATUS = fc.constantFrom('met', 'missed', 'needs_review', 'not_applicable');
const MEMBERS = ['u-1', 'u-2', 'u-3'];
const SCORE = fc.record({
  agentUserId: fc.constantFrom(...MEMBERS),
  windowKind: fc.constantFrom('before' as const, 'after' as const),
  weekOffset: fc.integer({ min: 0, max: 1 }),
  items: fc.array(fc.record({ key: fc.constantFrom(...KEYS.slice(0, 3)), status: STATUS }), { maxLength: 4 }),
});

function windowed(raw: { agentUserId: string; windowKind: 'before' | 'after'; weekOffset: number; items: { key: string; status: string }[] }[]): WindowedScore[] {
  return raw.map((r, i) => ({ agentUserId: r.agentUserId, callId: `c-${i}`, windowKind: r.windowKind, week: `${r.windowKind}-${r.weekOffset}`, items: r.items }));
}
const asCore = (s: WindowedScore): CallScore => ({ rubricVersion: RUBRIC_V1.version, items: s.items.map((i) => ({ key: i.key, status: i.status as never, claimId: null, quotes: [] })), metCount: 0, scoredCount: 0 });

describe('mirror → toTrendScores → trend() (R-COACH-7, R-COACH-8)', () => {
  it('R-COACH-7: wherever met is shown in both windows, the direction equals core\'s on the original reviews; elsewhere it is not_enough_data', () => {
    fc.assert(
      fc.property(fc.array(SCORE, { maxLength: 60 }), fc.subarray(MEMBERS, { minLength: 1 }), fc.constantFrom(...MEMBERS), (raw, members, caller) => {
        const scores = windowed(raw);
        const rows = mirror(scores, members, caller);
        for (const who of members.length > 1 ? [...members, null] : members) {
          const mine = scores.filter((s) => (who === null ? members.includes(s.agentUserId) : s.agentUserId === who));
          const truth = trend(mine.filter((s) => s.windowKind === 'before').map(asCore), mine.filter((s) => s.windowKind === 'after').map(asCore));
          const via = toTrendScores(rows, who);
          const got = trend(via.before, via.after);
          for (const t of truth) {
            const shown = (k: 'before' | 'after') => rows.find((r) => r.agentUserId === who && r.windowKind === k && r.itemKey === t.key)?.met ?? null;
            const g = got.find((x) => x.key === t.key)!;
            if (shown('before') !== null && shown('after') !== null) {
              expect(g.direction).toBe(t.direction);
              expect([g.before.met, g.before.n, g.after.met, g.after.n]).toEqual([t.before.met, t.before.n, t.after.met, t.after.n]);
            } else expect(g.direction).toBe('not_enough_data');
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('R-COACH-8: met is withheld below the floor; in anyone else\'s view also when any (member, week, item) cell inside has 1-4 scored', () => {
    fc.assert(
      fc.property(fc.array(SCORE, { maxLength: 60 }), fc.subarray(MEMBERS, { minLength: 1 }), fc.constantFrom(...MEMBERS), (raw, members, caller) => {
        const scores = windowed(raw);
        const self = members.length === 1 && members[0] === caller;
        for (const r of mirror(scores, members, caller)) {
          if (r.scored < TREND_FLOOR) expect(r.met).toBeNull();
          if (r.met === null || self) continue;
          const cells = new Map<string, number>();
          for (const s of scores) {
            if (!members.includes(s.agentUserId) || (r.agentUserId !== null && s.agentUserId !== r.agentUserId) || s.windowKind !== r.windowKind) continue;
            const first = s.items.find((i) => i.key === r.itemKey);
            if (!first) continue;
            const k = `${s.agentUserId}|${s.week}`;
            cells.set(k, (cells.get(k) ?? 0) + (first.status === 'met' || first.status === 'missed' ? 1 : 0));
          }
          for (const n of cells.values()) expect(n === 0 || n >= TREND_FLOOR).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('R-COACH-6: the items carry counts and words only, and every sentence names its n', () => {
    fc.assert(
      fc.property(fc.array(SCORE, { maxLength: 40 }), (raw) => {
        const rows = mirror(windowed(raw), ['u-1'], 'u-1');
        for (const it of trendItems(rows, 'u-1', 1)) {
          expect(Object.keys(it).sort()).toEqual(['after', 'before', 'direction', 'key', 'label', 'sentence']);
          expect(it.sentence).toMatch(/\d/);
          expect(it.sentence).not.toMatch(/%/);
        }
      }),
      { numRuns: 200 },
    );
  });
});
