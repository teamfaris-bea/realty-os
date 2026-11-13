// R-MLS-7 (core part): a listing's size is finished living area, read only from a field the MLS has confirmed carries
// it. BuildingAreaTotal (and any total, unfinished or below-grade area field) is never read as size, no two area
// fields are added together, and a mapping with `sqft: null` reads no size at all (Spark until the MLS answers).
// E598, E599, E643 (the core competing-set and saved-search parts), E646 (PostalCode stored as sent). Synthetic
// RESO records only.
import { describe, expect, it } from 'vitest';
import { matchListing } from '../assistant/index.js';
import { competingSet } from './competing.js';
import { SIZE_FIELDS_NEVER_USED, normalizeMlsListing, sizeFieldOf } from './normalize.js';
import { MAPPING, RESO_FULL, lid } from './testing/fixtures.js';
import type { CompetingRule, FieldMapping, ListingFacts, ResoLike } from './types.js';

function facts(raw: ResoLike, mapping: FieldMapping = MAPPING): ListingFacts {
  const r = normalizeMlsListing(raw, mapping);
  if (Array.isArray(r)) throw new Error(`expected facts, got issues: ${JSON.stringify(r)}`);
  return r as ListingFacts;
}

/** Every area field a feed may send, each with a different value, so a read of any one (or a sum) shows. */
const AREAS = { LivingArea: 1850, BuildingAreaTotal: 2600, AboveGradeFinishedArea: 1700, BelowGradeFinishedArea: 400, AboveGradeUnfinishedArea: 300, BelowGradeUnfinishedArea: 200 };
const NO_SIZE: FieldMapping = { ...MAPPING, fields: { sqft: null } };

describe('R-MLS-7: size is finished living area only from a confirmed field', () => {
  it('R-MLS-7 E599: BuildingAreaTotal (and every other field that is never finished living area) is never read as size, whatever the mapping says', () => {
    expect(SIZE_FIELDS_NEVER_USED).toContain('BuildingAreaTotal');
    expect(Object.isFrozen(SIZE_FIELDS_NEVER_USED)).toBe(true);
    for (const field of [...SIZE_FIELDS_NEVER_USED, 'buildingareatotal', 'BUILDINGAREATOTAL']) {
      const m: FieldMapping = { ...MAPPING, fields: { sqft: field } };
      const f = facts({ ...RESO_FULL, ...AREAS }, m);
      expect([field, f.sqft, f.valuation.sizeSource]).toEqual([field, null, null]);
      expect(f.valuation.unreadable).toEqual([]); // not read, so never "unreadable" either
      expect(sizeFieldOf(m)).toBeNull();
    }
  });

  it('R-MLS-7 E598: a mapping with sqft null reads no size, LivingArea included: no field, no sum, no fallback; the record is still stored', () => {
    const f = facts({ ...RESO_FULL, ...AREAS }, NO_SIZE);
    expect(f.sqft).toBeNull();
    expect(f.valuation.sizeSource).toBeNull();
    expect(f.beds).toBe(3); // every other fact as before
    expect(f.listPriceCents).toBe(45_000_000);
    expect(sizeFieldOf(NO_SIZE)).toBeNull();
    // an unreadable LivingArea is not an issue either: it is never read
    expect(Array.isArray(normalizeMlsListing({ ...RESO_FULL, LivingArea: 'big', BuildingAreaTotal: 'huge' }, NO_SIZE))).toBe(false);
  });

  it('R-MLS-7: without a mapping the RESO default LivingArea is still the size field (the fake feed and other adapters), and only that field', () => {
    expect(sizeFieldOf(MAPPING)).toBe('LivingArea');
    const f = facts({ ...RESO_FULL, ...AREAS });
    expect([f.sqft, f.valuation.sizeSource]).toEqual([1850, 'LivingArea']);
    // no LivingArea: never another area field in its place, never a sum of above- and below-grade areas
    const g = facts({ ...RESO_FULL, ...AREAS, LivingArea: undefined });
    expect([g.sqft, g.valuation.sizeSource]).toEqual([null, null]);
    // a mapping may name a candidate field (an owner-approved, MLS-confirmed choice)
    const m: FieldMapping = { ...MAPPING, fields: { sqft: 'AboveGradeFinishedArea' } };
    expect(sizeFieldOf(m)).toBe('AboveGradeFinishedArea');
    expect(facts({ ...RESO_FULL, ...AREAS }, m)).toMatchObject({ sqft: 1700, valuation: { sizeSource: 'AboveGradeFinishedArea' } });
  });

  it('E649 R-MLS-7: a size of 0 (or one that rounds to 0) from the size field is unknown: no size, no size source, no issue, never "0 sq ft" finished area', () => {
    for (const v of [0, '0', '0.00', 0.4, '0.4']) {
      const r = normalizeMlsListing({ ...RESO_FULL, LivingArea: v }, MAPPING);
      expect(Array.isArray(r)).toBe(false);
      const f = r as ListingFacts;
      expect([v, f.sqft, f.valuation.sizeSource, f.valuation.unreadable]).toEqual([v, null, null, []]);
      expect(f.beds).toBe(3); // every other fact as before
    }
    expect(facts({ ...RESO_FULL, LivingArea: 0.5 })).toMatchObject({ sqft: 1, valuation: { sizeSource: 'LivingArea' } }); // rounds to 1: a size
  });

  it('E646: PostalCode is stored as sent (ZIP+4 or ZIP5): never normalized or inferred (VERIFY WITH MLS)', () => {
    expect(facts({ ...RESO_FULL, PostalCode: '29401-1234' }).postalCode).toBe('29401-1234');
    expect(facts({ ...RESO_FULL, PostalCode: '294011234' }).postalCode).toBe('294011234');
    expect(facts({ ...RESO_FULL, PostalCode: '29401' }).postalCode).toBe('29401');
  });
});

