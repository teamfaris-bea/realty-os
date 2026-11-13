// Unit tests of comp selection (select.ts): calendar, distance, place keys, tiers, screening and the tier
// search (R-CMA-2). Exact values, so a changed boundary is caught (mutation target).
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  canonicalOrder,
  closedAfter,
  dayNumber,
  distanceBetween,
  distanceM,
  monthIndex,
  narrowestTier,
  plausiblePrice,
  poolTierIndex,
  postalKey,
  screen,
  searchTier,
  subdivisionKey,
  subjectPlace,
  tierAvailable,
  withinMonths,
} from './select.js';
import { CMA_DEFAULTS, type CmaCandidate } from './types.js';
import { LAT_PER_MILE, SUBJECT_LAT, SUBJECT_LON, VALUATION_DATE, cand, monthsBefore, subject } from './testing/fixtures.js';

const R = CMA_DEFAULTS;
const none = new Set<string>();
const one = (c: CmaCandidate, inc: Set<string> = none, s = subject()) => screen(s, [c], VALUATION_DATE, R, inc)[0] as ReturnType<typeof screen>[number];

describe('calendar', () => {
  it('dayNumber, monthIndex and addMonths (the day clamped to the month)', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('1970-02-01')).toBe(31);
    expect(monthIndex('2026-11-28')).toBe(2026 * 12 + 10);
    expect(monthIndex('2026-01-01')).toBe(2026 * 12);
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-11-28', -24)).toBe('2024-11-28');
    expect(addMonths('2026-05-09', 0)).toBe('2026-05-09');
    expect(addMonths('0999-01-01', 0)).toBe('0999-01-01');
  });
});

describe('distance', () => {
  it('haversine in whole metres on microdegrees', () => {
    expect(distanceM(0, 0, 0, 0)).toBe(0);
    expect(distanceM(0, 0, 1_000_000, 0)).toBe(111_195);
    expect(distanceM(0, 0, 0, 1_000_000)).toBe(111_195);
    expect(distanceM(60_000_000, 0, 60_000_000, 1_000_000)).toBe(55_597);
    expect(distanceM(-1_000_000, 0, 1_000_000, 0)).toBe(222_390);
    expect(distanceM(90_000_000, 0, -90_000_000, 0)).toBe(20_015_114);
    expect(distanceM(SUBJECT_LAT, SUBJECT_LON, SUBJECT_LAT + LAT_PER_MILE, SUBJECT_LON)).toBe(1_612);
  });

  it('distanceBetween is null when either side lacks coordinates', () => {
    const a = { latE6: 0, lonE6: 0 };
    expect(distanceBetween(a, { latE6: 1_000_000, lonE6: 0 })).toBe(111_195);
    expect(distanceBetween(a, { latE6: null, lonE6: 0 })).toBeNull();
    expect(distanceBetween(a, { latE6: 0, lonE6: null })).toBeNull();
    expect(distanceBetween({ latE6: null, lonE6: null }, a)).toBeNull();
    expect(distanceBetween({ latE6: 0, lonE6: null }, a)).toBeNull();
  });
});

describe('place keys', () => {
  it('subdivisionKey folds case and spaces; placeholders are no subdivision (E362)', () => {
    expect(subdivisionKey('  Oak   HILL ')).toBe('oak hill');
    for (const p of ['None', 'N/A', 'na', '0', '-', '', '  ', 'No', 'Unknown', 'Not Applicable', 'not in a subdivision']) expect(subdivisionKey(p)).toBeNull();
    expect(subdivisionKey(null)).toBeNull();
    expect(subdivisionKey('Nonesuch')).toBe('nonesuch');
  });

  it('postalKey keeps the 5-digit ZIP of a ZIP+4, else the trimmed upper-case code', () => {
    expect(postalKey('99001')).toBe('99001');
    expect(postalKey('99001-1234')).toBe('99001');
    expect(postalKey('990011234')).toBe('99001');
    expect(postalKey('99001 1234')).toBe('99001');
    expect(postalKey(' k1a 0b1 ')).toBe('K1A 0B1');
    expect(postalKey('9900')).toBe('9900');
    expect(postalKey('99001-12')).toBe('99001-12');
    expect(postalKey('')).toBeNull();
    expect(postalKey('   ')).toBeNull();
    expect(postalKey(null)).toBeNull();
  });

  it('subjectPlace and tierAvailable', () => {
    const p = subjectPlace(subject({ city: ' Fair  View ', region: 'ZZ' }));
    expect(p).toEqual({ subdivision: 'maple glen', postal: '99001', city: 'fair view', region: 'zz', located: true });
    expect(subjectPlace(subject({ city: '  ', latE6: null })).city).toBeNull();
    expect(subjectPlace(subject({ latE6: null })).located).toBe(false);
    expect(subjectPlace(subject({ lonE6: null })).located).toBe(false);
    const empty = subjectPlace(subject({ subdivisionName: null, postalCode: null, city: null, latE6: null, lonE6: null }));
    expect(['subdivision', 'within_1mi', 'postal_code', 'within_3mi', 'city'].map((t) => tierAvailable(empty, t as never))).toEqual([false, false, false, false, false]);
    expect(['subdivision', 'within_1mi', 'postal_code', 'within_3mi', 'city'].map((t) => tierAvailable(p, t as never))).toEqual([true, true, true, true, true]);
  });
});

