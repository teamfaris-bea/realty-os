import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPETING_RULE, competingSet, dedupeMirrors, listingIdentity } from './competing.js';
import { lid, mls, team } from './testing/fixtures.js';
import type { CompetingRule, ListingFacts } from './types.js';

const subject = team({ id: lid(100), mlsNumber: 'T100', listPriceCents: 50_000_000, beds: 3 });
const rule: CompetingRule = DEFAULT_COMPETING_RULE;

/** A varied candidate pool: in and out of area, band, beds, status; mirrors; ties. */
function pool(): ListingFacts[] {
  return [
    mls({ id: lid(1), mlsNumber: 'M1', listPriceCents: 51_000_000, beds: 3 }),
    mls({ id: lid(2), mlsNumber: 'M2', listPriceCents: 49_000_000, beds: 3 }), // same distance as M1: id tiebreak
    mls({ id: lid(3), mlsNumber: 'M3', listPriceCents: 54_000_000, beds: 4, status: 'pending' }),
    mls({ id: lid(4), mlsNumber: 'M4', listPriceCents: 60_000_000, beds: 3 }), // outside ±10 %
    mls({ id: lid(5), mlsNumber: 'M5', listPriceCents: 50_000_000, beds: 5 }), // beds outside ±1
    mls({ id: lid(6), mlsNumber: 'M6', listPriceCents: 50_000_000, beds: 3, status: 'sold' }),
    mls({ id: lid(7), mlsNumber: 'M7', listPriceCents: 50_500_000, beds: 2, city: 'Dallas', postalCode: '75201' }), // other area
    mls({ id: lid(8), mlsNumber: 'M8', listPriceCents: 50_000_000, beds: 3, teamListingId: lid(100) }), // mirror of the subject
    mls({ id: lid(9), mlsNumber: 'T100', listPriceCents: 50_000_000, beds: 3 }), // same MLS number as the subject
    mls({ id: lid(10), mlsNumber: 'M10', listPriceCents: 50_200_000, beds: 2, displayAllowed: false }),
    team({ id: lid(11), mlsNumber: 'T11', listPriceCents: 52_000_000, beds: 3 }),
    mls({ id: lid(12), mlsNumber: 'M12', listPriceCents: 52_000_000, beds: 3, teamListingId: lid(11), status: 'pending' }), // mirror of T11
    mls({ id: lid(13), mlsNumber: 'M13', listPriceCents: null, beds: 3 }),
    subject,
  ];
}

