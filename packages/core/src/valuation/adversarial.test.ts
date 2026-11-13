// Adversarial tests of core/valuation (module 70, critical: pricing and fair housing). The engine is pure
// and tenant-free (V1-C reads the tenant's rows under RLS), so these try to break its own risk rules:
// smuggling non-property data past the strict schemas, inflating or deflating the value with planted
// sales, counting one sale twice, making the subject its own comp, and stretching the include/exclude
// controls past what R-CMA-2 allows.
import { describe, expect, it } from 'vitest';
import { type CmaCandidate, type CmaResult, type PrepareCmaInput, CMA_DEFAULTS, prepareCma } from './index.js';
import { SUBJECT_LAT, VALUATION_DATE, cand, linearMarket, monthsBefore, ref, sale, subject } from './testing/fixtures.js';

function run(over: Partial<PrepareCmaInput> & { candidates: readonly CmaCandidate[] }): CmaResult {
  return prepareCma({ subject: subject(), tierReads: [], valuationDate: VALUATION_DATE, ...over });
}

const local = (n: number, price = 40_000_000) =>
  Array.from({ length: n }, (_, i) => cand(`a${i}`, { closePriceCents: price + i * 100_000, closeDate: monthsBefore(1 + i), contractDate: monthsBefore(1 + i), latE6: SUBJECT_LAT + (i + 1) * 800 }));

describe('fair housing: nothing but property, transaction, time and location facts gets in', () => {
  it('a JSON "__proto__" key, a nested object or an unknown key is refused', () => {
    const smuggled = JSON.parse(`{"ref":${JSON.stringify(ref('x'))},"sale":${JSON.stringify(sale()).replace(/}$/, ',"__proto__":{"race":"x"}}')}}`) as CmaCandidate;
    expect(() => run({ candidates: [...local(3), smuggled] })).toThrow();
    expect(() => run({ candidates: [{ ref: ref('x'), sale: { ...sale(), city: { name: 'Fairview', medianIncome: 1 } as never } }] })).toThrow();
    expect(() => run({ candidates: [], subject: JSON.parse(JSON.stringify({ ...subject(), neighborhoodProfile: 'x' })) })).toThrow();
    const subjectProto = JSON.parse(JSON.stringify(subject()).replace(/}$/, ',"__proto__":{"familialStatus":"x"}}'));
    expect(() => run({ candidates: [], subject: subjectProto })).toThrow();
  });

  it('non-finite, fractional and out-of-range numbers are refused', () => {
    for (const bad of [{ sqft: Number.NaN }, { sqft: Number.POSITIVE_INFINITY }, { closePriceCents: 1.5 }, { latE6: 90_000_001 }, { bathsX10: -1 }, { yearBuilt: 1599 }]) {
      expect(() => run({ candidates: [{ ref: ref('x'), sale: sale(bad) }] })).toThrow();
    }
    expect(() => run({ candidates: [], subject: subject({ sqft: Number.NaN }) })).toThrow();
  });

  it('a long text field is refused (no listing remarks through a place name)', () => {
    expect(() => run({ candidates: [{ ref: ref('x'), sale: sale({ subdivisionName: 'x'.repeat(201) }) }] })).toThrow();
  });
});

describe('planted sales', () => {
  it('one wildly priced similar sale cannot move the value outside the honest comps', () => {
    const honest = local(5);
    const honestValue = (run({ candidates: honest }) as { valueCents: number }).valueCents;
    const planted = cand('planted', { closePriceCents: 400_000_000, closeDate: monthsBefore(1), contractDate: monthsBefore(1), latE6: SUBJECT_LAT + 100 });
    const r = run({ candidates: [...honest, planted] });
    expect(r.available).toBe(true);
    if (!r.available) return;
    const prices = honest.map((c) => c.sale.closePriceCents as number);
    expect(r.valueCents).toBeGreaterThanOrEqual(Math.min(...prices));
    expect(r.valueCents).toBeLessThanOrEqual(Math.max(...prices));
    expect(Math.abs(r.valueCents - honestValue)).toBeLessThanOrEqual(100_000);
    // The planted sale is shown, never hidden: it sets the top of the range, in the open.
    expect(r.highCents).toBe(400_000_000);
  });

  it('one sale under many identities (same address, same close date) counts once (R-MLS-5)', () => {
    const honest = local(5);
    const copies = Array.from({ length: 6 }, (_, i) =>
      cand(`copy${i}`, { addressKey: '9 copy ln|fairview|zz|99001', closePriceCents: 90_000_000, closeDate: monthsBefore(1), contractDate: monthsBefore(1), latE6: SUBJECT_LAT + 50 }, { connectionId: `conn-${i}` }),
    );
    const r = run({ candidates: [...honest, ...copies] });
    expect(r.comps.filter((c) => c.ref.identity.startsWith('copy'))).toHaveLength(1);
    expect(r.notUsed.filter((n) => n.reason === 'duplicate')).toHaveLength(5);
    // A resale of the same home on another day is a separate sale.
    const resale = cand('resale', { addressKey: '9 copy ln|fairview|zz|99001', closeDate: monthsBefore(5), contractDate: monthsBefore(5) });
    expect(run({ candidates: [...honest, copies[0] as CmaCandidate, resale] }).notUsed.find((n) => n.ref.identity === 'resale')?.reason).not.toBe('duplicate');
  });

  it('the subject never values itself: not by identity, team listing, MLS number or address', () => {
    const s = subject();
    const selves = [
      cand(s.ownIdentities[0] as string),
      cand('t', {}, { teamListingId: s.ownIdentities[0] as string }),
      cand('m', {}, { mlsNumber: s.ownMlsNumbers[0] as string }),
      cand('addr', { addressKey: s.addressKey }),
    ];
    const r = run({ candidates: [...local(5), ...selves], include: selves.map((c) => c.ref.identity) });
    expect(r.comps.map((c) => c.ref.identity)).not.toEqual(expect.arrayContaining(['t']));
    for (const c of selves) expect(r.comps.map((x) => x.ref.identity)).not.toContain(c.ref.identity);
    expect(r.subjectSales).toHaveLength(4);
    // The back-test never values with them either.
    const r0 = run({ candidates: local(5) });
    expect(r.backtest).toEqual(r0.backtest);
  });
});

