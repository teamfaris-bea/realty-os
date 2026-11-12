// Edge cases and acceptance of the comparable-sales engine (module 70): R-CMA-2..5, E360, E362..E368.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { type CmaAvailable, type CmaCandidate, type CmaResult, type PrepareCmaInput, CMA_DEFAULTS, CMA_METHOD_VERSION, prepareCma } from './index.js';
import { LAT_PER_MILE, SUBJECT_LAT, SUBJECT_LON, VALUATION_DATE, cand, linearMarket, monthsBefore, subject } from './testing/fixtures.js';

function run(over: Partial<PrepareCmaInput> & { candidates: readonly CmaCandidate[] }): CmaResult {
  return prepareCma({ subject: subject(), tierReads: [], valuationDate: VALUATION_DATE, ...over });
}

function available(r: CmaResult): CmaAvailable {
  if (!r.available) throw new Error(`expected a value, got ${r.reason}`);
  return r;
}

/** Five ordinary nearby sales within the last year (ids a1..a5). */
function local(n = 5): CmaCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    cand(`a${i + 1}`, {
      closePriceCents: 40_000_000 + i * 500_000,
      closeDate: monthsBefore(i + 1),
      contractDate: monthsBefore(i + 2),
      sqft: 1_950 + i * 25,
      latE6: SUBJECT_LAT + (i + 1) * 1_000,
    }),
  );
}

const ids = (r: CmaResult) => r.comps.map((c) => c.ref.identity);
const notUsed = (r: CmaResult, id: string) => r.notUsed.find((n) => n.ref.identity === id);

describe('accept: prepareCma on fixtures', () => {
  it('R-CMA-4 R-CMA-3: a value inside its range from >= 3 adjusted comps, the tier, rates with support and an out-of-sample back-test', () => {
    const candidates = linearMarket({ n: 600, seed: 7, trendCentsPerMonth: 40, poolCents: 2_500_000, poolShare: 0.35, bedCents: 1_000_000, noise: 0.02 });
    const r = available(run({ candidates }));
    expect(r.methodVersion).toBe(CMA_METHOD_VERSION);
    expect(r.comps.length).toBeGreaterThanOrEqual(3);
    expect(r.comps.length).toBeLessThanOrEqual(CMA_DEFAULTS.maxComps);
    expect(r.lowCents).toBeLessThanOrEqual(r.valueCents);
    expect(r.valueCents).toBeLessThanOrEqual(r.highCents);
    expect(r.lowCents).toBe(Math.min(...r.comps.map((c) => c.adjustedPriceCents)));
    expect(r.highCents).toBe(Math.max(...r.comps.map((c) => c.adjustedPriceCents)));
    expect(r.comps.reduce((a, c) => a + c.weightBps, 0)).toBe(10_000);
    for (const c of r.comps) {
      expect(c.why.length).toBeGreaterThanOrEqual(3);
      expect(c.tier).not.toBeNull();
      for (const a of c.adjustments) expect(a.sentence).not.toBe('');
    }
    expect(r.comps.some((c) => c.adjustments.length > 0)).toBe(true);
    expect(r.area.tier).toBe('subdivision');
    expect(r.area.sentences[0]).toBe('Comparable sales come from the same subdivision, sold within 12 months.');
    const applied = r.market.rates.filter((x) => x.applied);
    expect(applied.map((x) => x.feature)).toEqual(expect.arrayContaining(['time', 'size', 'pool', 'beds']));
    for (const x of applied) expect(x.support.first + x.support.second).toBeGreaterThan(0);
    expect(r.market.poolTier).toBe('postal_code');
    expect(r.backtest.salesTested).toBeGreaterThanOrEqual(CMA_DEFAULTS.backtestMinSales);
    expect(r.backtest.medianMissBps).not.toBeNull();
    expect(r.backtest.medianMissBps as number).toBeLessThan(1_000);
    expect(r.backtest.sentence).toMatch(/^On \d+ recent local sales, valued only from earlier sales, this method missed the price by /);
    expect(r.sentences[0]).toContain('not an appraisal');
  });

  it('R-CMA-3: a synthetic linear market with a known $/sq ft and monthly trend gives those rates back within 2 %', () => {
    const ppsf = 20_000;
    const trend = 50; // cents per sq ft a month
    const candidates = linearMarket({ n: 400, seed: 11, ppsfCents: ppsf, trendCentsPerMonth: trend, radiusMiles: 0.9, months: 24 });
    const r = available(run({ candidates }));
    const size = r.market.rates.find((x) => x.feature === 'size');
    const time = r.market.rates.find((x) => x.feature === 'time');
    expect(size?.applied).toBe(true);
    expect(time?.applied).toBe(true);
    expect(Math.abs((size?.rate as number) - ppsf) / ppsf).toBeLessThan(0.02);
    // The trend is reported in basis points of the pool's median $/sq ft a month.
    const ppsfs = candidates.map((c) => (c.sale.closePriceCents as number) / (c.sale.sqft as number)).sort((a, b) => a - b);
    const level = ((ppsfs[199] as number) + (ppsfs[200] as number)) / 2;
    const recovered = ((time?.rate as number) * level) / 10_000;
    expect(Math.abs(recovered - trend) / trend).toBeLessThan(0.02);
  });
});

