// R-CMA-1: MLS sale and property facts, read from the feed without ever blocking a record (lane V1-A).
// Synthetic RESO records only. E360, E361, E362, E363 (the core parts); F3 column bounds.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { INTEGER_MAX, SMALLINT_MAX, calendarDate, microdegrees, normalizeMlsListing, yesNo } from './normalize.js';
import { MAPPING, RESO_FULL } from './testing/fixtures.js';
import type { FieldMapping, Issue, ListingFacts, ResoLike, ValuationFacts } from './types.js';

function facts(raw: ResoLike, mapping: FieldMapping = MAPPING): ListingFacts {
  const r = normalizeMlsListing(raw, mapping);
  if (Array.isArray(r)) throw new Error(`expected facts, got issues: ${JSON.stringify(r)}`);
  return r as ListingFacts;
}
const v = (o: Record<string, unknown>, mapping: FieldMapping = MAPPING): ValuationFacts => facts({ ...RESO_FULL, ...o }, mapping).valuation;

/** A closed sale with every new field, as a RESO feed sends it (synthetic). */
const CLOSED: Record<string, unknown> = {
  StandardStatus: 'Closed',
  ClosePrice: '441,500.00',
  CloseDate: '2026-09-30',
  PurchaseContractDate: '2026-09-02',
  OriginalListPrice: 459000,
  ConcessionsAmount: '7500',
  SpecialListingConditions: ['Standard'],
  DaysOnMarket: 21,
  Latitude: 32.7765123,
  Longitude: '-79.9310456',
  YearBuilt: 1998,
  LotSizeSquareFeet: 8712,
  LotSizeAcres: 0.2,
  SubdivisionName: 'Harbor Pointe',
  GarageSpaces: 2,
  PoolPrivateYN: 'N',
  Stories: '2',
  InternetAutomatedValuationDisplayYN: 'Y',
};

