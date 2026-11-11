import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { matchListing } from '../assistant/index.js';
import { normalizeMlsListing, priceToCents } from './normalize.js';
import { CONN, MAPPING, RESO_FULL } from './testing/fixtures.js';
import type { Issue, ListingFacts, ResoLike } from './types.js';

function facts(raw: ResoLike, mapping = MAPPING): ListingFacts {
  const r = normalizeMlsListing(raw, mapping);
  if (Array.isArray(r)) throw new Error(`expected facts, got issues: ${JSON.stringify(r)}`);
  return r as ListingFacts;
}
function issues(raw: unknown, mapping = MAPPING): Issue[] {
  const r = normalizeMlsListing(raw as ResoLike, mapping);
  if (!Array.isArray(r)) throw new Error('expected issues');
  return r;
}

describe('normalizeMlsListing: RESO fixtures', () => {
  it('R-MLS-1: a full RESO record normalizes to an mls row with its connection, modification time and brokerage', () => {
    const f = facts(RESO_FULL);
    expect(f).toEqual({
      id: null,
      source: 'mls',
      listingKey: 'k-1001',
      mlsNumber: 'MLS1001',
      status: 'active',
      addressLine1: '12 Oak St',
      addressLine2: 'Unit 4B',
      city: 'Austin',
      region: 'TX',
      postalCode: '78701-1234',
      listPriceCents: 45_000_000,
      beds: 3,
      bathsX10: 20,
      sqft: 1850,
      propertyType: 'single_family',
      description: 'Bright corner home.',
      listDate: '2026-10-01',
      mlsConnectionId: CONN,
      mlsModifiedAt: at('2026-11-01T12:00:00Z'),
      listingBrokerageName: 'Other Brokerage LLC',
      displayAllowed: true,
      addressDisplayAllowed: true,
      photoUrls: ['https://cdn.example.test/1.jpg', 'https://cdn.example.test/2.jpg'],
      photosCount: 2,
      teamListingId: null,
      lastSeenInFeedAt: null,
      offMarketAt: null,
    });
  });

  it('normalized MLS rows are structurally usable by the Phase 1 saved-search matcher (MLS rows are refused there until module 24 widens it)', () => {
    const f = facts(RESO_FULL);
    expect(matchListing({ postalCodes: ['78701'] }, f)).toBe(false);
    expect(matchListing({ postalCodes: ['78701'] }, { ...f, source: 'team' })).toBe(true);
  });

  it('R-MLS-1: missing ListingKey, ModificationTimestamp and ListOfficeName return issues, never a throw', () => {
    const { ListingKey: _k, ModificationTimestamp: _m, ListOfficeName: _o, ...rest } = RESO_FULL;
    const got = issues(rest);
    expect(got.map((i) => [i.code, i.field])).toEqual([
      ['MLS_FIELD_MISSING', 'ListingKey'],
      ['MLS_FIELD_MISSING', 'ModificationTimestamp'],
      ['MLS_FIELD_MISSING', 'ListOfficeName'],
    ]);
    for (const i of got) expect(i.detail.length).toBeGreaterThan(0);
  });

  it('a non-object record is one MLS_RECORD_INVALID issue', () => {
    for (const bad of [null, undefined, 42, 'x', [RESO_FULL]]) {
      expect(issues(bad)).toEqual([{ code: 'MLS_RECORD_INVALID', field: '*', detail: expect.any(String) }]);
    }
  });

  it('a modification timestamp without an offset or of the wrong type is invalid', () => {
    expect(issues({ ...RESO_FULL, ModificationTimestamp: '2026-11-01 12:00:00' })).toEqual([
      { code: 'MLS_FIELD_INVALID', field: 'ModificationTimestamp', detail: expect.any(String) },
    ]);
    expect(issues({ ...RESO_FULL, ModificationTimestamp: 1_700_000_000_000 })[0]?.code).toBe('MLS_FIELD_INVALID');
  });

  it('blank strings count as missing; required address parts are reported', () => {
    const got = issues({ ...RESO_FULL, ListingKey: '  ', City: '', StateOrProvince: null, PostalCode: undefined, UnparsedAddress: '', StreetName: '' });
    expect(got.map((i) => i.field)).toEqual(['ListingKey', 'UnparsedAddress', 'City', 'StateOrProvince', 'PostalCode']);
  });

  it('a numeric ListingKey is accepted as text; ListingId falls back to ListingKey', () => {
    const { ListingId: _id, ...rest } = RESO_FULL;
    const f = facts({ ...rest, ListingKey: 1001 });
    expect(f.listingKey).toBe('1001');
    expect(f.mlsNumber).toBe('1001');
    expect(issues({ ...RESO_FULL, ListingKey: { a: 1 } })[0]).toMatchObject({ code: 'MLS_FIELD_INVALID', field: 'ListingKey' });
  });
});

