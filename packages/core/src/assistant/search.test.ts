import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sequentialIds } from '../foundation/index.js';
import { normalizeClaims } from './claims.js';
import { sourceIndex } from './evidence.js';
import { type ListingFacts, SEARCH_ALERT, type SearchCriteria, SearchCriteriaSchema, applySearchReview, hasCriteria, matchListing, parseCriterion, proposeSearch } from './search.js';
import { ALL_SOURCES, GOOD_OUTPUT, LA } from './testing/fixtures.js';
import type { Claim } from './types.js';

const claim = (id: string, key: string, value: unknown, needsReview = false): Claim => ({
  id: id as Claim['id'],
  ordinal: 0,
  kind: 'preference',
  text: key,
  structured: { criterion: { key, value } },
  evidence: [],
  needsReview,
  reviewReasons: needsReview ? ['QUOTE_NOT_VERIFIED'] : [],
});

const listing = (o: Partial<ListingFacts> = {}): ListingFacts => ({
  source: 'team',
  status: 'active',
  postalCode: '78701',
  city: 'Austin',
  region: 'TX',
  listPriceCents: 43_900_000,
  beds: 3,
  bathsX10: 20,
  sqft: 1800,
  propertyType: 'single_family',
  description: 'Big backyard, new roof, close to the park.',
  ...o,
});

describe('parseCriterion', () => {
  it('maps model keys and units to stored criteria and rejects invalid values', () => {
    expect(parseCriterion('price_max', 450000)).toEqual({ ok: true, key: 'priceMaxCents', value: 45_000_000 });
    expect(parseCriterion('price_min', '$350k')).toEqual({ ok: true, key: 'priceMinCents', value: 35_000_000 });
    expect(parseCriterion('baths_min', 2.5)).toEqual({ ok: true, key: 'bathsMinX10', value: 25 });
    expect(parseCriterion('beds_min', '3')).toEqual({ ok: true, key: 'bedsMin', value: 3 });
    expect(parseCriterion('zip', '78701-1234')).toEqual({ ok: true, key: 'postalCodes', value: ['78701'] });
    expect(parseCriterion('city', 'Austin, tx')).toEqual({ ok: true, key: 'cities', value: [{ city: 'Austin', region: 'TX' }] });
    expect(parseCriterion('cities', ['Round Rock'])).toEqual({ ok: true, key: 'cities', value: [{ city: 'Round Rock' }] });
    expect(parseCriterion('property_type', ['Townhome', 'condo'])).toEqual({ ok: true, key: 'propertyTypes', value: ['townhouse', 'condo'] });
    expect(parseCriterion('keywords', 'backyard')).toEqual({ ok: true, key: 'keywords', value: ['backyard'] });
    expect(parseCriterion('sqftMin', 1500)).toEqual({ ok: true, key: 'sqftMin', value: 1500 });
    // stored keys are already in stored units: never converted twice
    expect(parseCriterion('priceMaxCents', 45_000_000)).toEqual({ ok: true, key: 'priceMaxCents', value: 45_000_000 });
    expect(parseCriterion('bathsMinX10', 25)).toEqual({ ok: true, key: 'bathsMinX10', value: 25 });
    expect(parseCriterion('priceMaxCents', '450000')).toEqual({ ok: false });
    expect(parseCriterion('price_max', 'lots')).toEqual({ ok: false });
    expect(parseCriterion('baths_min', 'many')).toEqual({ ok: false });
    expect(parseCriterion('property_type', 'castle')).toEqual({ ok: false });
    expect(parseCriterion('school_rating', 9)).toEqual({ ok: false });
    expect(parseCriterion('beds_min', -1)).toEqual({ ok: false });
    expect(parseCriterion('cities', [{ city: 'Austin', region: 'Texas' }])).toEqual({ ok: false });
  });
});

