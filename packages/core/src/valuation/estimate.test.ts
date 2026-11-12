// Unit tests of the value and the comp choice (estimate.ts, R-CMA-4): weights by largest remainder, the
// weighted median, the range, comp ranking and the rate pool. Exact values (mutation target).
import { describe, expect, it } from 'vitest';
import { fitRates } from './adjust.js';
import { chooseComps, estimate, poolSales, ratePool, rawWeight, weighed, weightedMedian, weightsBps } from './estimate.js';
import { addMonths, canonicalOrder, monthIndex, screen, searchTier } from './select.js';
import { CMA_DEFAULTS, type CmaCandidate } from './types.js';
import { LAT_PER_MILE, SUBJECT_LAT, VALUATION_DATE, cand, monthsBefore, subject } from './testing/fixtures.js';

const R = CMA_DEFAULTS;
const w = (identity: string, adjustedPriceCents: number, weightBasisBps = 0) => ({ identity, adjustedPriceCents, weightBasisBps });

describe('weights', () => {
  it('rawWeight is 10^12 / (10,000 + basis bps), floored', () => {
    expect(rawWeight(0)).toBe(100_000_000);
    expect(rawWeight(10_000)).toBe(50_000_000);
    expect(rawWeight(3)).toBe(Math.floor(1e12 / 10_003));
  });

  it('weightsBps sums to 10,000 by largest remainder; remainder ties go to the smaller identity', () => {
    expect([...weightsBps([w('c', 1), w('a', 1), w('b', 1)])]).toEqual([
      ['c', 3_333],
      ['a', 3_334],
      ['b', 3_333],
    ]);
    expect(Object.fromEntries(weightsBps([w('x', 1, 0), w('y', 1, 10_000)]))).toEqual({ x: 6_667, y: 3_333 });
    expect(Object.fromEntries(weightsBps([w('only', 1, 500)]))).toEqual({ only: 10_000 });
    expect(weightsBps([]).size).toBe(0);
    const six = weightsBps(['f', 'e', 'd', 'c', 'b', 'a'].map((id) => w(id, 1)));
    expect(Object.fromEntries(six)).toEqual({ a: 1_667, b: 1_667, c: 1_667, d: 1_667, e: 1_666, f: 1_666 });
    const mixed = weightsBps([w('a', 1, 0), w('b', 1, 100), w('c', 1, 2_000), w('d', 1, 50_000)]);
    expect([...mixed.values()].reduce((s, x) => s + x, 0)).toBe(10_000);
    expect(mixed.get('a')).toBeGreaterThan(mixed.get('b') as number);
    expect(mixed.get('b')).toBeGreaterThan(mixed.get('c') as number);
    expect(mixed.get('c')).toBeGreaterThan(mixed.get('d') as number);
  });

  it('the largest remainder wins over a smaller identity', () => {
    // raw 100,000,000 and 99,990,001: shares 5,000.25 and 4,999.75 -> the second has the larger remainder.
    expect(Object.fromEntries(weightsBps([w('a', 1, 0), w('b', 1, 1)]))).toEqual({ a: 5_000, b: 5_000 });
    expect(Object.fromEntries(weightsBps([w('a', 1, 0), w('b', 1, 0), w('c', 1, 30_000)]))).toEqual({ a: 4_445, b: 4_444, c: 1_111 });
  });
});