describe('agent controls stay inside R-CMA-2', () => {
  it('include cannot add a sale older than the look-back, a future sale, another type or an unknown id', () => {
    const r = run({
      candidates: [
        ...local(5),
        cand('old', { saleConditions: ['reo'], closeDate: monthsBefore(30), contractDate: monthsBefore(30) }),
        cand('future', { closeDate: '2027-01-01' }),
        cand('condo', { propertyType: 'condo', saleConditions: ['auction'] }),
      ],
      include: ['old', 'future', 'condo', 'nobody'],
    });
    const ids = r.comps.map((c) => c.ref.identity);
    for (const id of ['old', 'future', 'condo', 'nobody']) expect(ids).not.toContain(id);
  });

  it('excluding every sale gives no value, and says so', () => {
    const cs = local(5);
    const r = run({ candidates: cs, exclude: cs.map((c) => c.ref.identity) });
    expect(r.available).toBe(false);
    expect(r.available ? null : r.reason).toBe('INSUFFICIENT_COMPS');
    expect(r.comps).toEqual([]);
    expect(r.sentences).toEqual(['No value: 0 comparable sales were found, and at least 3 are needed.']);
  });

  it('a rule override cannot pass as the default method', () => {
    const r = run({ candidates: local(5), rule: { minComps: 1, maxComps: 1 } });
    expect(r.methodVersion).not.toBe('cma/1');
    expect(() => run({ candidates: local(5), rule: { minComps: 'one' as never } })).toThrow();
    expect(() => run({ candidates: local(5), rule: { minComps: 1.5 } })).toThrow();
  });
});

describe('scale', () => {
  it('the largest prices the schema allows stay integer and inside the range', () => {
    const cs = local(5, 99_000_000_000).map((c) => ({ ...c, sale: { ...c.sale, originalListPriceCents: null, listPriceCents: null } }));
    const r = run({ candidates: cs });
    expect(r.available).toBe(true);
    if (r.available) {
      expect(Number.isSafeInteger(r.valueCents)).toBe(true);
      expect(r.lowCents).toBeLessThanOrEqual(r.valueCents);
      expect(r.valueCents).toBeLessThanOrEqual(r.highCents);
    }
  });

  it('a market of 2,000 sales with every rate measured still gives at most maxComps comps and a bounded not-used list', () => {
    const r = run({ candidates: linearMarket({ n: 2_000, seed: 21, trendCentsPerMonth: 30, poolCents: 2_000_000, bedCents: 800_000, noise: 0.04, radiusMiles: 3 }) });
    expect(r.comps.length).toBeLessThanOrEqual(CMA_DEFAULTS.maxComps);
    expect(r.notUsed.length).toBe(CMA_DEFAULTS.notUsedLimit);
    expect(r.notUsedTotal).toBeGreaterThan(CMA_DEFAULTS.notUsedLimit);
    expect(r.market.poolSales).toBeLessThanOrEqual(CMA_DEFAULTS.ratePoolLimit);
  });

  it('R-CMA-8: a sale the agent excluded is always listed as not used, even beyond the closest notUsedLimit, so the exclusion can be seen and undone', () => {
    const market = linearMarket({ n: 2_000, seed: 21, trendCentsPerMonth: 30, poolCents: 2_000_000, bedCents: 800_000, noise: 0.04, radiusMiles: 3 });
    const base = run({ candidates: market });
    const far = [...base.comps].sort((a, b) => (b.distanceM ?? 0) - (a.distanceM ?? 0))[0]!;
    const r = run({ candidates: market, exclude: [far.ref.identity] });
    expect(r.comps.map((c) => c.ref.identity)).not.toContain(far.ref.identity);
    // more than notUsedLimit not-used sales are closer, so only the exclusion rule lists it
    expect(r.notUsed.filter((n) => (n.distanceM ?? 0) < (far.distanceM ?? 0)).length).toBeGreaterThanOrEqual(CMA_DEFAULTS.notUsedLimit);
    expect(r.notUsed.find((n) => n.ref.identity === far.ref.identity)).toMatchObject({ reason: 'excluded_by_agent', includable: false });
    expect(r.notUsed).toHaveLength(CMA_DEFAULTS.notUsedLimit + 1);
    // the next-ranked sale took its place among the comps, so the count of not-used sales is unchanged
    expect(r.comps).toHaveLength(base.comps.length);
    expect(r.notUsedTotal).toBe(base.notUsedTotal);
    // without coordinates the list is in identity order: an excluded comp whose identity sorts last is listed too
    const flat = Array.from({ length: 200 }, (_, i) => cand(`id-${String(i).padStart(4, '0')}`, { latE6: null, lonE6: null, closeDate: i >= 190 ? monthsBefore(1) : monthsBefore(4), contractDate: null }));
    const noCoords = subject({ latE6: null, lonE6: null });
    const b2 = run({ subject: noCoords, candidates: flat });
    const last = [...b2.comps.map((c) => c.ref.identity)].sort().at(-1)!;
    const r2 = run({ subject: noCoords, candidates: flat, exclude: [last] });
    expect(r2.notUsed.find((n) => n.ref.identity === last)).toMatchObject({ reason: 'excluded_by_agent' });
  });
});