describe('unavailable results', () => {
  it('R-CMA-4 E364: two eligible sales give INSUFFICIENT_COMPS with both listed and no number', () => {
    const r = run({ candidates: local(2) });
    expect(r.available).toBe(false);
    expect(r.available ? null : r.reason).toBe('INSUFFICIENT_COMPS');
    expect(ids(r).sort()).toEqual(['a1', 'a2']);
    expect('valueCents' in r).toBe(false);
    expect(r.comps.every((c) => c.weightBps === 0)).toBe(true);
    expect(r.sentences).toEqual(['No value: 2 comparable sales were found, and at least 3 are needed.']);
  });

  it('R-CMA-4: NO_SALES when no candidate is an eligible sale', () => {
    const r = run({ candidates: [cand('c1', { propertyType: 'condo' }), cand('c2', { status: 'active' })] });
    expect(r.available ? null : r.reason).toBe('NO_SALES');
    expect(r.comps).toEqual([]);
    expect(r.notUsedTotal).toBe(2);
  });

  it('F15: SUBJECT_INCOMPLETE without a property type or a size; every other fact is optional', () => {
    expect((run({ subject: subject({ sqft: null }), candidates: local() }) as { reason?: string }).reason).toBe('SUBJECT_INCOMPLETE');
    expect((run({ subject: subject({ propertyType: null }), candidates: local() }) as { reason?: string }).reason).toBe('SUBJECT_INCOMPLETE');
    expect((run({ subject: subject({ sqft: 0 }), candidates: local() }) as { reason?: string }).reason).toBe('SUBJECT_INCOMPLETE');
    const bare = subject({ beds: null, bathsX10: null, yearBuilt: null, lotSqft: null, garageSpacesX10: null, poolPrivate: null, storiesX10: null, subdivisionName: null, addressKey: null, ownIdentities: [], ownMlsNumbers: [] });
    expect(run({ subject: bare, candidates: local() }).available).toBe(true);
  });

  it('owner question g: land and other are SUBJECT_TYPE_NOT_SUPPORTED, with the reason in words', () => {
    for (const t of ['land', 'other'] as const) {
      const r = run({ subject: subject({ propertyType: t }), candidates: local().map((c) => ({ ...c, sale: { ...c.sale, propertyType: t } })) });
      expect(r.available ? null : r.reason).toBe('SUBJECT_TYPE_NOT_SUPPORTED');
      expect(r.sentences).toEqual(['No value: land and other property types are not valued yet.']);
      expect(r.comps).toEqual([]);
    }
  });
});

