import { describe, expect, it } from 'vitest';
import { DAY_MS, at, instant } from '../foundation/index.js';
import { type CountSnapshot, MARKET_RULE_VERSION, marketDeltas } from './market.js';

const T0 = at('2026-10-01T12:00:00Z');
const snap = (active: number, comingSoon: number, pending: number, o: Partial<CountSnapshot> = {}): CountSnapshot => ({ counts: { active, comingSoon, pending }, at: T0, connections: ['c1'], displayRulesVersion: 'dr1', ruleVersion: MARKET_RULE_VERSION, ...o });
const later = (s: CountSnapshot, days = 31): CountSnapshot => ({ ...s, at: instant(T0 + days * DAY_MS) });

describe('R-ISA-19 E537 marketDeltas: displayable counts by status only, with thresholds and version suppression', () => {
  it('shares a change of ≥ 3 AND ≥ 25 % in active + coming soon', () => {
    const r = marketDeltas({ prev: snap(8, 2, 1), current: later(snap(12, 1, 3)), lastSharedAt: null, beds: 3, postalCode: '62701-1234' });
    expect(r).toMatchObject({ share: true, sentence: '12 active and 1 coming soon, plus 3 pending, among homes like yours (same type, 2–4 bedrooms, similar size) that the MLS lets us show in 62701, up from 10 on Oct 1.' });
  });
  it('a fall is stated as "down from"; never a forecast or a direction word beyond that', () => {
    const r = marketDeltas({ prev: snap(12, 0, 0), current: later(snap(8, 0, 0)), lastSharedAt: null, beds: 1, postalCode: '62701' });
    expect(r.share && r.sentence).toMatch(/0–2 bedrooms.* down from 12/);
    expect(r.share && r.sentence).not.toMatch(/hot|cool|good time|rising|falling/i);
  });
  it('below either threshold, too soon, no snapshot, a version change, invalid counts: no share', () => {
    expect(marketDeltas({ prev: snap(8, 0, 0), current: later(snap(10, 0, 0)), lastSharedAt: null, beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'BELOW_THRESHOLD' });
    expect(marketDeltas({ prev: snap(20, 0, 0), current: later(snap(24, 0, 0)), lastSharedAt: null, beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'BELOW_THRESHOLD', snapshot: snap(20, 0, 0) });
    expect(marketDeltas({ prev: snap(8, 0, 0), current: later(snap(12, 0, 0), 10), lastSharedAt: instant(T0 - DAY_MS), beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'TOO_SOON' });
    expect(marketDeltas({ prev: null, current: snap(8, 0, 0), lastSharedAt: null, beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'NO_SNAPSHOT', snapshot: snap(8, 0, 0) });
    for (const o of [{ connections: ['c1', 'c2'] }, { displayRulesVersion: 'dr2' }, { ruleVersion: 'other' }]) {
      const cur = later(snap(20, 0, 0, o));
      expect(marketDeltas({ prev: snap(8, 0, 0), current: cur, lastSharedAt: null, beds: 3, postalCode: '62701' })).toEqual({ share: false, reason: 'VERSION_CHANGED', snapshot: cur });
    }
    expect(marketDeltas({ prev: snap(8, 0, 0), current: later(snap(-1, 0, 0)), lastSharedAt: null, beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'INVALID' });
    expect(marketDeltas({ prev: null, current: snap(1.5, 0, 0), lastSharedAt: null, beds: 3, postalCode: '62701' })).toMatchObject({ share: false, reason: 'INVALID' });
  });
  it('from zero, a change of at least 3 counts; the connection set is compared unordered', () => {
    expect(marketDeltas({ prev: snap(0, 0, 0), current: later(snap(3, 0, 0)), lastSharedAt: null, beds: 3, postalCode: '62701' }).share).toBe(true);
    expect(marketDeltas({ prev: snap(8, 0, 0, { connections: ['b', 'a'] }), current: later(snap(12, 0, 0, { connections: ['a', 'b'] })), lastSharedAt: instant(T0 - 40 * DAY_MS), beds: 3, postalCode: '62701' }).share).toBe(true);
  });
});
