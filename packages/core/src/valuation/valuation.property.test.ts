// Property tests of the comparable-sales engine (fast-check): R-CMA-2, R-CMA-3, R-CMA-4, R-CMA-5 and the
// back-test's out-of-sample rule.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runBacktest } from './backtest.js';
import { type CmaCandidate, type CmaResult, type CmaSale, type CmaSaleCondition, CMA_DEFAULTS, prepareCma } from './index.js';
import { addMonths, canonicalOrder, screen, searchTier } from './select.js';
import { SUBJECT_LAT, SUBJECT_LON, VALUATION_DATE, cand, linearMarket, monthsBefore, shuffled, subject } from './testing/fixtures.js';

const RUNS = { numRuns: 60 };

/** One plausible, eligible-looking sale near the subject (it may still fail the similarity filters). */
const saleArb = fc.record({
  back: fc.integer({ min: 0, max: 23 }),
  day: fc.integer({ min: 1, max: 28 }),
  contractLag: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
  sqft: fc.integer({ min: 1_550, max: 2_450 }),
  priceK: fc.integer({ min: 200, max: 700 }),
  beds: fc.option(fc.integer({ min: 2, max: 4 }), { nil: null }),
  bathsX10: fc.option(fc.integer({ min: 10, max: 35 }), { nil: null }),
  pool: fc.option(fc.boolean(), { nil: null }),
  dLat: fc.integer({ min: -40_000, max: 40_000 }),
  dLon: fc.integer({ min: -40_000, max: 40_000 }),
  located: fc.boolean(),
  postal: fc.constantFrom('99001', '99002'),
  sub: fc.constantFrom('Maple Glen', 'Cedar Row', null),
  conditions: fc.subarray<CmaSaleCondition>(['standard', 'short_sale', 'reo']),
  concessionsK: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
  yearBuilt: fc.integer({ min: 1975, max: 2015 }),
});
type SaleSeed = typeof saleArb extends fc.Arbitrary<infer T> ? T : never;

function toCandidate(s: SaleSeed, i: number, prefix = 'c'): CmaCandidate {
  const closeDate = monthsBefore(s.back, s.day);
  const price = s.priceK * 100_000;
  return cand(`${prefix}${String(i).padStart(3, '0')}`, {
    closePriceCents: price,
    closeDate,
    contractDate: s.contractLag === null ? null : addMonths(closeDate, -s.contractLag),
    listPriceCents: price,
    originalListPriceCents: price,
    sqft: s.sqft,
    beds: s.beds,
    bathsX10: s.bathsX10,
    poolPrivate: s.pool,
    latE6: s.located ? SUBJECT_LAT + s.dLat : null,
    lonE6: s.located ? SUBJECT_LON + s.dLon : null,
    postalCode: s.postal,
    subdivisionName: s.sub,
    saleConditions: s.conditions,
    concessionsCents: s.concessionsK === null ? null : s.concessionsK * 100_000,
    yearBuilt: s.yearBuilt,
  });
}

const marketArb = fc.array(saleArb, { minLength: 0, maxLength: 40 }).map((xs) => xs.map((s, i) => toCandidate(s, i)));

/** A candidate that is never a comp, with a fresh identity: each kind breaks exactly one hard rule. */
const BAD_KINDS = ['lease', 'pending', 'active', 'other_type', 'other_source', 'future', 'subject_address', 'subject_mls', 'subject_identity', 'no_close_date', 'no_price', 'no_size'] as const;
type BadKind = (typeof BAD_KINDS)[number];
function bad(kind: BadKind, base: CmaCandidate, id: string): CmaCandidate {
  const s = subject();
  const sale = (over: Partial<CmaSale>): CmaCandidate => ({ ref: { ...base.ref, identity: id, mlsNumber: `M-${id}`, teamListingId: null }, sale: { ...base.sale, addressKey: `${id}|x`, ...over } });
  switch (kind) {
    case 'lease':
      return sale({ isLease: true });
    case 'pending':
      return sale({ status: 'pending' });
    case 'active':
      return sale({ status: 'active' });
    case 'other_type':
      return sale({ propertyType: 'condo' });
    case 'other_source':
      return sale({ sizeSource: 'BuildingAreaTotal' });
    case 'future':
      return sale({ closeDate: addMonths(VALUATION_DATE, 1) });
    case 'subject_address':
      return sale({ addressKey: s.addressKey });
    case 'subject_mls':
      return { ...sale({}), ref: { ...base.ref, identity: id, mlsNumber: s.ownMlsNumbers[0] as string } };
    case 'subject_identity':
      return { ...sale({}), ref: { ...base.ref, identity: s.ownIdentities[0] as string } };
    case 'no_close_date':
      return sale({ closeDate: null });
    case 'no_price':
      return sale({ closePriceCents: null });
    case 'no_size':
      return sale({ sqft: null });
  }
}