describe('R-CMA-2: what a comp is', () => {
  it('E360: a lease is never a comp; a "Residential" closed record at 2,400.00 is not used as a rent or a data error', () => {
    const r = run({
      candidates: [
        ...local(),
        cand('lease', { isLease: true, closePriceCents: 240_000 }),
        cand('rent', { closePriceCents: 240_000, listPriceCents: 240_000, originalListPriceCents: 240_000 }),
      ],
    });
    expect(ids(r)).not.toContain('lease');
    expect(ids(r)).not.toContain('rent');
    expect(notUsed(r, 'lease')?.reason).toBe('lease');
    expect(notUsed(r, 'lease')?.includable).toBe(false);
    expect(notUsed(r, 'rent')).toMatchObject({ reason: 'implausible_price', includable: true, sentence: 'Not used: the price looks like a rent or a data error.' });
  });

  it('F13: a price under 20 % of the original list price is implausible; the agent may include it after seeing why', () => {
    const odd = cand('odd', { closePriceCents: 7_000_000, originalListPriceCents: 40_000_000 });
    const r = run({ candidates: [...local(), odd] });
    expect(notUsed(r, 'odd')?.reason).toBe('implausible_price');
    const r2 = run({ candidates: [...local(), odd], include: ['odd'] });
    const c = r2.comps.find((x) => x.ref.identity === 'odd');
    expect(c?.includedByAgent).toBe(true);
    expect(c?.labels).toEqual(['price reviewed by the agent']);
    expect(c?.why).toContain('Added by the agent after review: a price that looked like a rent or a data error.');
    // Exactly 20 % of the original list price is plausible.
    expect(run({ candidates: [...local(), cand('edge', { closePriceCents: 8_000_000, originalListPriceCents: 40_000_000, sqft: 1_990 })] }).notUsed.find((n) => n.ref.identity === 'edge')?.reason).not.toBe('implausible_price');
  });

  it('E363: a pending record with a close price, a closed record without a close date and a close date after the valuation date are never comps', () => {
    const r = run({
      candidates: [
        ...local(),
        cand('pending', { status: 'pending', closePriceCents: 40_000_000 }),
        cand('nodate', { closeDate: null }),
        cand('future', { closeDate: '2026-11-29', contractDate: '2026-10-01' }),
      ],
    });
    expect(ids(r)).not.toEqual(expect.arrayContaining(['pending']));
    expect(notUsed(r, 'pending')?.reason).toBe('not_sold');
    expect(notUsed(r, 'nodate')?.reason).toBe('no_close_date');
    expect(notUsed(r, 'future')?.reason).toBe('after_valuation_date');
    expect(ids(r).filter((x) => ['pending', 'nodate', 'future'].includes(x))).toEqual([]);
  });

  it('E363: a sale closed on the valuation date is a comp', () => {
    const r = run({ candidates: [...local(), cand('today', { closeDate: VALUATION_DATE, contractDate: VALUATION_DATE, sqft: 2_000, latE6: SUBJECT_LAT })] });
    expect(ids(r)).toContain('today');
  });

  it('R-CMA-2: another property type, another size source, no size and no close price are never comps', () => {
    const r = run({
      candidates: [
        ...local(),
        cand('condo', { propertyType: 'condo' }),
        cand('total', { sizeSource: 'BuildingAreaTotal' }),
        cand('nosize', { sqft: null }),
        cand('noprice', { closePriceCents: null }),
        cand('zero', { closePriceCents: 0 }),
      ],
    });
    expect(notUsed(r, 'condo')?.reason).toBe('other_property_type');
    expect(notUsed(r, 'total')?.reason).toBe('other_size_source');
    expect(notUsed(r, 'nosize')?.reason).toBe('no_size');
    expect(notUsed(r, 'noprice')?.reason).toBe('no_close_price');
    expect(notUsed(r, 'zero')?.reason).toBe('no_close_price');
  });

  it('E365: the subject’s earlier sale (same address key, another MLS number) is never a comp and is shown as its sale history', () => {
    const s = subject();
    const earlier = cand('old-sale', { addressKey: s.addressKey, closeDate: monthsBefore(3), contractDate: monthsBefore(4) }, { mlsNumber: 'OTHER-9' });
    const own = cand('subject-listing', { status: 'active', closePriceCents: null, closeDate: null });
    const byMls = cand('mirror', {}, { mlsNumber: 'S100' });
    const r = run({ candidates: [...local(), earlier, own, byMls] });
    expect(ids(r)).not.toContain('old-sale');
    expect(ids(r)).not.toContain('mirror');
    expect(r.subjectSales.map((x) => x.ref.identity)).toEqual(['mirror', 'old-sale', 'subject-listing']);
    expect(notUsed(r, 'old-sale')).toBeUndefined();
  });

  it('E366 R-MLS-5: two candidates with the same teamListingId, or the same identity, count once', () => {
    const team = cand('team-1', { sqft: 2_000, latE6: SUBJECT_LAT }, { source: 'team', teamListingId: 'TL-1', mlsNumber: null });
    const mirror = cand('mls-9', { sqft: 2_000, latE6: SUBJECT_LAT }, { teamListingId: 'TL-1' });
    const again = cand('a1', { sqft: 2_000 });
    const r = run({ candidates: [...local(), mirror, team, again] });
    const both = ids(r).filter((x) => x === 'team-1' || x === 'mls-9');
    expect(both).toHaveLength(1);
    expect(ids(r).filter((x) => x === 'a1')).toHaveLength(1);
    expect(r.notUsed.filter((n) => n.reason === 'duplicate')).toHaveLength(2);
  });

  it('E367: a short sale is not used by default ("not used: short sale"); after include it is adjusted and labelled', () => {
    const short = cand('short', { saleConditions: ['short_sale'], sqft: 2_000, latE6: SUBJECT_LAT });
    const r = run({ candidates: [...local(), short] });
    expect(notUsed(r, 'short')).toMatchObject({ reason: 'sale_condition', conditions: ['short_sale'], includable: true, sentence: 'Not used: short sale.' });
    const r2 = run({ candidates: [...local(), short], include: ['short'] });
    const c = r2.comps.find((x) => x.ref.identity === 'short');
    expect(c?.includedByAgent).toBe(true);
    expect(c?.labels).toEqual(['short sale']);
    expect(c?.why).toContain('Added by the agent after review: short sale.');
    // 'standard' alongside is still a special condition; 'standard' alone is a standard sale.
    const r3 = run({ candidates: [...local(), cand('reo', { saleConditions: ['standard', 'reo'] }), cand('std', { saleConditions: ['standard'], sqft: 2_000 })] });
    expect(notUsed(r3, 'reo')?.sentence).toBe('Not used: bank-owned (REO).');
    expect(notUsed(r3, 'std')?.reason).not.toBe('sale_condition');
  });

  it('E367: include never rescues a lease, a non-sale or the subject', () => {
    const r = run({ candidates: [...local(), cand('lease', { isLease: true }), cand('pending', { status: 'pending' })], include: ['lease', 'pending', 'subject-listing'] });
    expect(ids(r)).not.toContain('lease');
    expect(ids(r)).not.toContain('pending');
    expect(r.comps.every((c) => !c.includedByAgent)).toBe(true);
  });

  it('R-CMA-2: an excluded sale is never a comp and is listed as removed by the agent', () => {
    const r = run({ candidates: local(6), exclude: ['a1'] });
    expect(ids(r)).not.toContain('a1');
    expect(notUsed(r, 'a1')).toMatchObject({ reason: 'excluded_by_agent', sentence: 'Not used: removed by the agent.' });
  });
});