describe('narrowestTier', () => {
  const place = subjectPlace(subject());
  const facts = (over: Partial<{ subdivisionName: string | null; postalCode: string | null; city: string | null; region: string | null }> = {}) => ({
    subdivisionName: 'Maple Glen',
    postalCode: '99001',
    city: 'Fairview',
    region: 'ZZ',
    ...over,
  });

  it('subdivision needs the same postal code or 3 mi (F5)', () => {
    expect(narrowestTier(place, facts(), null, R)).toBe(0);
    expect(narrowestTier(place, facts({ postalCode: '99009' }), R.farRadiusM, R)).toBe(0);
    expect(narrowestTier(place, facts({ postalCode: '99009' }), R.farRadiusM + 1, R)).toBe(4);
    expect(narrowestTier(place, facts({ postalCode: '99009' }), null, R)).toBe(4);
    expect(narrowestTier(place, facts({ subdivisionName: 'Cedar Row' }), null, R)).toBe(2);
  });

  it('the distance tiers are inclusive at their radius', () => {
    const f = facts({ subdivisionName: null, postalCode: '99009' });
    expect(narrowestTier(place, f, R.nearRadiusM, R)).toBe(1);
    expect(narrowestTier(place, f, R.nearRadiusM + 1, R)).toBe(3);
    expect(narrowestTier(place, f, R.farRadiusM, R)).toBe(3);
    expect(narrowestTier(place, f, R.farRadiusM + 1, R)).toBe(4);
    expect(narrowestTier(place, facts({ subdivisionName: null }), R.farRadiusM + 1, R)).toBe(2);
  });

  it('the city tier needs the same region when both are known', () => {
    const f = facts({ subdivisionName: null, postalCode: '99009' });
    expect(narrowestTier(place, { ...f, city: 'fairview ' }, null, R)).toBe(4);
    expect(narrowestTier(place, { ...f, region: 'YY' }, null, R)).toBe(-1);
    expect(narrowestTier(place, { ...f, region: null }, null, R)).toBe(4);
    expect(narrowestTier(subjectPlace(subject({ region: null })), { ...f, region: 'YY' }, null, R)).toBe(4);
    expect(narrowestTier(place, { ...f, city: 'Elsewhere' }, null, R)).toBe(-1);
  });

  it('unavailable tiers are skipped', () => {
    const p = subjectPlace(subject({ subdivisionName: null, postalCode: null }));
    expect(narrowestTier(p, facts(), 10, R)).toBe(1);
    expect(narrowestTier(p, facts(), 2_000, R)).toBe(3);
    const p2 = subjectPlace(subject({ subdivisionName: null, latE6: null, lonE6: null }));
    expect(narrowestTier(p2, facts({ postalCode: '99001' }), 10, R)).toBe(2);
    expect(narrowestTier(p2, facts({ postalCode: '99009' }), 10, R)).toBe(4);
  });
});

describe('canonicalOrder and plausiblePrice', () => {
  it('orders by identity, then team before MLS, then content', () => {
    const a = cand('b');
    const b = cand('a', {}, { source: 'mls' });
    const c = cand('a', {}, { source: 'team' });
    const d = cand('a', { closePriceCents: 1 }, { source: 'team' });
    const e = cand('a', { closePriceCents: 2 }, { source: 'team' });
    expect(canonicalOrder([a, b, e, c, d]).map((x) => [x.ref.identity, x.ref.source, x.sale.closePriceCents])).toEqual([
      ['a', 'team', 1],
      ['a', 'team', 2],
      ['a', 'team', 40_000_000],
      ['a', 'mls', 40_000_000],
      ['b', 'mls', 40_000_000],
    ]);
    expect(canonicalOrder([c, c]).length).toBe(2);
  });

  it('a price is plausible from the minimum sale price and at 20 % of the original list price (F13)', () => {
    expect(plausiblePrice(R.minSalePriceCents, null, R)).toBe(true);
    expect(plausiblePrice(R.minSalePriceCents - 1, null, R)).toBe(false);
    expect(plausiblePrice(2_000_000, 10_000_000, R)).toBe(true);
    expect(plausiblePrice(1_999_999, 10_000_000, R)).toBe(false);
    expect(plausiblePrice(2_000_000, 0, R)).toBe(true);
  });
});