describe('normalizeMlsListing: money, numbers, flags', () => {
  it('price strings and decimals become integer cents without float error', () => {
    expect(priceToCents(450000)).toBe(45_000_000);
    expect(priceToCents('450000')).toBe(45_000_000);
    expect(priceToCents('$1,299,999.99')).toBe(129_999_999);
    expect(priceToCents(0.1 + 0.2)).toBeNull(); // 0.30000000000000004: more than two decimals
    expect(priceToCents(19.99)).toBe(1999);
    expect(priceToCents('19.9')).toBe(1990);
    expect(priceToCents(' 7 ')).toBe(700);
    for (const bad of ['-5', 'abc', '1.234', '', '1e6', Number.NaN, Number.POSITIVE_INFINITY, -1, 1e21, true, {}]) {
      expect(priceToCents(bad)).toBeNull();
    }
    expect(facts({ ...RESO_FULL, ListPrice: '525,000.50' }).listPriceCents).toBe(52_500_050);
  });

  it('a missing price is null; an unparseable price is an issue', () => {
    expect(facts({ ...RESO_FULL, ListPrice: null }).listPriceCents).toBeNull();
    expect(issues({ ...RESO_FULL, ListPrice: 'call agent' })).toEqual([{ code: 'MLS_FIELD_INVALID', field: 'ListPrice', detail: expect.any(String) }]);
  });

  it('beds, baths and living area accept numeric strings; baths are stored ×10; area is rounded', () => {
    const f = facts({ ...RESO_FULL, BedroomsTotal: '4', BathroomsTotalInteger: '2.5', LivingArea: '1850.6' });
    expect([f.beds, f.bathsX10, f.sqft]).toEqual([4, 25, 1851]);
    const g = facts({ ...RESO_FULL, BedroomsTotal: undefined, BathroomsTotalInteger: null, LivingArea: undefined, PhotosCount: undefined });
    expect([g.beds, g.bathsX10, g.sqft, g.photosCount]).toEqual([null, null, null, null]);
    expect(issues({ ...RESO_FULL, BedroomsTotal: 2.5, BathroomsTotalInteger: -1, LivingArea: 'big', PhotosCount: 'x' }).map((i) => i.field)).toEqual([
      'BedroomsTotal',
      'BathroomsTotalInteger',
      'LivingArea',
      'PhotosCount',
    ]);
  });

  it('R-MLS-2: display flags are true only when the feed says yes explicitly (never allowed by default)', () => {
    for (const yes of [true, 'Y', 'yes', 'TRUE', '1', 1]) {
      expect(facts({ ...RESO_FULL, InternetEntireListingDisplayYN: yes }).displayAllowed).toBe(true);
    }
    for (const no of [false, 'N', 'no', 0, undefined, null, 'maybe', {}]) {
      const f = facts({ ...RESO_FULL, InternetEntireListingDisplayYN: no, InternetAddressDisplayYN: no });
      expect([f.displayAllowed, f.addressDisplayAllowed]).toEqual([false, false]);
    }
  });

  it('the street line is composed from parts when UnparsedAddress is absent', () => {
    const f = facts({ ...RESO_FULL, UnparsedAddress: undefined, StreetDirPrefix: 'N', StreetDirSuffix: undefined, UnitNumber: undefined });
    expect([f.addressLine1, f.addressLine2]).toEqual(['12 N Oak St', null]);
    const unit = facts({ ...RESO_FULL, UnitNumber: '#7' });
    expect(unit.addressLine2).toBe('#7');
  });

  it('photos keep feed order, skip non-photo media and non-http URLs; no Media is an empty list', () => {
    const f = facts({
      ...RESO_FULL,
      Media: [
        { MediaURL: 'https://cdn.example.test/b.jpg' },
        { MediaURL: 'ftp://x/y.jpg', Order: 0 },
        { MediaURL: 'https://cdn.example.test/a.jpg', Order: 0 },
        { MediaURL: 42 },
        'not-an-object',
        { MediaURL: 'https://cdn.example.test/v.mp4', MediaCategory: 'Video' },
      ],
    });
    expect(f.photoUrls).toEqual(['https://cdn.example.test/a.jpg', 'https://cdn.example.test/b.jpg']);
    expect(facts({ ...RESO_FULL, Media: undefined }).photoUrls).toEqual([]);
    expect(facts({ ...RESO_FULL, Media: 'nope' }).photoUrls).toEqual([]);
  });

  it('property type: subtype first, then type, unknown is null; listing date must be YYYY-MM-DD', () => {
    expect(facts({ ...RESO_FULL, PropertySubType: 'Condominium' }).propertyType).toBe('condo');
    expect(facts({ ...RESO_FULL, PropertySubType: undefined, PropertyType: 'Land' }).propertyType).toBe('land');
    expect(facts({ ...RESO_FULL, PropertySubType: 'Boat Slip', PropertyType: 'Other Thing' }).propertyType).toBeNull();
    expect(facts({ ...RESO_FULL, ListingContractDate: '10/01/2026' }).listDate).toBeNull();
    expect(facts({ ...RESO_FULL, ListingContractDate: '2026-10-01T00:00:00Z' }).listDate).toBe('2026-10-01');
    expect(facts({ ...RESO_FULL, PublicRemarks: '   ' }).description).toBeNull();
  });
});