describe('area tiers (R-CMA-2, F5, F6)', () => {
  it('E362: a subject in "None" (stored null) never uses the subdivision tier', () => {
    for (const name of [null, 'None', 'N/A', '0']) {
      const r = run({ subject: subject({ subdivisionName: name }), candidates: local().map((c) => ({ ...c, sale: { ...c.sale, subdivisionName: name } })) });
      expect(r.area.tier).not.toBe('subdivision');
      expect(r.comps.every((c) => c.tier !== 'subdivision')).toBe(true);
      expect(r.area.tiersSkipped).toContain('subdivision');
    }
  });

  it('E362 F5: "Oak Hill" in another postal code and more than 3 mi away is never a tier-1 comp; within 3 mi it is', () => {
    const s = subject({ subdivisionName: 'Oak Hill' });
    const far = cand('far', { subdivisionName: 'Oak Hill', postalCode: '99050', latE6: SUBJECT_LAT + 4 * LAT_PER_MILE });
    const near = cand('near', { subdivisionName: 'oak  hill ', postalCode: '99050', latE6: SUBJECT_LAT + 2 * LAT_PER_MILE });
    const zip = cand('zip', { subdivisionName: 'Oak Hill', postalCode: '99001-1234', latE6: null, lonE6: null });
    const r = run({ subject: s, candidates: [far, near, zip, cand('other', { subdivisionName: 'Cedar Row' })], exclude: [] });
    expect(r.comps.find((c) => c.ref.identity === 'far')?.tier ?? notUsed(r, 'far')?.reason).not.toBe('subdivision');
    expect(r.comps.find((c) => c.ref.identity === 'near')?.tier).toBe('subdivision');
    expect(r.comps.find((c) => c.ref.identity === 'zip')?.tier).toBe('subdivision');
  });

  it('R-CMA-2: tiers widen in order: subdivision, within 1 mi, postal code, within 3 mi, city', () => {
    const mk = (id: string, miles: number, postal: string, sub: string | null) =>
      cand(id, { latE6: SUBJECT_LAT + Math.round(miles * LAT_PER_MILE), postalCode: postal, subdivisionName: sub });
    const r1 = run({ candidates: [mk('n1', 0.5, '99009', null), mk('n2', 0.6, '99009', null), mk('n3', 0.9, '99009', null)] });
    expect(r1.area.tier).toBe('within_1mi');
    const r2 = run({ candidates: [mk('p1', 1.5, '99001', null), mk('p2', 0.6, '99009', null), mk('p3', 2.5, '99001', null)] });
    expect(r2.area.tier).toBe('postal_code');
    const r3 = run({ candidates: [mk('f1', 1.5, '99009', null), mk('f2', 2.0, '99009', null), mk('f3', 2.9, '99009', null)] });
    expect(r3.area.tier).toBe('within_3mi');
    const r4 = run({ candidates: [mk('c1', 5, '99009', null), mk('c2', 6, '99009', null), mk('c3', 7, '99009', null)] });
    expect(r4.area.tier).toBe('city');
    expect(r4.comps.map((c) => c.why[0])).toEqual(['In the same city; 5.0 mi away.', 'In the same city; 6.0 mi away.', 'In the same city; 7.0 mi away.']);
    const r5 = run({ candidates: [mk('x1', 5, '99009', null), mk('x2', 6, '99009', null), cand('x3', { city: 'Elsewhere', postalCode: '99009', latE6: SUBJECT_LAT + 9 * LAT_PER_MILE })] });
    expect(notUsed(r5, 'x3')?.reason).toBe('outside_area');
    expect(r5.available ? null : r5.reason).toBe('INSUFFICIENT_COMPS');
    expect(r5.area.sentences[0]).toBe('Fewer than 3 similar sales were found, even in the same city over 24 months.');
  });

  it('Fannie B4-1.3-08: each tier is tried at 12 months, then every tier at 24 months, and older sales are explained', () => {
    const old = [14, 15, 16].map((m, i) => cand(`o${i}`, { closeDate: monthsBefore(m), contractDate: monthsBefore(m + 1) }));
    const r = available(run({ candidates: [...old, cand('city-recent', { postalCode: '99009', subdivisionName: null, latE6: SUBJECT_LAT + 8 * LAT_PER_MILE })] }));
    expect(r.area.tier).toBe('subdivision');
    expect(r.area.lookbackMonths).toBe(24);
    expect(r.area.sentences).toContain('Sales older than 12 months were used because fewer than 3 similar sales closed in the last 12 months in any area.');
    expect(ids(r)).not.toContain('city-recent');
    // A sale more than 24 months old is never a comp.
    const r2 = run({ candidates: [...local(), cand('ancient', { closeDate: monthsBefore(25), contractDate: monthsBefore(26) })] });
    expect(notUsed(r2, 'ancient')).toMatchObject({ reason: 'too_old', sentence: 'Not used: it closed more than 24 months before the valuation date.' });
  });

  it('F6: a tier read that hit its limit says so', () => {
    const r = run({ candidates: local(), tierReads: [{ tier: 'postal_code', limitReached: true }, { tier: 'subdivision', limitReached: false }, { tier: 'rate_pool', limitReached: true }] });
    expect(r.area.sentences).toContain('Only the 300 most recent sales in the same postal code were read.');
    expect(r.area.sentences).toContain('Only the 600 most recent sales in the market-rate area were read.');
    expect(r.area.sentences.filter((s) => s.startsWith('Only the'))).toHaveLength(2);
  });

  it('E373: without coordinates the distance tiers are skipped and every comp says "distance not known"', () => {
    const r = available(run({ subject: subject({ latE6: null, lonE6: null }), candidates: local() }));
    expect(r.area.tiersSkipped).toEqual(['within_1mi', 'within_3mi']);
    expect(r.area.sentences).toContain('Distance tiers were skipped because the home has no coordinates.');
    expect(r.comps.every((c) => c.distanceM === null && c.why[0]?.endsWith('distance not known.'))).toBe(true);
    expect(r.distanceSpanM).toBeNull();
  });

  it('a subject with no place at all searches no tier', () => {
    const r = run({ subject: subject({ latE6: null, lonE6: null, postalCode: null, city: null, subdivisionName: null }), candidates: local() });
    expect(r.area.tier).toBeNull();
    expect(r.area.sentences[0]).toBe('No area could be searched: the home has no subdivision, coordinates, postal code or city.');
    expect(r.available ? null : r.reason).toBe('INSUFFICIENT_COMPS');
  });
});