describe('screen', () => {
  it('reasons in order: subject, sold, price, date, valuation date, lease, type, size, size source, look-back', () => {
    expect(one(cand('x', { status: 'pending', closePriceCents: null })).fail).toBe('not_sold');
    expect(one(cand('x', { closePriceCents: null, closeDate: null })).fail).toBe('no_close_price');
    expect(one(cand('x', { closePriceCents: -0 })).fail).toBe('no_close_price');
    expect(one(cand('x', { closeDate: null, isLease: true })).fail).toBe('no_close_date');
    expect(one(cand('x', { closeDate: '2026-11-29', isLease: true })).fail).toBe('after_valuation_date');
    expect(one(cand('x', { isLease: true, propertyType: 'condo' })).fail).toBe('lease');
    expect(one(cand('x', { propertyType: 'condo', sqft: null })).fail).toBe('other_property_type');
    expect(one(cand('x', { sqft: 0, sizeSource: 'Other' })).fail).toBe('no_size');
    expect(one(cand('x', { sizeSource: null })).fail).toBe('other_size_source');
    expect(one(cand('x', { sizeSource: 'LivingArea', closeDate: VALUATION_DATE })).fail).toBeNull();
    const s = subject();
    expect(one(cand('x', { addressKey: s.addressKey, status: 'active' })).fail).toBe('subject_address');
    expect(one(cand('subject-listing', { status: 'active' })).fail).toBe('subject_listing');
    expect(one(cand('x', {}, { teamListingId: 'subject-listing' })).fail).toBe('subject_listing');
    expect(one(cand('x', {}, { mlsNumber: 'S100' })).fail).toBe('subject_listing');
    expect(one(cand('x', { addressKey: s.addressKey }), none, subject({ addressKey: null })).fail).toBeNull();
    expect(one(cand('x', { addressKey: null }), none, subject({ addressKey: null })).subjectSale).toBe(false);
    expect(one(cand('x', { addressKey: s.addressKey })).subjectSale).toBe(true);
  });

  it('the look-back boundary: a sale closed exactly 24 months before is too old, a day later it is not', () => {
    const oldest = addMonths(VALUATION_DATE, -24);
    const at = one(cand('x', { closeDate: oldest, contractDate: oldest }));
    expect(at.fail).toBe('too_old');
    expect(at.defaultOk).toBe(true);
    expect(at.tierIdx).toBe(0);
    expect(one(cand('x', { closeDate: '2024-11-29', contractDate: null })).fail).toBeNull();
  });

  it('conditions, plausibility, include, defaultOk and includable', () => {
    const short = one(cand('x', { saleConditions: ['short_sale'] }));
    expect(short).toMatchObject({ fail: 'sale_condition', includable: true, included: false, defaultOk: false, conditions: ['short_sale'] });
    const both = one(cand('x', { saleConditions: ['standard', 'reo'], closePriceCents: 100 }));
    expect(both).toMatchObject({ fail: 'sale_condition', conditions: ['reo'] });
    const cheap = one(cand('x', { closePriceCents: 100 }));
    expect(cheap).toMatchObject({ fail: 'implausible_price', includable: true, defaultOk: false });
    const inc = one(cand('x', { saleConditions: ['short_sale'] }), new Set(['x']));
    expect(inc).toMatchObject({ fail: null, included: true, includable: true, defaultOk: false });
    const plain = one(cand('x'), new Set(['x']));
    expect(plain).toMatchObject({ fail: null, included: true, includable: false, defaultOk: true });
    expect(one(cand('x', { saleConditions: ['standard'] }))).toMatchObject({ fail: null, defaultOk: true, includable: false, conditions: [] });
    const leaseInc = one(cand('x', { isLease: true }), new Set(['x']));
    expect(leaseInc).toMatchObject({ fail: 'lease', included: false, includable: false, defaultOk: false, tierIdx: -1, similarFail: null });
    const oldInc = one(cand('x', { saleConditions: ['short_sale'], closeDate: '2023-01-01', contractDate: null }), new Set(['x']));
    expect(oldInc).toMatchObject({ fail: 'too_old', included: true });
  });

  it('refDate, datedByClose, distance and similarity', () => {
    const a = one(cand('x', { contractDate: '2026-08-01', closeDate: '2026-09-01' }));
    expect(a).toMatchObject({ refDate: '2026-08-01', datedByClose: false });
    const b = one(cand('x', { contractDate: null, closeDate: '2026-09-01' }));
    expect(b).toMatchObject({ refDate: '2026-09-01', datedByClose: true });
    expect(one(cand('x', { latE6: SUBJECT_LAT, lonE6: SUBJECT_LON })).distanceM).toBe(0);
    expect(one(cand('x', { sqft: 2_400 })).similarFail).toBeNull();
    expect(one(cand('x', { sqft: 1_600 })).similarFail).toBeNull();
    expect(one(cand('x', { sqft: 2_401 })).similarFail).toBe('size_not_similar');
    expect(one(cand('x', { sqft: 1_599 })).similarFail).toBe('size_not_similar');
    expect(one(cand('x', { beds: 4 })).similarFail).toBeNull();
    expect(one(cand('x', { beds: 2 })).similarFail).toBeNull();
    expect(one(cand('x', { beds: 5 })).similarFail).toBe('beds_not_similar');
    expect(one(cand('x', { beds: 1 })).similarFail).toBe('beds_not_similar');
    expect(one(cand('x', { beds: null })).similarFail).toBeNull();
    expect(one(cand('x', { beds: 5 }), none, subject({ beds: null })).similarFail).toBeNull();
    expect(one(cand('x', { yearBuilt: 2020 })).similarFail).toBeNull();
    expect(one(cand('x', { yearBuilt: 2021 })).similarFail).toBe('year_built_not_similar');
    expect(one(cand('x', { yearBuilt: 1969 })).similarFail).toBe('year_built_not_similar');
    expect(one(cand('x', { yearBuilt: null })).similarFail).toBeNull();
    expect(one(cand('x', { yearBuilt: 1969 }), none, subject({ yearBuilt: null })).similarFail).toBeNull();
    expect(one(cand('x', { sqft: 3_000, beds: 9 })).similarFail).toBe('size_not_similar');
    expect(one(cand('x', { beds: 9, yearBuilt: 1900 })).similarFail).toBe('beds_not_similar');
  });

  it('distanceForAll=false skips the distance of a sale that can never be a comp', () => {
    const c = cand('x', { status: 'active' });
    expect(screen(subject(), [c], VALUATION_DATE, R, none)[0]?.distanceM).not.toBeNull();
    expect(screen(subject(), [c], VALUATION_DATE, R, none, false)[0]?.distanceM).toBeNull();
    expect(screen(subject(), [cand('y')], VALUATION_DATE, R, none, false)[0]?.distanceM).not.toBeNull();
  });

  it('R-MLS-5: the first of an identity or team listing in canonical order is counted, the rest are duplicates', () => {
    const list = canonicalOrder([
      cand('a', { status: 'active' }),
      cand('a'),
      cand('a', { closePriceCents: 41_000_000 }),
      cand('t1', {}, { teamListingId: 'T' }),
      cand('t2', {}, { teamListingId: 'T' }),
      cand('u1', {}, { teamListingId: null }),
      cand('u2', {}, { teamListingId: null }),
    ]);
    const sc = screen(subject(), list, VALUATION_DATE, R, none);
    expect(sc.map((s) => [s.c.ref.identity, s.fail])).toEqual([
      ['a', 'not_sold'],
      ['a', null],
      ['a', 'duplicate'],
      ['t1', null],
      ['t2', 'duplicate'],
      ['u1', null],
      ['u2', null],
    ]);
    const dup = sc[2] as ReturnType<typeof screen>[number];
    expect(dup).toMatchObject({ defaultOk: false, included: false, includable: false, tierIdx: -1 });
    const inc = screen(subject(), canonicalOrder([cand('d', { saleConditions: ['reo'] }), cand('d', { saleConditions: ['reo'], closePriceCents: 1_000_000_000 })]), VALUATION_DATE, R, new Set(['d']));
    expect(inc.map((s) => [s.fail, s.included, s.includable])).toEqual([
      [null, true, true],
      ['duplicate', false, false],
    ]);
  });
});

