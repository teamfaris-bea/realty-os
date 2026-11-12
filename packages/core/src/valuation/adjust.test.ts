// Unit tests of market rates and adjustments (adjust.ts, R-CMA-3): robust statistics, rate fitting with
// sales support (F11), the sign rule, concessions and adjusted prices. Exact values (mutation target).
import { describe, expect, it } from 'vitest';
import {
  CANNOT_LOWER_VALUE,
  OTHER_FEATURES,
  type PoolSale,
  adjustComp,
  adjustedPrice,
  compMonths,
  featureValue,
  fitRates,
  fitTime,
  median,
  rateViews,
  selectKth,
  supportProblem,
  theilSen,
  timeAmount,
} from './adjust.js';
import { monthIndex } from './select.js';
import { CMA_DEFAULTS, type CmaSale } from './types.js';
import { VALUATION_DATE, prng, sale, subject } from './testing/fixtures.js';

const R = CMA_DEFAULTS;
const REF = monthIndex(VALUATION_DATE);

function pool(n: number, f: (i: number, rnd: () => number) => Partial<CmaSale> & { back: number }, seed = 1): PoolSale[] {
  const rnd = prng(seed);
  return Array.from({ length: n }, (_, i) => {
    const { back, ...over } = f(i, rnd);
    return { sale: sale(over), month: REF - back };
  });
}

describe('robust statistics', () => {
  it('selectKth returns the k-th smallest, duplicates included', () => {
    const xs = [5, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const sorted = [...xs].sort((a, b) => a - b);
    for (let k = 0; k < xs.length; k++) expect(selectKth(Float64Array.from(xs), k)).toBe(sorted[k]);
    expect(selectKth(Float64Array.from([7]), 0)).toBe(7);
    expect(selectKth(Float64Array.from([2, 2, 2, 2]), 2)).toBe(2);
    const big = Array.from({ length: 1_001 }, (_, i) => (i * 7_919) % 1_001);
    expect(selectKth(Float64Array.from(big), 500)).toBe(500);
    expect(selectKth(Float64Array.from(big), 0)).toBe(0);
    expect(selectKth(Float64Array.from(big), 1_000)).toBe(1_000);
    const desc = Array.from({ length: 50 }, (_, i) => 50 - i);
    for (const k of [0, 1, 24, 25, 48, 49]) expect(selectKth(Float64Array.from(desc), k)).toBe(k + 1);
  });

  it('median: odd, even (mean of the middle two), empty, and order-independent', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([1, 1, 1, 9])).toBe(1);
    expect(median([5])).toBe(5);
    expect(median([2, 8])).toBe(5);
    expect(median([])).toBeNull();
    expect(median([10, -2, 7, 7, 3, 0])).toBe(5);
    expect(median(Float64Array.from([9, 8, 7, 1, 2, 3]))).toBe(5);
    const xs = Array.from({ length: 101 }, (_, i) => (i * 37) % 101);
    expect(median(xs)).toBe(50);
    expect(median([...xs].reverse())).toBe(50);
  });

  it('theilSen: the median pairwise slope over pairs at least minDx apart', () => {
    expect(theilSen([1, 2, 3, 4], [3, 5, 7, 9], 1)).toEqual({ slope: 2, pairs: 6 });
    expect(theilSen([1, 2, 3, 4], [3, 5, 7, 9], 2)).toEqual({ slope: 2, pairs: 3 });
    expect(theilSen([1, 1, 1], [1, 2, 3], 1)).toEqual({ slope: null, pairs: 0 });
    expect(theilSen([], [], 1)).toEqual({ slope: null, pairs: 0 });
    // One wild outlier does not move the slope.
    expect(theilSen([1, 2, 3, 4, 5], [2, 4, 6, 8, 1_000], 1).slope).toBe(2);
    expect(theilSen([4, 1, 3, 2], [9, 3, 7, 5], 1)).toEqual({ slope: 2, pairs: 6 });
    expect(theilSen([0, 10], [0, -5], 1)).toEqual({ slope: -0.5, pairs: 1 });
    expect(theilSen([0, 1, 2], [0, 10, 30], 1).slope).toBe(15);
  });
});