describe('R-CMA-1: sale and property facts from the feed', () => {
  it('R-CMA-1: a closed sale stores every new field, typed and bounded', () => {
    const f = facts({ ...RESO_FULL, ...CLOSED });
    expect(f.status).toBe('sold');
    expect(f.valuation).toEqual({
      closePriceCents: 44_150_000,
      closeDate: '2026-09-30',
      contractDate: '2026-09-02',
      originalListPriceCents: 45_900_000,
      concessionsCents: 750_000,
      saleConditions: ['standard'],
      daysOnMarket: 21,
      latitudeE6: 32_776_512,
      longitudeE6: -79_931_046,
      yearBuilt: 1998,
      lotSqft: 8712,
      subdivisionName: 'Harbor Pointe',
      garageSpacesX10: 20,
      poolPrivate: false,
      storiesX10: 20,
      sizeSource: 'LivingArea',
      isLease: false,
      avmDisplayAllowed: true,
      unreadable: [],
    });
  });

  it('R-CMA-1: one fixture per field (absent ⇒ null and not unreadable)', () => {
    const none = v({});
    expect(none.unreadable).toEqual([]);
    const cases: [Record<string, unknown>, Partial<ValuationFacts>][] = [
      [{ ClosePrice: 300000 }, { closePriceCents: 30_000_000 }],
      [{ CloseDate: '2026-01-05T00:00:00Z' }, { closeDate: '2026-01-05' }],
      [{ PurchaseContractDate: '2025-12-20' }, { contractDate: '2025-12-20' }],
      [{ OriginalListPrice: '$315,000' }, { originalListPriceCents: 31_500_000 }],
      [{ ConcessionsAmount: 0 }, { concessionsCents: 0 }],
      [{ SpecialListingConditions: 'Short Sale, Probate Listing' }, { saleConditions: ['short_sale', 'probate'] }],
      [{ SpecialListingConditions: ['Real Estate Owned', 'Auction', 'Relocation'] }, { saleConditions: ['reo', 'auction', 'other'] }],
      [{ DaysOnMarket: '0' }, { daysOnMarket: 0 }],
      [{ Latitude: '-33.8688', Longitude: 151.2093 }, { latitudeE6: -33_868_800, longitudeE6: 151_209_300 }],
      [{ YearBuilt: '1925' }, { yearBuilt: 1925 }],
      [{ LotSizeSquareFeet: '5000.4' }, { lotSqft: 5000 }],
      [{ SubdivisionName: ' Oak Run ' }, { subdivisionName: 'Oak Run' }],
      [{ GarageSpaces: 2.5 }, { garageSpacesX10: 25 }],
      [{ PoolPrivateYN: true }, { poolPrivate: true }],
      [{ Stories: 3 }, { storiesX10: 30 }],
      [{ InternetAutomatedValuationDisplayYN: 'yes' }, { avmDisplayAllowed: true }],
      [{ PropertyType: 'Residential Lease' }, { isLease: true }],
    ];
    for (const [input, want] of cases) expect(v(input), JSON.stringify(input)).toMatchObject({ ...want, unreadable: [] });
  });

  it('R-CMA-1: InternetAutomatedValuationDisplayYN is true only for an explicit yes; PoolPrivateYN is tri-state', () => {
    for (const x of [undefined, null, '', 'N', false, 'maybe', 0]) expect(v({ InternetAutomatedValuationDisplayYN: x }).avmDisplayAllowed).toBe(false);
    expect([yesNo('Y'), yesNo('no'), yesNo('False'), yesNo(0), yesNo('?'), yesNo(null), yesNo(1)]).toEqual([true, false, false, false, null, null, true]);
    expect(v({ PoolPrivateYN: 'perhaps' })).toMatchObject({ poolPrivate: null, unreadable: ['PoolPrivateYN'] });
  });

  it('R-CMA-1: a mapping can point a field elsewhere and extend the vocabularies', () => {
    // the size field may be pointed at another field (an MLS-confirmed choice), never at a field of SIZE_FIELDS_NEVER_USED (R-MLS-7, size.test.ts)
    const m: FieldMapping = { ...MAPPING, fields: { sqft: 'AboveGradeFinishedArea', stories: 'StoriesTotal' }, saleConditionMap: { 'HUD Owned': 'reo' }, leasePropertyTypes: ['Rental'], subdivisionPlaceholders: ['No HOA'] };
    const f = facts({ ...RESO_FULL, LivingArea: undefined, AboveGradeFinishedArea: 2100, StoriesTotal: 1.5, SpecialListingConditions: 'HUD Owned', PropertyType: 'Rental', SubdivisionName: 'NO HOA' }, m);
    expect(f.sqft).toBe(2100);
    expect(f.valuation).toMatchObject({ sizeSource: 'AboveGradeFinishedArea', storiesX10: 15, saleConditions: ['reo'], isLease: true, subdivisionName: null });
    expect(facts({ ...RESO_FULL, LivingArea: null }).valuation.sizeSource).toBeNull();
  });
});

describe('E360: leases are never sales (the core part)', () => {
  it('E360 R-CMA-1: a closed Residential Lease is stored with isLease (its "close price" is a rent)', () => {
    const f = facts({ ...RESO_FULL, ...CLOSED, PropertyType: 'Residential Lease', PropertySubType: 'Single Family Residence', ClosePrice: '2,400.00' });
    expect([f.status, f.propertyType, f.valuation.isLease, f.valuation.closePriceCents]).toEqual(['sold', 'single_family', true, 240_000]);
    expect(v({ PropertyType: 'COMMERCIAL_LEASE' }).isLease).toBe(true);
    expect(v({ PropertyType: 'Residential' }).isLease).toBe(false);
    expect(v({ PropertyType: 'Residential Income' }).isLease).toBe(false);
  });
});