describe('tier search', () => {
  const at = (id: string, miles: number, months: number, over = {}) =>
    cand(id, { latE6: SUBJECT_LAT + Math.round(miles * LAT_PER_MILE), subdivisionName: null, postalCode: '99009', closeDate: monthsBefore(months), contractDate: monthsBefore(months), ...over });
  const search = (cs: CmaCandidate[], s = subject(), exclude = none, include = none) => {
    const sc = screen(s, canonicalOrder(cs), VALUATION_DATE, R, include);
    return searchTier(s, sc, VALUATION_DATE, R, exclude);
  };

  it('widens tier by tier at 12 months, then every tier at 24 months', () => {
    expect(search([at('a', 0.1, 1), at('b', 0.2, 2), at('c', 0.3, 3)])).toEqual({ tierIdx: 1, lookbackMonths: 12, reached: true, skipped: [] });
    expect(search([at('a', 0.1, 1), at('b', 0.2, 2), at('c', 2, 3)])).toMatchObject({ tierIdx: 3, lookbackMonths: 12 });
    expect(search([at('a', 0.1, 1), at('b', 0.2, 2), at('c', 0.3, 13)])).toMatchObject({ tierIdx: 1, lookbackMonths: 24, reached: true });
    expect(search([at('a', 0.1, 1), at('b', 0.2, 11), at('c', 5, 3)])).toMatchObject({ tierIdx: 4, lookbackMonths: 12 });
    expect(search([at('a', 0.1, 1), at('b', 0.2, 12), at('c', 5, 3)])).toMatchObject({ tierIdx: 4, lookbackMonths: 24 });
    expect(search([at('a', 0.1, 1), at('b', 0.2, 2)])).toEqual({ tierIdx: 4, lookbackMonths: 24, reached: false, skipped: [] });
  });

  it('excluded, dissimilar and outside sales do not count; agent-added sales do', () => {
    const base = [at('a', 0.1, 1), at('b', 0.2, 2), at('c', 0.3, 3)];
    expect(search(base, subject(), new Set(['a']))).toMatchObject({ reached: false });
    expect(search([...base.slice(0, 2), at('c', 0.3, 3, { sqft: 3_000 })])).toMatchObject({ reached: false });
    expect(search([...base.slice(0, 2), at('c', 9, 3, { city: 'Elsewhere' })])).toMatchObject({ tierIdx: 4, reached: false });
    expect(search([...base.slice(0, 2), at('c', 9, 3, { sqft: 3_000, city: 'Elsewhere' })], subject(), none, new Set(['c']))).toMatchObject({ tierIdx: 1, reached: true });
  });

  it('skipped tiers, and no tier at all', () => {
    const s = subject({ latE6: null, lonE6: null, subdivisionName: null });
    expect(search([at('a', 0, 1, { postalCode: '99001' })], s)).toEqual({ tierIdx: 4, lookbackMonths: 24, reached: false, skipped: ['subdivision', 'within_1mi', 'within_3mi'] });
    const bare = subject({ latE6: null, lonE6: null, subdivisionName: null, postalCode: null, city: null });
    expect(search([at('a', 0, 1)], bare)).toMatchObject({ tierIdx: -1, reached: false });
  });

  it('withinMonths and closedAfter are exclusive at the cutoff', () => {
    const s = one(cand('x', { closeDate: '2025-11-28', contractDate: null }));
    expect(withinMonths(s, VALUATION_DATE, 12)).toBe(false);
    expect(withinMonths(s, VALUATION_DATE, 13)).toBe(true);
    expect(closedAfter(s, '2025-11-27')).toBe(true);
    expect(closedAfter(s, '2025-11-28')).toBe(false);
  });

  it('poolTierIndex widens the reached tier to at least the postal code', () => {
    const s = subject();
    expect([0, 1, 2, 3, 4, -1].map((i) => poolTierIndex(s, i))).toEqual([2, 2, 2, 3, 4, 2]);
    const noPostal = subject({ postalCode: null });
    expect([0, 1, 3].map((i) => poolTierIndex(noPostal, i))).toEqual([3, 3, 3]);
    const cityOnly = subject({ postalCode: null, latE6: null, lonE6: null });
    expect(poolTierIndex(cityOnly, 0)).toBe(4);
    const subOnly = subject({ postalCode: null, latE6: null, lonE6: null, city: null });
    expect(poolTierIndex(subOnly, 0)).toBe(0);
    expect(poolTierIndex(subject({ postalCode: null, latE6: null, lonE6: null, city: null, subdivisionName: null }), -1)).toBe(-1);
  });
});