describe('features', () => {
  it('featureValue reads each feature in its stored unit; a pool is 1/0', () => {
    const s = sale({ beds: 4, bathsX10: 25, garageSpacesX10: 15, poolPrivate: true, yearBuilt: 2001, lotSqft: 9_000, storiesX10: 20 });
    expect(OTHER_FEATURES.map((f) => featureValue(f, s))).toEqual([4, 25, 15, 1, 2001, 9_000, 20]);
    expect(featureValue('pool', sale({ poolPrivate: false }))).toBe(0);
    const n = sale({ beds: null, bathsX10: null, garageSpacesX10: null, poolPrivate: null, yearBuilt: null, lotSqft: null, storiesX10: null });
    expect(OTHER_FEATURES.map((f) => featureValue(f, n))).toEqual([null, null, null, null, null, null, null]);
    expect([...CANNOT_LOWER_VALUE].sort()).toEqual(['baths', 'garage', 'lot', 'pool', 'size']);
  });
});

describe('time', () => {
  it('timeAmount is round(price x bps x months / 10,000), never -0', () => {
    expect(timeAmount(100, 50, 3)).toBe(2); // 1.5 -> 2
    expect(timeAmount(100, 50, 1)).toBe(1); // 0.5 -> 1
    expect(timeAmount(40_000_000, 25, 6)).toBe(600_000);
    expect(timeAmount(40_000_000, -25, 6)).toBe(-600_000);
    expect(Object.is(timeAmount(100, -1, 1), 0)).toBe(true);
    expect(timeAmount(100, 0, 9)).toBe(0);
  });

  it('fitTime needs 30 sales over 6 months; the trend is basis points of the median $/sq ft a month', () => {
    const flat = pool(30, (i) => ({ back: i % 6, closePriceCents: 40_000_000, sqft: 2_000 }));
    const t = fitTime(flat, R);
    expect(t).toMatchObject({ feature: 'time', rate: 0, support: { kind: 'sales_months', first: 30, second: 6 } });
    expect(t.view.applied).toBe(true);
    const few = fitTime(flat.slice(0, 29), R);
    expect(few.rate).toBeNull();
    expect(few.view.sentence).toBe('No market-change adjustment: 29 sales over 6 months (at least 30 over 6 are needed).');
    const five = fitTime(pool(40, (i) => ({ back: i % 5 })), R);
    expect(five.rate).toBeNull();
    expect(five.support).toMatchObject({ first: 40, second: 5 });
    // $/sq ft 200.00 now, 1.00 less for each month back: slope 100 cents a month at a median near 197.5.
    const rising = fitTime(pool(36, (i) => ({ back: i % 6, sqft: 2_000, closePriceCents: 2_000 * (20_000 - 100 * (i % 6)) })), R);
    expect(rising.rate).toBe(Math.round((100 / 19_750) * 10_000));
    expect(rising.view.sentence).toBe('Prices per sq ft changed by 0.51 % a month (from 36 sales over 6 months).');
    expect(rising.support.pairs).toBe(36 * 35 / 2 - 6 * (6 * 5) / 2);
  });

  it('compMonths counts from the contract date, else the close date', () => {
    expect(compMonths(sale({ contractDate: '2026-05-31', closeDate: '2026-07-01' }), REF)).toBe(6);
    expect(compMonths(sale({ contractDate: null, closeDate: '2026-07-01' }), REF)).toBe(4);
    expect(compMonths(sale({ contractDate: '2026-11-01' }), REF)).toBe(0);
  });
});