describe('E361: coordinates, year built, stories and calendar dates', () => {
  it('E361 R-CMA-1: "-80.1234567" text and the number −80.1234567 both store −80123457 µ°', () => {
    expect(v({ Latitude: '32.5', Longitude: '-80.1234567' }).longitudeE6).toBe(-80_123_457);
    expect(v({ Latitude: 32.5, Longitude: -80.1234567 }).longitudeE6).toBe(-80_123_457);
    expect([microdegrees('-0.0000005', 90e6), microdegrees('0.0000004', 90e6), microdegrees(1e-7, 90e6), microdegrees('+12', 90e6)]).toEqual([-1, 0, 0, 12_000_000]);
    expect([microdegrees('1e3', 90e6), microdegrees('12.', 90e6), microdegrees(Number.NaN, 90e6), microdegrees('90.0000006', 90e6), microdegrees('-180', 180e6)]).toEqual([null, null, null, null, -180_000_000]);
  });

  it('E361 R-CMA-1: latitude 95 nulls both coordinates; (0,0) is null; a lone coordinate is null; each is named unreadable', () => {
    expect(v({ Latitude: 95, Longitude: -80 })).toMatchObject({ latitudeE6: null, longitudeE6: null, unreadable: ['Latitude', 'Longitude'] });
    expect(v({ Latitude: 0, Longitude: '0.0' })).toMatchObject({ latitudeE6: null, longitudeE6: null, unreadable: ['Latitude', 'Longitude'] });
    expect(v({ Latitude: 32.1 })).toMatchObject({ latitudeE6: null, longitudeE6: null, unreadable: ['Latitude'] });
    expect(v({ Latitude: 0, Longitude: -80 })).toMatchObject({ latitudeE6: 0, longitudeE6: -80_000_000, unreadable: [] }); // the equator is a place
  });

  it('E361 R-CMA-1: YearBuilt 0 is null and unreadable; Stories "1.5" is 15 tenths; CloseDate "2024-02-30" is null and unreadable; the record is stored', () => {
    const f = facts({ ...RESO_FULL, ...CLOSED, YearBuilt: 0, Stories: '1.5', CloseDate: '2024-02-30' });
    expect(f.valuation).toMatchObject({ yearBuilt: null, storiesX10: 15, closeDate: null });
    expect([...f.valuation.unreadable].sort()).toEqual(['CloseDate', 'YearBuilt']);
    expect(f.mlsNumber).toBe('MLS1001');
  });

  it('E361: dates must round-trip as real calendar dates; list_date gets the same fix', () => {
    expect(['2024-02-29', '2023-02-29', '2024-02-30', '2026-13-01', '2026-04-31', '0000-01-01', '2026-1-01', '2026-06-15T10:00:00Z', '1900-02-29', '2000-02-29'].map(calendarDate)).toEqual(['2024-02-29', null, null, null, null, null, null, '2026-06-15', null, '2000-02-29']);
    expect(calendarDate(20260101)).toBeNull();
    const f = facts({ ...RESO_FULL, ListingContractDate: '2024-02-30' });
    expect([f.listDate, f.valuation.unreadable]).toEqual([null, ['ListingContractDate']]);
  });
});

describe('E362: lot size and subdivision placeholders', () => {
  it('E362 R-CMA-1: acres only; square metres via LotSizeArea and LotSizeUnits; square feet via LotSizeArea', () => {
    expect(v({ LotSizeAcres: '0.25' }).lotSqft).toBe(10_890);
    expect(v({ LotSizeArea: 1000, LotSizeUnits: 'Square Meters' }).lotSqft).toBe(10_764);
    expect(v({ LotSizeArea: '6000', LotSizeUnits: 'Square Feet' }).lotSqft).toBe(6000);
    expect(v({ LotSizeArea: 1.5, LotSizeUnits: 'Acres' }).lotSqft).toBe(65_340);
    expect(v({ LotSizeArea: 1.5 })).toMatchObject({ lotSqft: null, unreadable: ['LotSizeArea'] });
    expect(v({ LotSizeArea: 1.5, LotSizeUnits: 'Hectares' })).toMatchObject({ lotSqft: null, unreadable: ['LotSizeArea'] });
  });

  it('E362 R-CMA-1: fields that disagree by more than 1 %: the square-feet value wins and the others are unreadable; agreeing ones are fine', () => {
    expect(v({ LotSizeSquareFeet: 8712, LotSizeAcres: 0.2 })).toMatchObject({ lotSqft: 8712, unreadable: [] }); // 0.2 ac = 8,712 sq ft
    expect(v({ LotSizeSquareFeet: 8712, LotSizeAcres: 2, LotSizeArea: 8000, LotSizeUnits: 'Square Feet' })).toMatchObject({ lotSqft: 8712, unreadable: ['LotSizeAcres', 'LotSizeArea'] });
    expect(v({ LotSizeAcres: 1, LotSizeArea: 4046.86, LotSizeUnits: 'sqm' })).toMatchObject({ lotSqft: 43_560, unreadable: [] });
  });

  it('E362 R-CMA-1: SubdivisionName "None", "N/A", "0" and other placeholders are null (never a tier)', () => {
    for (const p of ['None', 'N/A', '0', 0, 'not in a subdivision', 'NO SUBDIVISION', 'Unknown', 'other', 'Not Applicable', '--']) expect(v({ SubdivisionName: p }).subdivisionName, String(p)).toBeNull();
    expect(v({ SubdivisionName: 'Nonesuch Farms' }).subdivisionName).toBe('Nonesuch Farms');
    expect(v({ SubdivisionName: { name: 'x' } })).toMatchObject({ subdivisionName: null, unreadable: ['SubdivisionName'] });
  });
});