describe('weightedMedian and estimate', () => {
  it('sorts by adjusted price then identity and takes the first comp reaching 5,000 bps', () => {
    const cs = [w('a', 300), w('b', 100), w('c', 200)];
    expect(weightedMedian(cs, new Map([['a', 3_334], ['b', 3_333], ['c', 3_333]]))).toBe(200);
    expect(weightedMedian(cs, new Map([['a', 1_000], ['b', 5_000], ['c', 4_000]]))).toBe(100);
    expect(weightedMedian(cs, new Map([['a', 5_001], ['b', 2_000], ['c', 2_999]]))).toBe(300);
    expect(weightedMedian(cs, new Map([['a', 0], ['b', 4_999], ['c', 1]]))).toBe(200);
    expect(weightedMedian(cs, new Map())).toBe(300);
    expect(weightedMedian([], new Map())).toBeNull();
    // Equal adjusted prices: identity order.
    expect(weightedMedian([w('b', 100), w('a', 100)], new Map([['a', 5_000], ['b', 5_000]]))).toBe(100);
  });

  it('estimate needs minComps comps; the range is the lowest to the highest adjusted comp', () => {
    expect(estimate([w('a', 1), w('b', 2)], 3)).toBeNull();
    expect(estimate([], 0)).toBeNull();
    const e = estimate([w('a', 500), w('b', 100), w('c', 300)], 3);
    expect(e).toMatchObject({ valueCents: 300, lowCents: 100, highCents: 500 });
    expect(estimate([w('a', 7)], 0)).toMatchObject({ valueCents: 7, lowCents: 7, highCents: 7 });
    const skew = estimate([w('a', 100, 0), w('b', 200, 0), w('c', 900, 90_000)], 3);
    expect(skew).toMatchObject({ valueCents: 200, lowCents: 100, highCents: 900 });
  });
});