describe('fitRates and support (F11)', () => {
  const market = (n: number, seed = 2, extra: (i: number, rnd: () => number) => Partial<CmaSale> = () => ({})) =>
    pool(
      n,
      (i, rnd) => {
        const sqft = 1_500 + Math.floor(rnd() * 1_000);
        const e = extra(i, rnd);
        const beds = e.beds ?? 3;
        return { back: Math.floor(rnd() * 12), sqft, closePriceCents: sqft * 20_000 + (e.poolPrivate ? 2_000_000 : 0) + (beds - 3) * 1_000_000, ...e };
      },
      seed,
    );

  it('recovers size and feature rates on a clean market', () => {
    const r = fitRates(market(200, 3, (i) => ({ poolPrivate: i % 3 === 0, beds: 2 + (i % 4) })), REF, R);
    expect(r.poolSales).toBe(200);
    expect(r.refMonth).toBe(REF);
    expect(r.time.rate).toBe(0);
    expect(r.size.rate).toBeCloseTo(20_000, 6);
    expect(r.size.support).toMatchObject({ kind: 'above_below', first: 100, second: 100 });
    expect(r.features.get('pool')?.rate).toBeCloseTo(2_000_000, 3);
    expect(r.features.get('pool')?.support).toEqual({ kind: 'with_without', first: 67, second: 133, pairs: 67 * 133 });
    expect(r.features.get('beds')?.rate).toBeCloseTo(1_000_000, 3);
    expect(r.features.get('beds')?.support).toMatchObject({ kind: 'above_below', first: 100, second: 100 });
    expect(r.features.get('pool')?.view).toMatchObject({ applied: true, rate: 2_000_000, sentence: 'Private pool: $20,000 per pool (from 67 sales with, 133 without).' });
    expect(rateViews(r).map((v) => v.feature)).toEqual(['time', 'size', 'beds', 'baths', 'garage', 'pool', 'year_built', 'lot', 'stories']);
    // Features every sale shares cannot be measured.
    expect(r.features.get('baths')?.rate).toBeNull();
    expect(r.features.get('baths')?.view.sentence).toBe('Not enough variety in bathrooms to measure it: 0 sales above and 0 below the usual.');
  });

  it('fewer than 10 sales on a side, fewer than 3 values or fewer than 30 pairs: not applied, and says why', () => {
    const nine = fitRates(market(200, 4, (i) => ({ poolPrivate: i < 9 })), REF, R).features.get('pool');
    expect(nine?.rate).toBeNull();
    expect(nine?.view.sentence).toBe('Not enough sales with a pool (9) to measure it.');
    const ten = fitRates(market(200, 4, (i) => ({ poolPrivate: i < 10 })), REF, R).features.get('pool');
    expect(ten?.rate).not.toBeNull();
    const without = fitRates(market(200, 4, (i) => ({ poolPrivate: i >= 9 })), REF, R).features.get('pool');
    expect(without?.view.sentence).toBe('Not enough sales without a pool (9) to measure it.');
    const unknown = fitRates(market(30, 4, () => ({ poolPrivate: null })), REF, R).features.get('pool');
    expect(unknown?.support).toEqual({ kind: 'with_without', first: 0, second: 0, pairs: 0 });
    const two = fitRates(market(200, 5, (i) => ({ beds: i % 2 === 0 ? 2 : 4 })), REF, R).features.get('beds');
    expect(two?.rate).toBeNull();
    expect(two?.view.sentence).toBe('Not enough different bedrooms values (2; 3 are needed) to measure it.');
    const three = fitRates(market(200, 5, (i) => ({ beds: 2 + (i % 3) })), REF, R).features.get('beds');
    expect(three?.rate).not.toBeNull();
  });

  it('supportProblem checks both sides, then distinct values, then pairs', () => {
    const ok = { kind: 'above_below', first: 10, second: 10, pairs: 30 } as const;
    expect(supportProblem('beds', ok, 3, false, R)).toBeNull();
    expect(supportProblem('beds', { ...ok, first: 9 }, 3, false, R)).toBe('Not enough variety in bedrooms to measure it: 9 sales above and 10 below the usual.');
    expect(supportProblem('beds', { ...ok, second: 9 }, 3, false, R)).toBe('Not enough variety in bedrooms to measure it: 10 sales above and 9 below the usual.');
    expect(supportProblem('beds', ok, 2, false, R)).toBe('Not enough different bedrooms values (2; 3 are needed) to measure it.');
    expect(supportProblem('pool', { kind: 'with_without', first: 10, second: 10, pairs: 100 }, 2, true, R)).toBeNull();
    expect(supportProblem('beds', { ...ok, pairs: 29 }, 3, false, R)).toBe('Not enough pairs of sales to measure bedrooms (29; 30 are needed).');
    expect(supportProblem('pool', { kind: 'with_without', first: 10, second: 10, pairs: 29 }, 2, true, R)).toBe('Not enough pairs of sales to measure private pool (29; 30 are needed).');
  });

  it('a negative rate is applied only for a feature that can lower value', () => {
    const r = fitRates(market(200, 6, (i) => ({ poolPrivate: i % 2 === 0, yearBuilt: 1980 + (i % 30) })), REF, R);
    expect(r.features.get('year_built')?.rate).not.toBeNull();
    const neg = fitRates(
      pool(200, (i, rnd) => {
        const sqft = 1_500 + Math.floor(rnd() * 1_000);
        const pool = i % 2 === 0;
        const beds = 2 + (Math.floor(i / 2) % 4);
        return { back: Math.floor(rnd() * 12), sqft, poolPrivate: pool, beds, closePriceCents: sqft * 20_000 - (pool ? 1_000_000 : 0) - beds * 500_000 };
      }, 7),
      REF,
      R,
    );
    expect(neg.features.get('pool')).toMatchObject({ rate: null });
    expect(neg.features.get('pool')?.view.applied).toBe(false);
    const measured = neg.features.get('pool')?.view.rate as number;
    expect(Math.abs(measured + 1_000_000)).toBeLessThan(50_000);
    expect(neg.features.get('pool')?.view.sentence).toMatch(/^Private pool measured at -\$9,\d{3} per pool, but more pool cannot lower a price, so it is not adjusted\.$/);
    expect(Math.abs((neg.features.get('beds')?.rate as number) + 500_000)).toBeLessThan(25_000);
    expect(neg.features.get('beds')?.view.applied).toBe(true);
    const shrinking = fitRates(pool(60, (i) => ({ back: 0, sqft: 1_500 + i * 10, closePriceCents: 60_000_000 - i * 100_000 })), REF, R);
    expect(shrinking.size.rate).toBeNull();
    expect(shrinking.size.view.sentence).toBe('Size measured at -$100 per sq ft, but more sq ft cannot lower a price, so it is not adjusted.');
    // Without a size rate the residual is the time-adjusted price itself.
    expect(shrinking.features.get('beds')?.rate).toBeNull();
  });

  it('the size rate needs pairs at least 50 sq ft apart', () => {
    const tight = fitRates(pool(40, (i) => ({ back: i % 6, sqft: 2_000 + (i % 40), closePriceCents: (2_000 + (i % 40)) * 20_000 })), REF, R);
    expect(tight.size.rate).toBeNull();
    expect(tight.size.support.pairs).toBe(0);
    const spread = fitRates(pool(40, (i) => ({ back: i % 6, sqft: 1_800 + (i % 40) * 10, closePriceCents: (1_800 + (i % 40) * 10) * 20_000 })), REF, R);
    expect(spread.size.rate).toBeCloseTo(20_000, 6);
  });
});