describe('E363: sale facts are stored as read', () => {
  it('E363 R-CMA-1: ClosePrice on a pending record and Closed without CloseDate are stored as read', () => {
    const pending = facts({ ...RESO_FULL, StandardStatus: 'Pending', ClosePrice: 410000 });
    expect([pending.status, pending.valuation.closePriceCents]).toEqual(['pending', 41_000_000]);
    const noDate = facts({ ...RESO_FULL, StandardStatus: 'Closed', ClosePrice: 410000 });
    expect([noDate.status, noDate.valuation.closeDate, noDate.valuation.closePriceCents]).toEqual(['sold', null, 41_000_000]);
  });
});

describe('F3: column bounds (every CHECK and type bound of the S0 columns; beds, baths_x10, sqft and list_date)', () => {
  const newFields: [string, unknown, keyof ValuationFacts][] = [
    ['ClosePrice', -1, 'closePriceCents'],
    ['ClosePrice', '1.234', 'closePriceCents'],
    ['ClosePrice', 1e300, 'closePriceCents'],
    ['OriginalListPrice', '-5', 'originalListPriceCents'],
    ['ConcessionsAmount', 'n/a', 'concessionsCents'],
    ['DaysOnMarket', -3, 'daysOnMarket'],
    ['DaysOnMarket', 2.5, 'daysOnMarket'],
    ['DaysOnMarket', INTEGER_MAX + 1, 'daysOnMarket'],
    ['YearBuilt', 1599, 'yearBuilt'],
    ['YearBuilt', 2101, 'yearBuilt'],
    ['YearBuilt', 1999.5, 'yearBuilt'],
    ['LotSizeSquareFeet', -10, 'lotSqft'],
    ['LotSizeSquareFeet', 1e300, 'lotSqft'],
    ['GarageSpaces', SMALLINT_MAX, 'garageSpacesX10'],
    ['GarageSpaces', -1, 'garageSpacesX10'],
    ['Stories', 3276.8, 'storiesX10'],
    ['CloseDate', '2026-02-29', 'closeDate'],
    ['PurchaseContractDate', 'last week', 'contractDate'],
  ];
  it.each(newFields)('R-CMA-1: %s = %s is null and unreadable; the record is stored', (field, value, key) => {
    const f = facts({ ...RESO_FULL, ...CLOSED, [field]: value, ...(field === 'LotSizeSquareFeet' ? { LotSizeAcres: undefined } : {}) });
    expect(f.valuation[key]).toBeNull();
    expect(f.valuation.unreadable).toContain(field);
  });

  it('R-CMA-1: the largest in-bound values pass', () => {
    expect(v({ GarageSpaces: 3276.7, Stories: '0', DaysOnMarket: INTEGER_MAX, YearBuilt: 2100, LotSizeSquareFeet: Number.MAX_SAFE_INTEGER, LotSizeAcres: undefined, Latitude: -90, Longitude: 180 })).toMatchObject({
      garageSpacesX10: 32_767, storiesX10: 0, daysOnMarket: INTEGER_MAX, yearBuilt: 2100, lotSqft: Number.MAX_SAFE_INTEGER, latitudeE6: -90_000_000, longitudeE6: 180_000_000, unreadable: [],
    });
  });

  const existing: [string, unknown][] = [
    ['BedroomsTotal', SMALLINT_MAX + 1],
    ['BathroomsTotalInteger', 3276.8],
    ['LivingArea', INTEGER_MAX + 1],
  ];
  it.each(existing)('R-CMA-1: an existing column out of bound (%s = %s) is MLS_FIELD_INVALID, as an invalid count is today', (field, value) => {
    const r = normalizeMlsListing({ ...RESO_FULL, [field]: value }, MAPPING) as Issue[];
    expect(Array.isArray(r)).toBe(true);
    expect(r).toEqual([expect.objectContaining({ code: 'MLS_FIELD_INVALID', field })]);
  });
  it('R-CMA-1: the largest in-bound existing values pass', () => {
    const f = facts({ ...RESO_FULL, BedroomsTotal: SMALLINT_MAX, BathroomsTotalInteger: 3276.7, LivingArea: INTEGER_MAX });
    expect([f.beds, f.bathsX10, f.sqft]).toEqual([SMALLINT_MAX, SMALLINT_MAX, INTEGER_MAX]);
  });
});