describe('similarity filters', () => {
  it('size within +-20 %, beds +-1 and year built +-25; a filter the subject lacks is skipped and says so', () => {
    const r = run({
      candidates: [
        ...local(),
        cand('big', { sqft: 2_401 }),
        cand('edge', { sqft: 2_400, latE6: SUBJECT_LAT + 9_000 }),
        cand('beds', { beds: 5 }),
        cand('old', { yearBuilt: 1969 }),
      ],
    });
    expect(notUsed(r, 'big')?.reason).toBe('size_not_similar');
    expect(notUsed(r, 'edge')?.reason).not.toBe('size_not_similar');
    expect(notUsed(r, 'beds')).toMatchObject({ reason: 'beds_not_similar', sentence: 'Not used: more than 1 bedroom different.' });
    expect(notUsed(r, 'old')).toMatchObject({ reason: 'year_built_not_similar', sentence: 'Not used: built more than 25 years apart.' });
    const r2 = run({ subject: subject({ beds: null, yearBuilt: null }), candidates: [...local(), cand('beds', { beds: 5 }), cand('old', { yearBuilt: 1969 })] });
    expect(notUsed(r2, 'beds')?.reason).not.toBe('beds_not_similar');
    expect(notUsed(r2, 'old')?.reason).not.toBe('year_built_not_similar');
    expect(r2.area.sentences).toEqual(expect.arrayContaining(['Bedrooms were not compared because the home has no bedroom count.', 'Year built was not compared because the home has no year built.']));
  });

  it('ranking: tier, then gross adjustment, then distance, then newest, then identity; at most 6 comps', () => {
    const many = Array.from({ length: 9 }, (_, i) => cand(`r${i}`, { latE6: SUBJECT_LAT + (9 - i) * 500, closeDate: monthsBefore(1), contractDate: monthsBefore(1) }));
    const r = run({ candidates: many });
    expect(ids(r)).toEqual(['r8', 'r7', 'r6', 'r5', 'r4', 'r3']);
    expect(r.notUsed.filter((n) => n.reason === 'not_among_closest').map((n) => n.ref.identity).sort()).toEqual(['r0', 'r1', 'r2']);
  });
});