describe('adjustComp and adjustedPrice', () => {
  const rates = fitRates(
    pool(240, (i, rnd) => {
      const sqft = 1_500 + Math.floor(rnd() * 1_000);
      const p = i % 3 === 0;
      const beds = 2 + (i % 4);
      const back = i % 12;
      return { back, contractDate: null, sqft, poolPrivate: p, beds, closePriceCents: Math.round(sqft * (20_000 - 100 * back) + (p ? 2_000_000 : 0) + (beds - 3) * 1_000_000) };
    }, 9),
    REF,
    R,
  );

  it('time, size, features and concessions, in that order; equal or unknown values are not adjusted', () => {
    const comp = sale({ contractDate: '2026-05-10', closeDate: '2026-06-10', sqft: 1_900, beds: 4, poolPrivate: true, concessionsCents: 500_000 });
    const adj = adjustComp(subject({ sqft: 2_000, beds: 3, poolPrivate: false }), comp, rates);
    expect(adj.map((a) => a.feature)).toEqual(['time', 'size', 'beds', 'pool', 'concessions']);
    const [time, size, beds, pool, conc] = adj;
    expect(time).toMatchObject({ subjectValue: 0, compValue: 6, rate: rates.time.rate, amountCents: timeAmount(40_000_000, rates.time.rate as number, 6) });
    expect(time?.sentence).toMatch(/^Market change: 6 months at 0\.\d+ % a month \(from 240 sales over 12 months\): \+\$[\d,]+\.$/);
    expect(size).toMatchObject({ subjectValue: 2_000, compValue: 1_900, amountCents: Math.round((rates.size.rate as number) * 100) });
    expect(beds).toMatchObject({ subjectValue: 3, compValue: 4, amountCents: Math.round(-(rates.features.get('beds')?.rate as number)) });
    expect(pool).toMatchObject({ subjectValue: 0, compValue: 1 });
    expect(pool?.amountCents).toBeLessThan(0);
    expect(conc).toMatchObject({ subjectValue: null, compValue: 500_000, rate: null, amountCents: -500_000, support: { kind: 'none', first: 0, second: 0, pairs: 0 } });
    expect(adjustComp(subject(), sale({ contractDate: '2026-11-03' }), rates).map((a) => a.feature)).toEqual([]);
    expect(adjustComp(subject({ beds: null }), sale({ beds: 5, contractDate: '2026-11-03' }), rates)).toEqual([]);
    expect(adjustComp(subject(), sale({ beds: null, contractDate: '2026-11-03' }), rates)).toEqual([]);
    expect(adjustComp(subject(), sale({ concessionsCents: 0, contractDate: '2026-11-03' }), rates)).toEqual([]);
    expect(adjustComp(subject(), comp, rates, false).every((a) => a.sentence === '')).toBe(true);
    expect(adjustComp(subject(), comp, rates, true).every((a) => a.sentence !== '')).toBe(true);
  });

  it('a rate that is not applied adjusts nothing', () => {
    const noSize = { ...rates, size: { ...rates.size, rate: null } };
    expect(adjustComp(subject(), sale({ sqft: 1_800, contractDate: '2026-11-03' }), noSize)).toEqual([]);
    const noTime = { ...rates, time: { ...rates.time, rate: null } };
    expect(adjustComp(subject(), sale({ contractDate: '2025-11-03' }), noTime)).toEqual([]);
  });

  it('adjustedPrice: price + net, never below 0; gross and the weight basis (no size) in floor basis points', () => {
    const s = sale({ closePriceCents: 30_000_000 });
    const a = (feature: 'size' | 'time' | 'beds', amountCents: number) => ({ feature, subjectValue: 0, compValue: 0, rate: 0, amountCents, support: { kind: 'none', first: 0, second: 0, pairs: 0 }, sentence: '' }) as const;
    expect(adjustedPrice(s, [])).toEqual({ adjustedPriceCents: 30_000_000, grossAdjustmentBps: 0, weightBasisBps: 0 });
    expect(adjustedPrice(s, [a('size', 300_000), a('time', -150_000), a('beds', 3_000)])).toEqual({ adjustedPriceCents: 30_153_000, grossAdjustmentBps: 151, weightBasisBps: 51 });
    expect(adjustedPrice(s, [a('time', -40_000_000)])).toEqual({ adjustedPriceCents: 0, grossAdjustmentBps: 13_333, weightBasisBps: 13_333 });
    expect(adjustedPrice(s, [a('size', 2_999)]).grossAdjustmentBps).toBe(0);
    expect(adjustedPrice(s, [a('size', 3_000)]).grossAdjustmentBps).toBe(1);
  });
});