describe('normalizeMlsListing: status vocabulary and mapping overrides', () => {
  it('RESO StandardStatus values map to our statuses, case- and space-insensitively', () => {
    const cases: [string, string][] = [
      ['Active', 'active'],
      ['active  under contract', 'pending'],
      ['Pending', 'pending'],
      ['Closed', 'sold'],
      ['Withdrawn', 'withdrawn'],
      ['Canceled', 'withdrawn'],
      ['Expired', 'expired'],
      ['ComingSoon', 'coming_soon'],
      ['Coming Soon', 'coming_soon'],
    ];
    for (const [feed, ours] of cases) expect(facts({ ...RESO_FULL, StandardStatus: feed }).status).toBe(ours);
  });

  it('an unknown or missing status is an issue, never guessed', () => {
    expect(issues({ ...RESO_FULL, StandardStatus: 'Hold' })).toEqual([{ code: 'MLS_STATUS_UNKNOWN', field: 'StandardStatus', detail: expect.stringContaining('Hold') }]);
    expect(issues({ ...RESO_FULL, StandardStatus: undefined })[0]).toMatchObject({ code: 'MLS_FIELD_MISSING', field: 'StandardStatus' });
  });

  it('a mapping reads other field names and extends the status and property-type vocabularies', () => {
    const raw: ResoLike = {
      ...RESO_FULL,
      ListingKey: undefined,
      X_Key: 'x-9',
      StandardStatus: undefined,
      MlsStatus: 'A-UC',
      ListPrice: undefined,
      X_Price: '300000',
      PropertySubType: 'Duplex',
      Media: undefined,
      Photos: [{ Uri: 'https://img.example.test/p.jpg' }],
    };
    const f = facts(raw, {
      connectionId: CONN,
      fields: { listingKey: 'X_Key', mlsNumber: 'X_Key', status: 'MlsStatus', listPrice: 'X_Price', media: 'Photos' },
      statusMap: { 'a-uc': 'pending', Hold: 'withdrawn' },
      propertyTypeMap: { duplex: 'multi_family' },
      mediaUrlKey: 'Uri',
    });
    expect([f.listingKey, f.mlsNumber, f.status, f.listPriceCents, f.propertyType]).toEqual(['x-9', 'x-9', 'pending', 30_000_000, 'multi_family']);
    expect(f.photoUrls).toEqual(['https://img.example.test/p.jpg']);
    const issue = issues({ ...RESO_FULL, MlsStatus: 'Zzz' }, { connectionId: CONN, fields: { status: 'MlsStatus' } });
    expect(issue[0]).toMatchObject({ code: 'MLS_STATUS_UNKNOWN', field: 'MlsStatus' });
  });
});
