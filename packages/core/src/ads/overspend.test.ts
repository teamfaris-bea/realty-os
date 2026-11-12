// R-ADS-5 (core half) and E124: hourly reconciliation pauses every campaign once provider-reported
// month-to-date spend reaches the monthly cap; a day over a daily budget alone pauses nothing. The job,
// the alert and "within 1 h" are module 52's.
import { describe, expect, it } from 'vitest';
import { instant } from '../foundation/index.js';
import { overspend } from './overspend.js';
import { cap, cid } from './testing/fixtures.js';
import type { HourlySpend } from './types.js';

const H = 3_600_000;
const start = Date.UTC(2026, 10, 1, 6);
const row = (n: number, hour: number, cents: number): HourlySpend => ({ campaignId: cid(n), hourStart: instant(start + hour * H), spendCents: cents });
// 3 campaigns; campaign 3 has a zero-spend row so it is still paused with the others
const month = (total: number): HourlySpend[] => [row(1, 0, total - 400), row(1, 1, 300), row(2, 5, 100), row(3, 2, 0)];

describe('overspend', () => {
  it('month-to-date spend equal to the cap pauses every campaign in the rows', () => {
    expect(overspend(month(3_000_000), cap())).toEqual([cid(1), cid(2), cid(3)]);
  });

  it('one cent under the cap pauses none', () => {
    expect(overspend(month(2_999_999), cap())).toEqual([]);
  });

  it('a day over its daily budget, with month-to-date under the cap, pauses none', () => {
    // campaign 1's daily budget is $100.00; it spends $250.00 in one day (platforms may overspend a daily budget)
    const rows = [row(1, 0, 15_000), row(1, 1, 10_000), row(2, 0, 1_000)];
    expect(overspend(rows, cap())).toEqual([]);
  });

  it('a cap lowered below month-to-date spend pauses every campaign', () => {
    const rows = month(1_200_000);
    expect(overspend(rows, cap())).toEqual([]);
    expect(overspend(rows, cap({ versionNo: 4, monthlyCapCents: 1_000_000, dailyCeilingCents: 50_000 }))).toEqual([cid(1), cid(2), cid(3)]);
  });

  it('a campaign with no row is not returned: module 52 passes a row for every campaign', () => {
    expect(overspend([row(1, 0, 3_000_000)], cap())).toEqual([cid(1)]);
    expect(overspend([], cap())).toEqual([]);
  });

  it('refuses malformed rows with a RangeError', () => {
    for (const bad of [[row(1, 0, -1)], [row(1, 0, 1.5)], [row(1, 0, Number.NaN)], [row(1, 0, 2 ** 53)], [row(1, 0, 1), row(1, 0, 2)],
      [{ ...row(1, 0, 1), campaignId: 'ADS' as never }], [{ ...row(1, 0, 1), hourStart: Number.NaN as never }]]) {
      expect(() => overspend(bad, cap())).toThrow(RangeError);
    }
    expect(() => overspend('x' as never, cap())).toThrow(RangeError);
    expect(() => overspend([row(1, 0, 2 ** 52), row(1, 1, 2 ** 52), row(1, 2, 2 ** 52)], cap())).toThrow(RangeError);
  });
});
