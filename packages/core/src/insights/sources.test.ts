import { describe, expect, it } from 'vitest';
import { at, localDate } from '../foundation/index.js';
import { NY, allKeys, deal, src } from './testing/fixtures.js';
import { costPerClosing, divRoundHalfUp, formatCents, sourceDollars, type DealFinancialRow, type InsightDeal, type InsightPeriod, type SourceCostRow } from './index.js';

const OCT: InsightPeriod = { start: localDate('2026-10-01'), endExclusive: localDate('2026-11-01'), zone: NY };

const closed = (n: number, iso: string, source: number | null): InsightDeal => ({
  id: deal(n),
  side: 'buy',
  stage: 'closed',
  stageEnteredAt: at(iso),
  closedAt: at(iso),
  leadSourceId: source === null ? null : src(source),
});
const fin = (n: number, cents: number | null): DealFinancialRow => ({ dealId: deal(n), grossCommissionCents: cents, commissionStatus: 'confirmed' });
const cost = (source: number, month: string, cents: number, origin: 'manual' | 'ads_sync' = 'manual'): SourceCostRow => ({
  leadSourceId: src(source),
  month: localDate(month),
  amountCents: cents,
  origin,
});

describe('R-OWNER-2 dollars by source', () => {
  it('R-OWNER-2: sums commission of deals closed in the period by lead source, with closings and deals-with-commission denominators', () => {
    const r = sourceDollars(
      [closed(1, '2026-10-05T15:00:00Z', 1), closed(2, '2026-10-20T15:00:00Z', 1), closed(3, '2026-10-21T15:00:00Z', 2)],
      [fin(1, 900_000), fin(2, 600_000), fin(3, 450_000)],
      [cost(1, '2026-10-01', 100_000), cost(2, '2026-10-01', 90_001)],
      OCT,
    );
    expect(r.closedInPeriod).toBe(3);
    expect(r.rows).toEqual([
      {
        leadSourceId: src(1),
        closings: 2,
        dealsWithCommission: 2,
        missingCommission: 0,
        commissionCents: 1_500_000,
        costCents: 100_000,
        costByOrigin: { manual: 100_000, adsSync: 0 },
        costRows: 1,
        costPerClosingCents: 50_000,
        costPerClosingWords: '$500.00 per closing (2 closings)',
      },
      {
        leadSourceId: src(2),
        closings: 1,
        dealsWithCommission: 1,
        missingCommission: 0,
        commissionCents: 450_000,
        costCents: 90_001,
        costByOrigin: { manual: 90_001, adsSync: 0 },
        costRows: 1,
        costPerClosingCents: 90_001,
        costPerClosingWords: '$900.01 per closing (1 closing)',
      },
    ]);
  });

  it('R-OWNER-2: a deal closed outside the period (in the tenant zone) is not counted; costs count by their month', () => {
    // 2026-11-01T02:00Z is still Oct 31 in New York; 2026-10-01T03:00Z is still Sep 30.
    const r = sourceDollars(
      [closed(1, '2026-11-01T02:00:00Z', 1), closed(2, '2026-10-01T03:00:00Z', 1), closed(3, '2026-11-01T05:00:00Z', 1)],
      [fin(1, 100), fin(2, 200), fin(3, 300)],
      [cost(1, '2026-09-01', 5), cost(1, '2026-10-01', 7), cost(1, '2026-11-01', 11)],
      OCT,
    );
    expect(r.closedInPeriod).toBe(1);
    expect(r.rows[0]).toMatchObject({ closings: 1, commissionCents: 100, costCents: 7 });
  });

  it('R-OWNER-2: open and lost deals never count; only stage closed with closedAt does', () => {
    const open: InsightDeal = { ...closed(1, '2026-10-05T15:00:00Z', 1), stage: 'under_contract', closedAt: null };
    const lost: InsightDeal = { ...closed(2, '2026-10-05T15:00:00Z', 1), stage: 'lost', closedAt: null };
    const r = sourceDollars([open, lost], [fin(1, 100), fin(2, 100)], [], OCT);
    expect(r.rows).toEqual([]);
    expect(r.closedInPeriod).toBe(0);
  });

  it('R-OWNER-2 E108: a source with cost and zero closings says "— (0 closings)", never $0 or ∞', () => {
    const r = sourceDollars([], [], [cost(9, '2026-10-01', 250_000, 'ads_sync')], OCT);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row?.closings).toBe(0);
    expect(row?.costCents).toBe(250_000);
    expect(row?.costPerClosingCents).toBeNull();
    expect(row?.costPerClosingWords).toBe('— (0 closings)');
    expect(row?.costPerClosingWords).not.toMatch(/\$0|∞|Infinity|NaN/);
  });

  it('R-OWNER-2: a source with closings but no cost entered has no cost per closing (not $0)', () => {
    const r = sourceDollars([closed(1, '2026-10-05T15:00:00Z', 1)], [fin(1, 100)], [], OCT);
    expect(r.rows[0]?.costPerClosingCents).toBeNull();
    expect(r.rows[0]?.costPerClosingWords).toBe('— (no cost entered; 1 closing)');
  });

  it('R-OWNER-2: manual and ads_sync costs of the same source-month are both summed and shown per origin', () => {
    const r = sourceDollars([closed(1, '2026-10-05T15:00:00Z', 1)], [fin(1, 1)], [cost(1, '2026-10-01', 300), cost(1, '2026-10-01', 200, 'ads_sync')], OCT);
    expect(r.rows[0]).toMatchObject({ costCents: 500, costByOrigin: { manual: 300, adsSync: 200 }, costRows: 2, costPerClosingCents: 500 });
  });

  it('R-OWNER-2: cost per closing rounds half-up to whole cents in integer arithmetic', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3); // 2.5 -> 3
    expect(divRoundHalfUp(7, 3)).toBe(2); // 2.33 -> 2
    expect(divRoundHalfUp(8, 3)).toBe(3); // 2.67 -> 3
    expect(divRoundHalfUp(0, 4)).toBe(0);
    expect(costPerClosing(100_001, 2, 1)).toEqual({ cents: 50_001, words: '$500.01 per closing (2 closings)' });
    expect(() => divRoundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => divRoundHalfUp(1.5, 1)).toThrow(RangeError);
    expect(formatCents(123_456_789)).toBe('$1,234,567.89');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('R-OWNER-2: rows sort by commission, then closings, then source id', () => {
    const r = sourceDollars(
      [closed(1, '2026-10-05T15:00:00Z', 3), closed(2, '2026-10-05T15:00:00Z', 2), closed(3, '2026-10-05T15:00:00Z', 1)],
      [fin(1, 100), fin(2, 100), fin(3, 500)],
      [],
      OCT,
    );
    expect(r.rows.map((x) => x.leadSourceId)).toEqual([src(1), src(2), src(3)]);
  });
});