describe('proposeSearch (R-AST-5, A4)', () => {
  it('R-AST-5 a call extraction becomes criteria with per-criterion claim evidence', () => {
    const claims = normalizeClaims(GOOD_OUTPUT, sourceIndex(ALL_SOURCES), { contactZone: LA, ids: sequentialIds() });
    const p = proposeSearch(claims);
    expect(p.criteria).toEqual({ priceMaxCents: 45_000_000, postalCodes: ['78701', '78702'], bedsMin: 3 });
    expect(p.criterionEvidence).toEqual({ priceMaxCents: claims[1]!.id, postalCodes: claims[2]!.id, bedsMin: claims[3]!.id });
    expect(p.unchecked).toEqual([]);
    expect(p.prefill).toEqual({});
  });

  it('R-AST-5 needs-review criteria are prefilled but unchecked, and never in the stored criteria', () => {
    const p = proposeSearch([claim('c1', 'price_max', 450000), claim('c2', 'beds_min', 4, true)]);
    expect(p.criteria).toEqual({ priceMaxCents: 45_000_000 });
    expect(p.unchecked).toEqual(['bedsMin']);
    expect(p.prefill).toEqual({ bedsMin: 4 });
    expect(p.criterionEvidence).toEqual({ priceMaxCents: 'c1', bedsMin: 'c2' });
  });

  it('R-AST-5 property: no value from a needs-review claim is ever in the stored criteria', () => {
    const entry = fc.oneof(
      fc.record({ key: fc.constant('price_max'), value: fc.integer({ min: 100_000, max: 900_000 }) }),
      fc.record({ key: fc.constant('beds_min'), value: fc.integer({ min: 1, max: 6 }) }),
      fc.record({ key: fc.constant('postal_codes'), value: fc.constantFrom('78701', '78702', '78703') }),
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(entry, fc.boolean()), { maxLength: 6 }), (xs) => {
        const claims = xs.map(([e, nr], k) => claim(`c${k}`, e.key, e.value, nr));
        const p = proposeSearch(claims);
        const reviewKeys = new Set(claims.filter((c) => c.needsReview).map((c) => parseCriterion(c.structured!.criterion!.key, c.structured!.criterion!.value)).flatMap((r) => (r.ok ? [r.key] : [])));
        for (const k of reviewKeys) expect(p.criteria[k]).toBeUndefined();
        expect(SearchCriteriaSchema.safeParse(p.criteria).success).toBe(true);
      }),
    );
  });

  it('conflicting scalar values are unchecked; list values merge; invalid criteria are ignored', () => {
    const p = proposeSearch([claim('a', 'price_max', 400000), claim('b', 'price_max', 450000), claim('c', 'zip', '78701'), claim('d', 'zip', ['78702', '78701']), claim('e', 'price_max', 'lots')]);
    expect(p.criteria).toEqual({ postalCodes: ['78701', '78702'] });
    expect(p.unchecked).toEqual(['priceMaxCents']);
    expect(p.prefill).toEqual({ priceMaxCents: 45_000_000 });
    const same = proposeSearch([claim('a', 'beds_min', 3), claim('b', 'beds_min', 3)]);
    expect(same).toMatchObject({ criteria: { bedsMin: 3 }, unchecked: [] });
    expect(proposeSearch([{ ...claim('x', 'beds_min', 3), structured: {} }]).criteria).toEqual({});
  });

  it('a min > max conflict between trustworthy claims stores neither side', () => {
    const p = proposeSearch([claim('a', 'price_min', 500000), claim('b', 'price_max', 400000)]);
    expect(p.criteria).toEqual({});
    expect(p.unchecked).toEqual(['priceMinCents', 'priceMaxCents']);
  });
});

describe('applySearchReview (R-AST-10 approval content)', () => {
  it('stores trustworthy criteria + the unchecked ones the agent checked + edits', () => {
    const p = proposeSearch([claim('c1', 'price_max', 450000), claim('c2', 'beds_min', 4, true), claim('c3', 'zip', '78701', true)]);
    expect(applySearchReview(p, { checked: [] })).toEqual({ priceMaxCents: 45_000_000 });
    expect(applySearchReview(p, { checked: ['bedsMin'] })).toEqual({ priceMaxCents: 45_000_000, bedsMin: 4 });
    expect(applySearchReview(p, { checked: ['bedsMin'], removed: ['priceMaxCents'], edits: { postalCodes: ['78704'] } })).toEqual({ bedsMin: 4, postalCodes: ['78704'] });
    expect(applySearchReview(p, { checked: [], edits: { priceMinCents: 50_000_000 } })).toBeNull(); // min > max
    expect(applySearchReview(p, { checked: [], edits: { priceMaxCents: undefined } })).toEqual({});
  });
});