describe('R-CMA-1: normalize never throws and never yields a value from an unreadable input (property)', () => {
  const junk = fc.oneof(fc.string(), fc.double(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.array(fc.string(), { maxLength: 3 }), fc.object({ maxDepth: 1 }));
  const fieldsOf = ['ClosePrice', 'CloseDate', 'PurchaseContractDate', 'OriginalListPrice', 'ConcessionsAmount', 'SpecialListingConditions', 'DaysOnMarket', 'Latitude', 'Longitude', 'YearBuilt', 'LotSizeArea', 'LotSizeUnits', 'LotSizeAcres', 'LotSizeSquareFeet', 'SubdivisionName', 'GarageSpaces', 'PoolPrivateYN', 'Stories', 'InternetAutomatedValuationDisplayYN', 'BedroomsTotal', 'LivingArea', 'ListingContractDate'] as const;
  const keyOf: Partial<Record<string, keyof ValuationFacts>> = { ClosePrice: 'closePriceCents', CloseDate: 'closeDate', PurchaseContractDate: 'contractDate', OriginalListPrice: 'originalListPriceCents', ConcessionsAmount: 'concessionsCents', DaysOnMarket: 'daysOnMarket', YearBuilt: 'yearBuilt', SubdivisionName: 'subdivisionName', GarageSpaces: 'garageSpacesX10', PoolPrivateYN: 'poolPrivate', Stories: 'storiesX10' };

  it('R-CMA-1: any values for the new fields: no throw, values within their bounds, and an unreadable field has no value', () => {
    fc.assert(
      fc.property(fc.record(Object.fromEntries(fieldsOf.map((f) => [f, junk])) as Record<(typeof fieldsOf)[number], fc.Arbitrary<unknown>>), (rec) => {
        const r = normalizeMlsListing({ ...RESO_FULL, ...rec }, MAPPING);
        if (Array.isArray(r)) return; // an existing column's issue (beds, sqft): the record is skipped, as today
        const x = (r as ListingFacts).valuation;
        for (const name of x.unreadable) {
          const key = keyOf[name];
          if (key !== undefined) expect(x[key], name).toBeNull();
        }
        if (x.unreadable.includes('Latitude') || x.unreadable.includes('Longitude')) expect([x.latitudeE6, x.longitudeE6]).toEqual([null, null]);
        expect((x.latitudeE6 === null) === (x.longitudeE6 === null)).toBe(true);
        if (x.latitudeE6 !== null) expect(Math.abs(x.latitudeE6) <= 90e6 && Math.abs(x.longitudeE6!) <= 180e6 && Number.isInteger(x.latitudeE6)).toBe(true);
        for (const s of [x.garageSpacesX10, x.storiesX10]) if (s !== null) expect(Number.isInteger(s) && s >= 0 && s <= SMALLINT_MAX).toBe(true);
        if (x.yearBuilt !== null) expect(x.yearBuilt >= 1600 && x.yearBuilt <= 2100).toBe(true);
        if (x.daysOnMarket !== null) expect(Number.isInteger(x.daysOnMarket) && x.daysOnMarket >= 0 && x.daysOnMarket <= INTEGER_MAX).toBe(true);
        for (const c of [x.closePriceCents, x.originalListPriceCents, x.concessionsCents, x.lotSqft]) if (c !== null) expect(Number.isSafeInteger(c) && c >= 0).toBe(true);
        for (const d of [x.closeDate, x.contractDate]) if (d !== null) expect(calendarDate(d)).toBe(d);
        expect(x.saleConditions.every((c) => ['standard', 'short_sale', 'reo', 'auction', 'probate', 'other'].includes(c))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('R-CMA-1: any record at all never throws', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => normalizeMlsListing(raw as ResoLike, MAPPING)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