describe('R-OWNER-1 excluded deals are counted and listed (core part)', () => {
  it('R-OWNER-1 E107: a closed deal without commission is excluded from dollars and listed as missing commission', () => {
    const r = sourceDollars(
      [closed(1, '2026-10-05T15:00:00Z', 1), closed(2, '2026-10-06T15:00:00Z', 1), closed(3, '2026-10-07T15:00:00Z', 1)],
      [fin(1, 400_000), fin(2, null)], // deal 3 has no financials row at all
      [cost(1, '2026-10-01', 30_000)],
      OCT,
    );
    expect(r.rows[0]).toMatchObject({ closings: 3, dealsWithCommission: 1, missingCommission: 2, commissionCents: 400_000, costPerClosingCents: 10_000 });
    expect(r.excluded.missingCommission).toEqual({ count: 2, dealIds: [deal(2), deal(3)] });
  });

  it('R-OWNER-1: a closed deal with no lead source is in no row, counted and listed under noSource', () => {
    const r = sourceDollars([closed(5, '2026-10-05T15:00:00Z', null), closed(4, '2026-10-05T15:00:00Z', null)], [fin(5, 100), fin(4, null)], [], OCT);
    expect(r.rows).toEqual([]);
    expect(r.closedInPeriod).toBe(2);
    expect(r.excluded.noSource).toEqual({ count: 2, dealIds: [deal(4), deal(5)] });
    // a deal with neither appears in both lists
    expect(r.excluded.missingCommission).toEqual({ count: 1, dealIds: [deal(4)] });
  });

  it('R-OWNER-4: no key in the sourceDollars output matches confidence, probability or score', () => {
    const r = sourceDollars([closed(1, '2026-10-05T15:00:00Z', 1), closed(2, '2026-10-05T15:00:00Z', null)], [fin(1, 100)], [cost(1, '2026-10-01', 9)], OCT);
    expect(allKeys(r).filter((k) => /confiden|probab|score/i.test(k))).toEqual([]);
  });
});
