import { describe, expect, it } from 'vitest';
import { SpeedToLeadSummarySchema, countTouches, momentum, speedToLeadSummary, type SpeedRow } from './index.js';
import { ME, NOW, contact, min, t, touch } from './testing/fixtures.js';

const row = (n: number, responseS: number | null, slaMin = 15, ownedAgoMin = 60): SpeedRow => {
  const ownedAt = t(-min(ownedAgoMin));
  return {
    userId: ME,
    contactId: contact(n),
    ownedSeq: n,
    ownedAt,
    firstTouchDueAt: (ownedAt + min(slaMin)) as never,
    firstTouchAt: responseS === null ? null : ((ownedAt + responseS * 1000) as never),
  };
};

describe('R-ACC-4 speed-to-lead summary', () => {
  it('R-ACC-4: always returns the denominators (within SLA of total; median of responded)', () => {
    const s = speedToLeadSummary([row(1, 60), row(2, 300), row(3, 1200), row(4, null)]);
    expect(s).toEqual({ medianSeconds: 300, withinSla: 2, total: 4, responded: 3, pending: 0, byBackup: 0 });
    expect(SpeedToLeadSummarySchema.parse(s)).toEqual(s);
  });

  it('R-ACC-4: an even count averages the two middle response times; an empty set has a null median and zero denominators', () => {
    expect(speedToLeadSummary([row(1, 61), row(2, 120)]).medianSeconds).toBe(91);
    expect(speedToLeadSummary([])).toEqual({ medianSeconds: null, withinSla: 0, total: 0, responded: 0, pending: 0, byBackup: 0 });
    expect(speedToLeadSummary([row(1, null)])).toEqual({ medianSeconds: null, withinSla: 0, total: 1, responded: 0, pending: 0, byBackup: 0 });
  });

  it('R-ACC-4: a touch exactly at the deadline is within SLA; one second late is not', () => {
    expect(speedToLeadSummary([row(1, 900)]).withinSla).toBe(1);
    expect(speedToLeadSummary([row(1, 901)]).withinSla).toBe(0);
  });

  it('R-ACC-4: with `now`, untouched periods whose deadline is ahead are pending, not counted against the agent', () => {
    const fresh = row(9, null, 15, 5); // owned 5 min ago, due in 10
    expect(speedToLeadSummary([row(1, 60), fresh], { now: NOW })).toEqual({ medianSeconds: 60, withinSla: 1, total: 1, responded: 1, pending: 1, byBackup: 0 });
    expect(speedToLeadSummary([row(1, 60), fresh])).toMatchObject({ total: 2, pending: 0, byBackup: 0 });
    expect(speedToLeadSummary([row(1, 60)], { now: NOW }).pending).toBe(0);
  });
});

describe('scoreboard touches', () => {
  it('R-AST-15 R-IMPORT-6 R-ACC-4: imported and assistant messages never count as touches; only gate-allowed human outbound does', () => {
    const rows = [
      touch(),
      touch({ kind: 'call' }),
      touch({ initiator: 'assistant', byUserId: null }),
      touch({ initiator: 'system', byUserId: null }),
      touch({ initiator: 'import', imported: true }),
      touch({ imported: true }),
      touch({ gateAllowed: false }),
      touch({ kind: 'call', direction: 'inbound_answered' }),
    ];
    expect(countTouches(rows)).toEqual({ touches: 2, calls: 1, textsAndEmails: 1 });
    expect(countTouches([])).toEqual({ touches: 0, calls: 0, textsAndEmails: 0 });
  });
});

describe('R-ACC-5 momentum', () => {
  it('R-ACC-5: slow only above 1.5x the tenant median with a sample of at least 5', () => {
    expect(momentum(15.1, { medianDays: 10, sample: 5 })).toEqual({ slow: true });
    expect(momentum(15, { medianDays: 10, sample: 5 })).toEqual({ slow: false });
    expect(momentum(40, { medianDays: 10, sample: 4 })).toEqual({ slow: false });
    expect(momentum(0.1, { medianDays: 0, sample: 9 })).toEqual({ slow: true });
  });

  it('R-ACC-5: malformed numbers never flag a deal', () => {
    for (const [d, m, s] of [
      [Number.NaN, 10, 5],
      [20, Number.NaN, 5],
      [20, 10, Number.NaN],
      [-1, 10, 5],
      [20, -1, 5],
      [Number.POSITIVE_INFINITY, 10, 5],
    ] as const) {
      expect(momentum(d, { medianDays: m, sample: s })).toEqual({ slow: false });
    }
  });
});

describe('R-TEAMQ-23 a first touch made by the backup is not the owner\'s response (review fix M5)', () => {
  const row = (o: Partial<SpeedRow>): SpeedRow => ({ userId: 'u' as never, contactId: 'c' as never, ownedSeq: 1, ownedAt: 0 as never, firstTouchDueAt: 900_000 as never, firstTouchAt: null, ...o });

  it('R-TEAMQ-23 E985: a period first touched by the backup is counted apart: not in the owner\'s "within", "responded" or median, not held against them either; the owner\'s own first touches are unchanged', () => {
    const own = row({ ownedSeq: 1, firstTouchAt: 120_000 as never });
    const byBackup = row({ ownedSeq: 2, firstTouchAt: 240_000 as never, firstTouchByBackup: true });
    const before = speedToLeadSummary([own, row({ ownedSeq: 2 })], { now: 300_000 as never });
    expect(before).toEqual({ medianSeconds: 120, withinSla: 1, total: 1, responded: 1, pending: 1, byBackup: 0 });
    // the backup calls the second lead: the owner's numbers do not improve, and the backup's call is visible as such
    const after = speedToLeadSummary([own, byBackup], { now: 300_000 as never });
    expect(after).toEqual({ medianSeconds: 120, withinSla: 1, total: 1, responded: 1, pending: 0, byBackup: 1 });
    // a late call by the backup is still the backup's, never a late response of the owner
    const late = speedToLeadSummary([row({ firstTouchAt: 2_000_000 as never, firstTouchByBackup: true })], { now: 3_000_000 as never });
    expect(late).toEqual({ medianSeconds: null, withinSla: 0, total: 0, responded: 0, pending: 0, byBackup: 1 });
    // without the mark (every row before this fix) nothing changes
    expect(speedToLeadSummary([row({ firstTouchAt: 240_000 as never })])).toEqual({ medianSeconds: 240, withinSla: 1, total: 1, responded: 1, pending: 0, byBackup: 0 });
  });
});