describe('competingSet', () => {
  it('R-MLS-5: the subject, its mirrors and mirrored duplicates are excluded; order is by price distance, beds distance, status, id', () => {
    const { listings, why } = competingSet(subject, pool(), rule);
    expect(listings.map((l) => l.mlsNumber)).toEqual(['M10', 'M1', 'M2', 'T11', 'M3']);
    // the team row is authoritative for T11 (its mls mirror M12 is not counted)
    expect(listings.find((l) => l.mlsNumber === 'T11')?.source).toBe('team');
    expect(why.filter((w) => w.listing === listingIdentity(listings[0] as ListingFacts)).map((w) => w.criterion)).toEqual(['area', 'price_band', 'beds', 'status']);
    expect(why).toHaveLength(listings.length * 4);
    expect(why.find((w) => w.criterion === 'price_band')?.detail).toMatch(/±10 %/);
  });

  it('competing order is deterministic: shuffling the candidates gives the same output', () => {
    const base = competingSet(subject, pool(), rule);
    fc.assert(
      fc.property(fc.shuffledSubarray(pool(), { minLength: pool().length }), (shuffled) => {
        expect(competingSet(subject, shuffled, rule)).toEqual(base);
      }),
    );
  });

  it('R-MLS-2: a client-facing competing set drops listings whose broker opted out of internet display', () => {
    const { listings } = competingSet(subject, pool(), { ...rule, onlyDisplayAllowed: true });
    expect(listings.map((l) => l.mlsNumber)).toEqual(['M1', 'M2', 'T11', 'M3']);
  });

  it('R-MLS-3: with a stale MLS feed, MLS candidates pause and only team listings remain', () => {
    const { listings } = competingSet(subject, pool(), { ...rule, mlsFeedStale: true });
    expect(listings.map((l) => l.mlsNumber)).toEqual(['T11']);
  });

  it('maxCount caps the set; area, beds, price and property type rules are honoured', () => {
    expect(competingSet(subject, pool(), { ...rule, maxCount: 2 }).listings.map((l) => l.mlsNumber)).toEqual(['M10', 'M1']);
    expect(competingSet(subject, pool(), { ...rule, maxCount: 0 }).listings).toEqual([]);
    const anyPrice = competingSet(subject, pool(), { ...rule, priceBandPct: null, bedsDelta: null, area: 'postal_code' });
    expect(anyPrice.listings.map((l) => l.mlsNumber)).toEqual(['M5', 'M10', 'M1', 'M2', 'T11', 'M3', 'M4', 'M13']);
    expect(anyPrice.why.some((w) => w.criterion === 'price_band' || w.criterion === 'beds')).toBe(false);
    const dallas = competingSet(subject, pool(), { ...rule, area: 'city' });
    expect(dallas.listings.some((l) => l.city === 'Dallas')).toBe(false);
    const either = competingSet(team({ ...subject, city: 'Dallas', postalCode: '78701' }), pool(), { ...rule, area: 'city_or_postal_code', priceBandPct: null, bedsDelta: null });
    expect(either.listings.map((l) => l.mlsNumber)).toContain('M7');
    const condo = competingSet({ ...subject, propertyType: 'condo' }, pool(), { ...rule, samePropertyType: true });
    expect(condo.listings).toEqual([]);
    const sameType = competingSet(subject, pool(), { ...rule, samePropertyType: true });
    expect(sameType.why.filter((w) => w.criterion === 'property_type')).toHaveLength(sameType.listings.length);
  });

  it('a subject without price or beds matches nothing on that criterion', () => {
    expect(competingSet({ ...subject, listPriceCents: null }, pool(), rule).listings).toEqual([]);
    expect(competingSet({ ...subject, beds: null }, pool(), rule).listings).toEqual([]);
    expect(competingSet({ ...subject, propertyType: null }, pool(), { ...rule, samePropertyType: true }).listings).toEqual([]);
  });

  it('an mls subject excludes the team listing it mirrors and other mirrors of it', () => {
    const mirrorSubject = mls({ id: lid(50), mlsNumber: 'M50', listPriceCents: 52_000_000, beds: 3, teamListingId: lid(11) });
    const { listings } = competingSet(mirrorSubject, pool(), { ...rule, priceBandPct: null, bedsDelta: null });
    expect(listings.map((l) => l.mlsNumber)).not.toContain('T11');
    expect(listings.map((l) => l.mlsNumber)).not.toContain('M12');
  });

  it('listings without stored ids are identified by source, connection and MLS number', () => {
    const a = mls({ id: null, mlsNumber: 'MA', listPriceCents: 50_000_000 });
    const b = mls({ id: null, mlsNumber: 'MB', listPriceCents: 50_000_000 });
    expect(listingIdentity(a)).not.toBe(listingIdentity(b));
    expect(competingSet(subject, [b, a], rule).listings.map((l) => l.mlsNumber)).toEqual(['MA', 'MB']);
    expect(competingSet({ ...a }, [a, b], rule).listings.map((l) => l.mlsNumber)).toEqual(['MB']);
    const keyOnly = mls({ id: null, mlsNumber: null, listingKey: 'kk', mlsConnectionId: null });
    expect(listingIdentity(keyOnly)).toBe('mls::kk');
    expect(listingIdentity(team({ id: null, mlsNumber: null }))).toBe('team::');
  });
});

describe('dedupeMirrors', () => {
  it('R-MLS-5 E81: a mirrored team listing is counted once, the team row is authoritative, and a status mismatch is reported', () => {
    const own = team({ id: lid(11), status: 'active' });
    const mirror = mls({ id: lid(12), teamListingId: lid(11), status: 'pending' });
    const other = mls({ id: lid(13) });
    const r = dedupeMirrors([mirror, other, own]);
    expect(r.listings).toEqual([other, own]);
    expect(r.mismatches).toEqual([{ teamListingId: lid(11), mlsListing: listingIdentity(mirror), teamStatus: 'active', mlsStatus: 'pending' }]);
  });

  it('R-MLS-5 E81: an agreeing mirror reports no mismatch; a mirror whose team row is absent stays; two mirrors of one team listing count once', () => {
    const own = team({ id: lid(11) });
    expect(dedupeMirrors([own, mls({ id: lid(12), teamListingId: lid(11) })])).toEqual({ listings: [own], mismatches: [] });
    const lone = mls({ id: lid(12), teamListingId: lid(99) });
    const lone2 = mls({ id: lid(14), teamListingId: lid(99) });
    expect(dedupeMirrors([lone2, lone])).toEqual({ listings: [lone], mismatches: [] });
    expect(dedupeMirrors([lone, lone2])).toEqual({ listings: [lone], mismatches: [] });
  });
});