describe('adjustments (R-CMA-3)', () => {
  it('E368: $15,000 of seller concessions lowers the adjusted price by $15,000, never raises it', () => {
    const base = local(6);
    const withC = base.map((c) => (c.ref.identity === 'a2' ? { ...c, sale: { ...c.sale, concessionsCents: 1_500_000 } } : c));
    const r0 = run({ candidates: base });
    const r1 = run({ candidates: withC });
    const c0 = r0.comps.find((c) => c.ref.identity === 'a2');
    const c1 = r1.comps.find((c) => c.ref.identity === 'a2');
    expect((c0?.adjustedPriceCents as number) - (c1?.adjustedPriceCents as number)).toBe(1_500_000);
    const adj = c1?.adjustments.find((a) => a.feature === 'concessions');
    expect(adj).toMatchObject({ amountCents: -1_500_000, compValue: 1_500_000, rate: null, sentence: 'Seller concessions of $15,000 are taken off its price: -$15,000.' });
  });

  it('F11: 1 pool sale in 300 gives no pool adjustment and says "Not enough sales with a pool (1) to measure it."', () => {
    const market = linearMarket({ n: 300, seed: 3, poolShare: 0, radiusMiles: 0.9 });
    const withOne = market.map((c, i) => (i === 0 ? { ...c, sale: { ...c.sale, poolPrivate: true } } : c));
    const r = run({ subject: subject({ poolPrivate: true }), candidates: withOne });
    const pool = r.market.rates.find((x) => x.feature === 'pool');
    expect(pool).toMatchObject({ applied: false, rate: null, sentence: 'Not enough sales with a pool (1) to measure it.' });
    expect(pool?.support).toMatchObject({ kind: 'with_without', first: 1, second: 299 });
    expect(r.comps.flatMap((c) => c.adjustments).some((a) => a.feature === 'pool')).toBe(false);
  });

  it('R-CMA-3: with fewer than 30 sales over 6 months there is no time adjustment, and a sentence says why', () => {
    const r = run({ candidates: local() });
    const time = r.market.rates.find((x) => x.feature === 'time');
    expect(time).toMatchObject({ applied: false, rate: null });
    expect(time?.sentence).toBe('No market-change adjustment: 5 sales over 5 months (at least 30 over 6 are needed).');
    expect(r.comps.flatMap((c) => c.adjustments).some((a) => a.feature === 'time')).toBe(false);
  });

  it('R-CMA-3: a feature that cannot lower value with a negative measured rate is not applied, and says so', () => {
    // Pools sell for less here (a data quirk): the measured rate is negative and must not be applied.
    const market = linearMarket({ n: 300, seed: 5, poolShare: 0.4, poolCents: -3_000_000, radiusMiles: 0.9 });
    const r = run({ subject: subject({ poolPrivate: true }), candidates: market });
    const pool = r.market.rates.find((x) => x.feature === 'pool');
    expect(pool?.applied).toBe(false);
    expect(pool?.rate as number).toBeLessThan(0);
    expect(pool?.sentence).toMatch(/^Private pool measured at -\$[\d,]+ per pool, but more pool cannot lower a price, so it is not adjusted\.$/);
    // Bedrooms may lower a price: a negative bedroom rate is applied.
    const m2 = linearMarket({ n: 300, seed: 5, bedCents: -1_000_000, radiusMiles: 0.9 });
    const beds = run({ candidates: m2 }).market.rates.find((x) => x.feature === 'beds');
    expect(beds?.applied).toBe(true);
    expect(beds?.rate as number).toBeLessThan(0);
  });

  it('R-CMA-3: every adjustment carries its feature, both values, the rate, the amount, its support and a sentence', () => {
    const r = available(run({ candidates: linearMarket({ n: 400, seed: 9, trendCentsPerMonth: 40, poolCents: 2_000_000, bedCents: 800_000, radiusMiles: 0.9 }), subject: subject({ poolPrivate: true, beds: 4 }) }));
    const all = r.comps.flatMap((c) => c.adjustments);
    expect(new Set(all.map((a) => a.feature))).toEqual(new Set(['time', 'size', 'beds', 'pool', 'year_built']));
    for (const a of all) {
      expect(Number.isInteger(a.amountCents)).toBe(true);
      expect(a.support.first).toBeGreaterThan(0);
      expect(a.sentence).toMatch(/: [+-]?\$[\d,]+\.$/);
    }
    const size = all.find((a) => a.feature === 'size' && a.subjectValue !== a.compValue);
    expect(size?.sentence).toMatch(/^Size: 2,000 sq ft here, [\d,]+ sq ft there, at \$\d+ per sq ft \(from \d+ sales above, \d+ below the usual size\): [+-]\$[\d,]+\.$/);
  });
});