describe('E643 R-MLS-7: an unknown size is never invented by a size filter', () => {
  const base = facts({ ...RESO_FULL, ...AREAS }, NO_SIZE);
  const subject = { ...base, id: lid(1), listingKey: 'subject', mlsNumber: 'S1' } as ListingFacts;
  const candidate = (n: number, sqft: number | null): ListingFacts => ({ ...base, id: lid(100 + n), listingKey: `c${n}`, mlsNumber: `C${n}`, sqft, displayAllowed: true });
  const rule: CompetingRule = { area: 'city_or_postal_code', priceBandPct: null, bedsDelta: null, sqftBandPct: 20, samePropertyType: false, statuses: ['active'], maxCount: 10, onlyDisplayAllowed: false, mlsFeedStale: false };

  it('E643 R-MLS-7: a size band with an unknown subject size matches nothing; a candidate of unknown size never passes it; without a band, sizes are not read', () => {
    expect(competingSet(subject, [candidate(1, 1800), candidate(2, null)], rule).listings).toEqual([]);
    const sized = { ...subject, sqft: 1800 };
    const r = competingSet(sized, [candidate(1, 1800), candidate(2, null)], rule);
    expect(r.listings.map((l) => l.mlsNumber)).toEqual(['C1']);
    expect(r.why.filter((w) => w.criterion === 'sqft_band').map((w) => w.detail)).toEqual(['1800 sq ft is within ±20 % of 1800 sq ft']);
    expect(competingSet(subject, [candidate(2, null)], { ...rule, sqftBandPct: null }).listings.map((l) => l.mlsNumber)).toEqual(['C2']);
  });

  it('E649 R-MLS-7: a size of 0 is no size for a size band and a saved-search criterion (never "within ±20 % of 0 sq ft", never "at most 1,500 sq ft")', () => {
    const zero = { ...subject, sqft: 0 };
    expect(competingSet(zero, [candidate(1, 0), candidate(2, 1800)], rule).listings).toEqual([]);
    expect(competingSet({ ...subject, sqft: 1800 }, [candidate(1, 0)], rule).listings).toEqual([]);
    const l = { source: 'team' as const, status: 'active' as const, postalCode: '29401', city: 'Charleston', region: 'SC', listPriceCents: 40_000_000, beds: 3, bathsX10: 20, sqft: 0, propertyType: 'single_family' as const, description: null };
    expect(matchListing({ postalCodes: ['29401'] }, l)).toBe(true);
    expect(matchListing({ postalCodes: ['29401'], sqftMax: 1_500 }, l)).toBe(false);
    expect(matchListing({ postalCodes: ['29401'], sqftMin: 0 }, l)).toBe(false);
  });

  it('E643 R-MLS-7: a saved-search size criterion never matches a listing of unknown size', () => {
    const l = { source: 'team' as const, status: 'active' as const, postalCode: '29401', city: 'Charleston', region: 'SC', listPriceCents: 40_000_000, beds: 3, bathsX10: 20, sqft: null, propertyType: 'single_family' as const, description: null };
    expect(matchListing({ postalCodes: ['29401'] }, l)).toBe(true);
    expect(matchListing({ postalCodes: ['29401'], sqftMin: 1 }, l)).toBe(false);
    expect(matchListing({ postalCodes: ['29401'], sqftMax: 100_000 }, l)).toBe(false);
  });
});
