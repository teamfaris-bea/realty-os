// Test fixtures for core/listings: RESO records, mappings, packs and listing facts.
import { at, type ListingId } from '../../foundation/index.js';
import { parseLicensePack } from '../licence.js';
import { EMPTY_VALUATION_FACTS, type FieldMapping, type LicensePack, type ListingFacts, type MlsConnectionId, type ResoLike } from '../types.js';

export const CONN = '01900000-0000-7000-8000-00000000c001' as MlsConnectionId;
export const MAPPING: FieldMapping = { connectionId: CONN };

export const lid = (n: number): ListingId => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}` as ListingId;

/** A complete RESO record. */
export const RESO_FULL: ResoLike = {
  ListingKey: 'k-1001',
  ListingId: 'MLS1001',
  StandardStatus: 'Active',
  ListPrice: 450000,
  BedroomsTotal: 3,
  BathroomsTotalInteger: 2,
  LivingArea: 1850,
  UnparsedAddress: '12 Oak St',
  StreetNumber: '12',
  StreetName: 'Oak',
  StreetSuffix: 'St',
  UnitNumber: '4B',
  City: 'Austin',
  StateOrProvince: 'tx',
  PostalCode: '78701-1234',
  PropertyType: 'Residential',
  PropertySubType: 'Single Family Residence',
  PublicRemarks: '  Bright corner home.  ',
  ListingContractDate: '2026-10-01',
  ModificationTimestamp: '2026-11-01T12:00:00Z',
  ListOfficeName: 'Other Brokerage LLC',
  InternetEntireListingDisplayYN: true,
  InternetAddressDisplayYN: true,
  PhotosCount: 2,
  Media: [
    { MediaURL: 'https://cdn.example.test/2.jpg', Order: 2, MediaCategory: 'Photo' },
    { MediaURL: 'https://cdn.example.test/1.jpg', Order: 1, MediaCategory: 'Photo' },
    { MediaURL: 'https://cdn.example.test/plan.pdf', Order: 3, MediaCategory: 'Floor Plan' },
  ],
};

/** A counsel-reviewed pack that allows every field to clients and active/pending to the public. */
export const REVIEWED_PACK: LicensePack = parseLicensePack({
  reviewed_by_counsel_at: '2026-10-15T09:00:00Z',
  max_staleness_hours: 24,
  attribution_text: 'Listing courtesy of {brokerage}. Data from the Example MLS.',
  disclaimer_text: 'Information deemed reliable but not guaranteed.',
  allow_rehost_photos: false,
  require_listing_brokerage: true,
  audiences: {
    client: {
      fields: ['mlsNumber', 'status', 'listPrice', 'beds', 'baths', 'sqft', 'propertyType', 'description', 'listDate', 'address', 'locality', 'photos', 'closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision'],
      statuses: ['coming_soon', 'active', 'pending', 'sold'],
    },
    public: { fields: ['status', 'listPrice', 'beds', 'locality', 'photos'], statuses: ['active', 'pending'] },
  },
});

export const mls = (o: Partial<ListingFacts> = {}): ListingFacts => ({
  id: lid(1),
  source: 'mls',
  listingKey: 'k-1',
  mlsNumber: 'MLS1',
  status: 'active',
  addressLine1: '12 Oak St',
  addressLine2: null,
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
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
  photoUrls: ['https://cdn.example.test/1.jpg'],
  photosCount: 1,
  teamListingId: null,
  lastSeenInFeedAt: at('2026-11-01T12:05:00Z'),
  offMarketAt: null,
  valuation: EMPTY_VALUATION_FACTS,
  ...o,
});

export const team = (o: Partial<ListingFacts> = {}): ListingFacts =>
  mls({
    source: 'team',
    listingKey: null,
    mlsConnectionId: null,
    mlsModifiedAt: null,
    listingBrokerageName: null,
    displayAllowed: false,
    addressDisplayAllowed: false,
    lastSeenInFeedAt: null,
    ...o,
  });