describe('chooseComps and the rate pool', () => {
  const near = (id: string, i: number, over = {}) => cand(id, { latE6: SUBJECT_LAT + i * 1_000, closeDate: monthsBefore(1), contractDate: monthsBefore(1), ...over });
  const choose = (cs: CmaCandidate[], opts: { include?: string[]; exclude?: string[] } = {}) => {
    const s = subject();
    const sc = screen(s, canonicalOrder(cs), VALUATION_DATE, R, new Set(opts.include ?? []));
    const exclude = new Set(opts.exclude ?? []);
    const se = searchTier(s, sc, VALUATION_DATE, R, exclude);
    const rates = fitRates([], monthIndex(VALUATION_DATE), R);
    return chooseComps(s, sc, se, rates, VALUATION_DATE, R, exclude);
  };
  const reasons = (c: ReturnType<typeof choose>) => Object.fromEntries(c.notUsed.map((n) => [n.s.c.ref.identity, n.reason]));

  it('keeps maxComps ranked by tier, gross, distance, newest and identity; agent-added sales come first', () => {
    const cs = [
      near('t-far', 8, { subdivisionName: null }), // tier 1 (within 1 mi)
      ...Array.from({ length: 6 }, (_, i) => near(`s${i}`, 6 - i)),
      near('same-a', 1, { closeDate: monthsBefore(2), contractDate: monthsBefore(1) }),
      near('same-b', 1),
    ];
    const c = choose(cs);
    expect(c.comps.map((x) => x.s.c.ref.identity)).toEqual(['s5', 'same-b', 'same-a', 's4', 's3', 's2']);
    expect(reasons(c)).toEqual({ 't-far': 'outside_area', s0: 'not_among_closest', s1: 'not_among_closest' });
    const forced = choose(cs, { include: ['t-far'] });
    expect(forced.comps.map((x) => x.s.c.ref.identity)).toEqual(['t-far', 's5', 'same-b', 'same-a', 's4', 's3']);
    const many = choose(cs, { include: cs.map((x) => x.ref.identity) });
    expect(many.comps).toHaveLength(9);
    expect(many.notUsed).toEqual([]);
  });

  it('a sale needing less adjustment ranks ahead within a tier', () => {
    const s = subject();
    const cs = Array.from({ length: 40 }, (_, i) => near(`p${String(i).padStart(2, '0')}`, 1 + (i % 7), { sqft: 1_700 + i * 15, closePriceCents: (1_700 + i * 15) * 20_000, closeDate: monthsBefore(1 + (i % 9)), contractDate: null }));
    const sc = screen(s, canonicalOrder(cs), VALUATION_DATE, R, new Set());
    const se = searchTier(s, sc, VALUATION_DATE, R, new Set());
    const rates = fitRates(poolSales(ratePool(sc, 2, null, addMonths(VALUATION_DATE, -24), R)), monthIndex(VALUATION_DATE), R);
    expect(rates.size.rate).not.toBeNull();
    const c = chooseComps(s, sc, se, rates, VALUATION_DATE, R, new Set());
    const gross = c.comps.map((x) => x.grossAdjustmentBps);
    expect(gross).toEqual([...gross].sort((a, b) => a - b));
    expect(Math.max(...gross)).toBeLessThanOrEqual(Math.min(...c.notUsed.filter((n) => n.reason === 'not_among_closest').map((n) => {
      const sale = n.s.c.sale;
      return Math.floor((Math.abs(Math.round((rates.size.rate as number) * (2_000 - (sale.sqft as number)))) * 10_000) / (sale.closePriceCents as number));
    })));
    expect(weighed(c.comps).map((x) => Object.keys(x).sort())).toEqual(c.comps.map(() => ['adjustedPriceCents', 'identity', 'weightBasisBps']));
  });

  it('reasons, in order: a failed rule, excluded, outside the area, not similar, outside the look-back', () => {
    const cs = [
      near('a', 1),
      near('b', 2),
      near('c', 3),
      near('lease', 4, { isLease: true }),
      near('gone', 5),
      near('far', 0, { latE6: SUBJECT_LAT + 9 * LAT_PER_MILE, postalCode: '99009', subdivisionName: null }),
      near('huge', 6, { sqft: 3_000 }),
      near('old', 7, { closeDate: monthsBefore(14), contractDate: monthsBefore(14) }),
      near('subj', 8, { addressKey: subject().addressKey }),
    ];
    const c = choose(cs, { exclude: ['gone', 'lease'] });
    expect(c.comps.map((x) => x.s.c.ref.identity)).toEqual(['a', 'b', 'c']);
    expect(reasons(c)).toEqual({ lease: 'lease', gone: 'excluded_by_agent', far: 'outside_area', huge: 'size_not_similar', old: 'too_old' });
  });

  it('an excluded agent-added sale stays out', () => {
    const c = choose([near('a', 1), near('b', 2), near('c', 3), near('x', 4, { saleConditions: ['reo'] })], { include: ['x'], exclude: ['x'] });
    expect(c.comps.map((x) => x.s.c.ref.identity)).not.toContain('x');
  });

  it('ratePool: default-eligible sales in the pool tier and date window, newest first, capped', () => {
    const s = subject();
    const cs = [
      near('n1', 1, { closeDate: '2026-11-01' }),
      near('n2', 1, { closeDate: '2026-10-01' }),
      near('n3', 1, { closeDate: '2026-10-01' }),
      near('short', 1, { saleConditions: ['short_sale'] }),
      near('city', 0, { latE6: SUBJECT_LAT + 9 * LAT_PER_MILE, postalCode: '99009', subdivisionName: null }),
      near('old', 1, { closeDate: '2024-11-28' }),
      near('edge', 1, { closeDate: '2024-11-29' }),
    ];
    const sc = screen(s, canonicalOrder(cs), VALUATION_DATE, R, new Set(['short']));
    const ids = (p: ReturnType<typeof ratePool>) => p.map((x) => x.c.ref.identity);
    expect(ids(ratePool(sc, 2, null, '2024-11-28', R))).toEqual(['n1', 'n2', 'n3', 'edge']);
    expect(ids(ratePool(sc, 4, null, '2024-11-28', R))).toEqual(['n1', 'city', 'n2', 'n3', 'edge']);
    expect(ids(ratePool(sc, 0, '2026-11-01', '2024-11-28', R))).toEqual(['n2', 'n3', 'edge']);
    expect(ids(ratePool(sc, -1, null, '2024-11-28', R))).toEqual([]);
    expect(ids(ratePool(sc, 2, null, '2024-11-28', { ...R, ratePoolLimit: 2 }))).toEqual(['n1', 'n2']);
    expect(poolSales(ratePool(sc, 2, null, '2024-11-28', R))[0]?.month).toBe(monthIndex(monthsBefore(1)));
  });

  it('poolSales dates each sale by its contract date, else its close date', () => {
    const sc = screen(subject(), canonicalOrder([near('c', 1, { closeDate: '2026-10-05', contractDate: '2026-08-01' }), near('d', 1, { closeDate: '2026-10-05', contractDate: null })]), VALUATION_DATE, R, new Set());
    expect(poolSales(sc).map((p) => p.month)).toEqual([monthIndex('2026-08-01'), monthIndex('2026-10-05')]);
  });
});