describe('regression: the size monotonicity counterexample (F12)', () => {
  it('R-CMA-4 F12: with the comps pinned, 1 more sq ft never lowers the value (seed 14 once lost $13,521 with size in the weights)', () => {
    const market = linearMarket({ n: 120, seed: 14, trendCentsPerMonth: 30, poolCents: 2_000_000, bedCents: 900_000, noise: 0.05, radiusMiles: 0.9 });
    const first = run({ candidates: market, subject: subject({ sqft: 2_094 }) });
    const pinned = first.comps.map((c) => c.ref.identity);
    const exclude = market.map((c) => c.ref.identity).filter((id) => !pinned.includes(id));
    const a = available(run({ candidates: market, subject: subject({ sqft: 2_094 }), include: pinned, exclude }));
    const b = available(run({ candidates: market, subject: subject({ sqft: 2_095 }), include: pinned, exclude }));
    expect(a.market.rates.find((x) => x.feature === 'size')?.applied).toBe(true);
    expect(b.valueCents).toBeGreaterThanOrEqual(a.valueCents);
    // The weights read every adjustment except size, so they do not move with the subject's size.
    expect(b.comps.map((c) => c.weightBps)).toEqual(a.comps.map((c) => c.weightBps));
    for (const c of a.comps) {
      const nonSize = c.adjustments.filter((x) => x.feature !== 'size').reduce((t, x) => t + Math.abs(x.amountCents), 0);
      expect(c.weightBasisBps).toBe(Math.floor((nonSize * 10_000) / (c.sale.closePriceCents as number)));
    }
  });
});