describe('matchListing (R-AST-10)', () => {
  const c: SearchCriteria = { postalCodes: ['78701'], priceMaxCents: 45_000_000, bedsMin: 3 };
  it('R-AST-10 matches active/coming-soon team listings that meet every criterion', () => {
    expect(matchListing(c, listing())).toBe(true);
    expect(matchListing(c, listing({ status: 'coming_soon' }))).toBe(true);
  });

  it.each([
    ['an MLS (competing) listing: Phase 1 uses team listings only', { source: 'mls' as const }],
    ['pending', { status: 'pending' as const }],
    ['sold', { status: 'sold' as const }],
    ['wrong zip', { postalCode: '78702' }],
    ['over budget', { listPriceCents: 45_000_001 }],
    ['no price', { listPriceCents: null }],
    ['too few beds', { beds: 2 }],
    ['unknown beds', { beds: null }],
  ])('R-AST-10 does not match %s', (_n, o) => {
    expect(matchListing(c, listing(o))).toBe(false);
  });

  it('cities (with optional region), types, sqft, baths and keywords', () => {
    expect(matchListing({ cities: [{ city: 'austin', region: 'TX' }] }, listing({ postalCode: '99999' }))).toBe(true);
    expect(matchListing({ cities: [{ city: 'Austin', region: 'CA' }] }, listing())).toBe(false);
    expect(matchListing({ cities: [{ city: 'Austin' }], postalCodes: ['00000'] }, listing())).toBe(true);
    expect(matchListing({ propertyTypes: ['condo'] }, listing())).toBe(false);
    expect(matchListing({ propertyTypes: ['condo'] }, listing({ propertyType: null }))).toBe(false);
    expect(matchListing({ propertyTypes: ['single_family'] }, listing())).toBe(true);
    expect(matchListing({ sqftMin: 1500, sqftMax: 2000 }, listing())).toBe(true);
    expect(matchListing({ sqftMax: 1700 }, listing())).toBe(false);
    expect(matchListing({ bathsMinX10: 25 }, listing())).toBe(false);
    expect(matchListing({ priceMinCents: 40_000_000 }, listing())).toBe(true);
    expect(matchListing({ keywords: ['big backyard', 'roof'] }, listing())).toBe(true);
    expect(matchListing({ keywords: ['pool'] }, listing())).toBe(false);
    expect(matchListing({ keywords: ['yard'] }, listing({ description: null }))).toBe(false);
    expect(matchListing({ keywords: ['back'] }, listing())).toBe(false); // whole words only
  });

  it('empty criteria match nothing (never alert on every listing)', () => {
    expect(hasCriteria({})).toBe(false);
    expect(matchListing({}, listing())).toBe(false);
  });

  it('R-AST-10 alerts are search_alert / marketing', () => {
    expect(SEARCH_ALERT).toEqual({ category: 'search_alert', purpose: 'marketing' });
  });
});

describe('search edge cases', () => {
  it('rejects non-numeric values and inverted sqft ranges; a checked key with no prefill is ignored', () => {
    expect(parseCriterion('price_max', true)).toEqual({ ok: false });
    expect(parseCriterion('sqft_min', '1,500')).toEqual({ ok: true, key: 'sqftMin', value: 1500 });
    expect(parseCriterion('beds_min', null)).toEqual({ ok: false });
    expect(applySearchReview({ criteria: { sqftMin: 2000 }, prefill: {} }, { checked: ['bedsMin'], edits: { sqftMax: 1000 } })).toBeNull();
    expect(applySearchReview({ criteria: { bedsMin: 3 }, prefill: {} }, { checked: ['priceMaxCents'] })).toEqual({ bedsMin: 3 });
  });
});