function run(candidates: readonly CmaCandidate[], extra: { include?: string[]; exclude?: string[]; sqft?: number } = {}): CmaResult {
  return prepareCma({ subject: subject(extra.sqft === undefined ? {} : { sqft: extra.sqft }), candidates, tierReads: [], valuationDate: VALUATION_DATE, include: extra.include, exclude: extra.exclude });
}

/** The result without the not-used list (an extra ineligible candidate is listed there, by design). */
function core(r: CmaResult) {
  const { notUsed: _n, notUsedTotal: _t, subjectSales: _s, ...rest } = r;
  return rest;
}

describe('R-CMA-5: determinism', () => {
  it('R-CMA-5: any permutation of the candidates gives the same result', () => {
    fc.assert(
      fc.property(marketArb, fc.integer(), (market, seed) => {
        expect(run(shuffled(market, seed))).toEqual(run(market));
      }),
      RUNS,
    );
  });
});

describe('R-CMA-4: value and range', () => {
  it('R-CMA-4: the value is in [low, high] and every amount is an integer', () => {
    fc.assert(
      fc.property(marketArb, (market) => {
        const r = run(market);
        if (r.available) {
          expect(r.lowCents).toBeLessThanOrEqual(r.valueCents);
          expect(r.valueCents).toBeLessThanOrEqual(r.highCents);
          expect(r.comps.length).toBeGreaterThanOrEqual(CMA_DEFAULTS.minComps);
          expect(r.comps.reduce((a, c) => a + c.weightBps, 0)).toBe(10_000);
          for (const v of [r.valueCents, r.lowCents, r.highCents]) expect(Number.isInteger(v)).toBe(true);
        } else {
          expect('valueCents' in r).toBe(false);
          if (r.reason === 'INSUFFICIENT_COMPS') expect(r.comps.length).toBeLessThan(CMA_DEFAULTS.minComps);
        }
        for (const c of r.comps) {
          expect(Number.isInteger(c.adjustedPriceCents)).toBe(true);
          for (const a of c.adjustments) expect(Number.isInteger(a.amountCents)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe('R-CMA-2: what a comp is', () => {
  const extrasArb = fc.array(fc.tuple(fc.constantFrom(...BAD_KINDS), fc.nat()), { minLength: 1, maxLength: 8 });

  it('R-CMA-2: never a lease, a non-sale, a future or out-of-window sale, another type or size source, the subject or a duplicate', () => {
    fc.assert(
      fc.property(marketArb, extrasArb, fc.array(fc.integer({ min: 24, max: 40 }), { maxLength: 3 }), (market, extras, oldMonths) => {
        if (market.length === 0) return;
        const all = [
          ...market,
          ...extras.map(([k, n], i) => bad(k, market[n % market.length] as CmaCandidate, `bad${i}`)),
          ...oldMonths.map((m, i) => cand(`old${i}`, { closeDate: monthsBefore(m, 28), contractDate: monthsBefore(m + 1) })),
          ...market.slice(0, 2).map((c) => ({ ...c, sale: { ...c.sale, closePriceCents: (c.sale.closePriceCents as number) + 100 } })),
        ];
        const r = run(all);
        const s = subject();
        const oldest = addMonths(VALUATION_DATE, -CMA_DEFAULTS.extendedLookbackMonths);
        const seen = new Set<string>();
        for (const c of r.comps) {
          expect(c.sale.isLease).toBe(false);
          expect(c.sale.status).toBe('sold');
          expect(c.sale.closePriceCents as number).toBeGreaterThan(0);
          expect(c.sale.closeDate as string <= VALUATION_DATE).toBe(true);
          expect(c.sale.closeDate as string > oldest).toBe(true);
          expect(c.sale.propertyType).toBe(s.propertyType);
          expect(c.sale.sizeSource).toBe(s.sizeSource);
          expect(s.ownIdentities).not.toContain(c.ref.identity);
          expect(s.ownMlsNumbers).not.toContain(c.ref.mlsNumber);
          expect(c.sale.addressKey).not.toBe(s.addressKey);
          expect(seen.has(c.ref.identity)).toBe(false);
          seen.add(c.ref.identity);
        }
      }),
      RUNS,
    );
  });

  it('R-CMA-2: an ineligible extra candidate never changes the result', () => {
    fc.assert(
      fc.property(marketArb, fc.constantFrom(...BAD_KINDS), fc.nat(), (market, kind, n) => {
        if (market.length === 0) return;
        const extra = bad(kind, market[n % market.length] as CmaCandidate, 'zz-extra');
        expect(core(run([...market, extra]))).toEqual(core(run(market)));
      }),
      RUNS,
    );
  });

  it('R-CMA-2: an excluded id never appears among the comps', () => {
    fc.assert(
      fc.property(marketArb, fc.array(fc.nat(), { maxLength: 10 }), (market, picks) => {
        if (market.length === 0) return;
        const exclude = picks.map((p) => (market[p % market.length] as CmaCandidate).ref.identity);
        const r = run(market, { exclude });
        for (const c of r.comps) expect(exclude).not.toContain(c.ref.identity);
      }),
      RUNS,
    );
  });

  it('R-CMA-2 E367: include works only for sales that fail only the sale-condition or plausibility rules', () => {
    fc.assert(
      fc.property(marketArb, fc.array(fc.tuple(fc.constantFrom(...BAD_KINDS), fc.nat()), { maxLength: 4 }), fc.array(fc.nat(), { maxLength: 4 }), (market, extras, rescue) => {
        if (market.length === 0) return;
        const bads = extras.map(([k, n], i) => bad(k, market[n % market.length] as CmaCandidate, `bad${i}`));
        // Special-condition and implausible sales, which include may add.
        const specials = rescue.map((n, i) => {
          const base = market[n % market.length] as CmaCandidate;
          const sale: CmaSale = i % 2 === 0 ? { ...base.sale, saleConditions: ['short_sale'] } : { ...base.sale, closePriceCents: 240_000, originalListPriceCents: 240_000 };
          return { ref: { ...base.ref, identity: `sp${i}`, mlsNumber: `M-sp${i}` }, sale: { ...sale, addressKey: `sp${i}|x` } };
        });
        const include = [...bads, ...specials].map((c) => c.ref.identity);
        const r = run([...market, ...bads, ...specials], { include });
        const compIds = new Set(r.comps.map((c) => c.ref.identity));
        for (const b of bads) expect(compIds.has(b.ref.identity)).toBe(false);
        const oldest = addMonths(VALUATION_DATE, -CMA_DEFAULTS.extendedLookbackMonths);
        for (const sp of specials) {
          // An included special sale is a comp unless a hard rule keeps it out (here only the look-back can).
          if ((sp.sale.closeDate as string) > oldest) expect(compIds.has(sp.ref.identity)).toBe(true);
        }
        for (const c of r.comps) if (c.includedByAgent) expect(include).toContain(c.ref.identity);
      }),
      RUNS,
    );
  });
});

describe('R-CMA-3: adjustments', () => {
  it('R-CMA-3: concessions never raise a price', () => {
    fc.assert(
      fc.property(marketArb, (market) => {
        const r = run(market);
        for (const c of r.comps) {
          const conc = c.adjustments.filter((a) => a.feature === 'concessions');
          const k = c.sale.concessionsCents ?? 0;
          expect(conc).toHaveLength(k > 0 ? 1 : 0);
          for (const a of conc) expect(a.amountCents).toBe(-k);
          const others = c.adjustments.filter((a) => a.feature !== 'concessions').reduce((s, a) => s + a.amountCents, 0);
          expect(c.adjustedPriceCents).toBeLessThanOrEqual(Math.max(0, (c.sale.closePriceCents as number) + others));
        }
      }),
      RUNS,
    );
  });

  it('R-CMA-3 F12: scaling every price and concession by k scales the value by k within rounding', () => {
    const big = fc.array(saleArb, { minLength: 40, maxLength: 80 }).map((xs) => xs.map((s, i) => toCandidate(s, i)));
    fc.assert(
      fc.property(big, fc.integer({ min: 2, max: 5 }), (market, k) => {
        const scale = (c: CmaCandidate): CmaCandidate => ({
          ...c,
          sale: {
            ...c.sale,
            closePriceCents: (c.sale.closePriceCents as number) * k,
            listPriceCents: (c.sale.listPriceCents as number) * k,
            originalListPriceCents: (c.sale.originalListPriceCents as number) * k,
            concessionsCents: c.sale.concessionsCents === null ? null : c.sale.concessionsCents * k,
          },
        });
        const a = run(market);
        const b = run(market.map(scale));
        expect(b.available).toBe(a.available);
        if (a.available && b.available) {
          expect(b.comps.map((c) => c.ref.identity)).toEqual(a.comps.map((c) => c.ref.identity));
          const tolerance = k * 10 * (a.comps[0]?.adjustments.length ?? 0) + k;
          expect(Math.abs(b.valueCents - k * a.valueCents)).toBeLessThanOrEqual(tolerance);
          expect(Math.abs(b.lowCents - k * a.lowCents)).toBeLessThanOrEqual(k * 100);
          expect(Math.abs(b.highCents - k * a.highCents)).toBeLessThanOrEqual(k * 100);
        }
      }),
      RUNS,
    );
  });

  it('R-CMA-3 F12: with the comp set pinned and a non-negative size rate, a larger subject never lowers the value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1_700, max: 2_300 }), fc.integer({ min: 1, max: 400 }), (seed, sqft, more) => {
        const market = linearMarket({ n: 120, seed, trendCentsPerMonth: 30, poolCents: 2_000_000, bedCents: 900_000, noise: 0.05, radiusMiles: 0.9 });
        const first = run(market, { sqft });
        if (first.comps.length === 0) return;
        const pinned = first.comps.map((c) => c.ref.identity);
        const exclude = market.map((c) => c.ref.identity).filter((id) => !pinned.includes(id));
        const a = run(market, { sqft, include: pinned, exclude });
        const b = run(market, { sqft: sqft + more, include: pinned, exclude });
        expect(b.comps.map((c) => c.ref.identity).sort()).toEqual(a.comps.map((c) => c.ref.identity).sort());
        const sizeRate = a.market.rates.find((x) => x.feature === 'size');
        if (!a.available || !b.available || !sizeRate?.applied || (sizeRate.rate as number) < 0) return;
        expect(b.valueCents).toBeGreaterThanOrEqual(a.valueCents);
      }),
      // 200 runs: with gross-adjustment weights (size included) about 1 run in 70 broke this (seed 14:
      // +1 sq ft lowered the value by $13,521), which is why the weights leave the size adjustment out.
      { numRuns: 200 },
    );
  });
});

describe('back-test: out of sample', () => {
  it('no tested sale ever sees a later sale or a rate fitted on it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 60, max: 300 }), (seed, n) => {
        const market = canonicalOrder(linearMarket({ n, seed, trendCentsPerMonth: 20, noise: 0.03, radiusMiles: 1.2 }));
        const s = subject();
        const sc = screen(s, market, VALUATION_DATE, CMA_DEFAULTS, new Set());
        const se = searchTier(s, sc, VALUATION_DATE, CMA_DEFAULTS, new Set());
        const { trace, view } = runBacktest(s, market, sc, se, VALUATION_DATE, CMA_DEFAULTS);
        const poolIds = new Set(trace.pool.map((p) => p.identity));
        for (const p of trace.pool) expect(p.closeDate < trace.windowStart).toBe(true);
        for (const t of trace.tested) {
          expect(t.refDate >= trace.windowStart).toBe(true);
          expect(poolIds.has(t.identity)).toBe(false);
          for (const d of t.candidateCloseDates) expect(d < t.refDate).toBe(true);
          expect(t.candidateIdentities).not.toContain(t.identity);
        }
        expect(view.salesTested + view.notValued).toBe(trace.tested.length);
        expect(trace.tested.length).toBeLessThanOrEqual(CMA_DEFAULTS.backtestMaxSales);
      }),
      { numRuns: 20 },
    );
  });
});