describe('determinism and the method version (R-CMA-5)', () => {
  it('R-CMA-5: CMA_DEFAULTS is pinned to CMA_METHOD_VERSION: changing a default needs a new method version', () => {
    const PINNED: Record<string, string> = { 'cma/1': '18067304' };
    const digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify(CMA_DEFAULTS)))).slice(0, 8);
    expect({ version: CMA_METHOD_VERSION, digest }).toEqual({ version: CMA_METHOD_VERSION, digest: PINNED[CMA_METHOD_VERSION] });
    expect(Object.isFrozen(CMA_DEFAULTS)).toBe(true);
  });

  it('R-CMA-5: a result made with any rule override carries another method version', () => {
    expect(run({ candidates: local() }).methodVersion).toBe('cma/1');
    expect(run({ candidates: local(), rule: { maxComps: 6 } }).methodVersion).toBe('cma/1');
    expect(run({ candidates: local(), rule: { maxComps: 4 } }).methodVersion).toBe('cma/1+custom-rule');
  });

  it('R-CMA-5: values are integer cents and the comps weights sum to 10,000 bps', () => {
    const r = available(run({ candidates: linearMarket({ n: 200, seed: 2, noise: 0.05, trendCentsPerMonth: 30 }) }));
    for (const v of [r.valueCents, r.lowCents, r.highCents, ...r.comps.map((c) => c.adjustedPriceCents)]) expect(Number.isInteger(v)).toBe(true);
    expect(r.comps.reduce((a, c) => a + c.weightBps, 0)).toBe(10_000);
  });
});

describe('back-test (evidence, never a score)', () => {
  it('fewer than 10 tested sales give nulls and the sentence', () => {
    const r = run({ candidates: local() });
    expect(r.backtest).toMatchObject({ medianMissBps: null, within10PctBps: null, sentence: 'Not enough recent local sales to measure how close this method comes.' });
  });
});

describe('inputs', () => {
  it('the valuation date and the rule overrides are validated', () => {
    expect(() => run({ candidates: local(), valuationDate: '2026-02-30' })).toThrow();
    expect(() => run({ candidates: local(), valuationDate: '11/01/2026' })).toThrow();
    expect(() => run({ candidates: local(), rule: { maxComps: -1 } })).toThrow();
    expect(() => run({ candidates: [cand('x', { closeDate: '2024-02-30' })] })).toThrow();
  });

  it('the subject sits where expected (fixture sanity)', () => {
    expect(subject().latE6).toBe(SUBJECT_LAT);
    expect(subject().lonE6).toBe(SUBJECT_LON);
  });
});
