// Test fixtures for core/marketing: a team listing, an identity, packs and one valid piece per kind.
import { at, type IanaZone, type ListingId, type MessageId, type ShowingId, type StoredObjectId } from '../../foundation/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack } from '../../fairhousing/index.js';
import { EMPTY_VALUATION_FACTS, type ListingFacts } from '../../listings/index.js';
import { advertisingPackFrom } from '../schemas.js';
import type { BrokerageIdentity, Packs, PieceKind, PieceVersion, ProseByKind } from '../types.js';

export const ZONE = 'America/Chicago' as IanaZone;
export const SHA = 'a'.repeat(64);
export const OTHER_SHA = 'b'.repeat(64);
export const FH: FairHousingPack = DEFAULT_FAIR_HOUSING_PACK;

export const lid = (n: number): ListingId => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}` as ListingId;
export const oid = (n: number): StoredObjectId => `01900000-0000-7000-8000-0000000a${String(n).padStart(4, '0')}` as StoredObjectId;
export const mid = (n: number): MessageId => `01900000-0000-7000-8000-0000000b${String(n).padStart(4, '0')}` as MessageId;
export const sid = (n: number): ShowingId => `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}` as ShowingId;

export const teamListing = (o: Partial<ListingFacts> = {}): ListingFacts => ({
  id: lid(1),
  source: 'team',
  listingKey: null,
  mlsNumber: null,
  status: 'active',
  addressLine1: '12 Oak St',
  addressLine2: null,
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  listPriceCents: 45_000_000,
  beds: 3,
  bathsX10: 25,
  sqft: 1850,
  propertyType: 'single_family',
  description: 'Bright corner home.',
  listDate: '2026-10-01',
  mlsConnectionId: null,
  mlsModifiedAt: null,
  listingBrokerageName: null,
  displayAllowed: false,
  addressDisplayAllowed: false,
  photoUrls: [],
  photosCount: null,
  teamListingId: null,
  lastSeenInFeedAt: null,
  offMarketAt: null,
  valuation: EMPTY_VALUATION_FACTS,
  ...o,
});

export const mlsListing = (o: Partial<ListingFacts> = {}): ListingFacts =>
  teamListing({
    id: lid(900),
    source: 'mls',
    listingKey: 'k-900',
    mlsNumber: 'MLS900',
    mlsConnectionId: '01900000-0000-7000-8000-00000000c001' as ListingFacts['mlsConnectionId'],
    mlsModifiedAt: at('2026-11-01T12:00:00Z'),
    listingBrokerageName: 'Other Brokerage LLC',
    displayAllowed: true,
    addressDisplayAllowed: true,
    ...o,
  });

export const IDENTITY: BrokerageIdentity = {
  brokerageLegalName: 'Lone Star Realty LLC',
  teamName: 'The Smith Team',
  licenseNumber: '0123456',
  brokerageAddress: '100 Congress Ave, Austin, TX 78701',
  brokeragePhone: null,
};

/** The strictest default (no pack configured). */
export const STRICT: Packs = { advertising: [] };
/** A pack that only asks for the brokerage name and the statement (prominence off). */
export const LENIENT: Packs = {
  advertising: [
    advertisingPackFrom('test.lenient', {
      brokerage_name_at_least_as_prominent_as_team: false,
      require_license_number: false,
      require_brokerage_address: false,
      require_equal_housing_statement: true,
    }),
  ],
};

export const PROSE: { [K in PieceKind]: ProseByKind[K] } = {
  website_page: { headline: 'Light-filled corner home near the park', body: 'Wide windows, a renovated kitchen and a shaded back deck.', highlights: ['Renovated kitchen', 'Shaded deck'] },
  social_post: { caption: 'Just listed: a light-filled corner home near the park.', hashtags: ['#JustListed', '#AustinHomes'] },
  open_house_invite: { subject: 'Open house at a light-filled corner home', body: 'Come see the renovated kitchen and the shaded deck.' },
  flyer: { headline: 'Corner home near the park', body: 'Renovated kitchen, wide windows, shaded deck.', highlights: ['Renovated kitchen'] },
  marketplace_export: { title: 'Corner home near the park', description: 'Renovated kitchen, wide windows and a shaded back deck.' },
  gbp_post: { body: 'New listing: a light-filled corner home near the park.' },
};

const TEMPLATE: Record<PieceKind, string> = {
  website_page: 'website_page.standard',
  social_post: 'social_post.standard',
  open_house_invite: 'open_house_invite.standard',
  flyer: 'flyer.standard',
  marketplace_export: 'marketplace_export.standard',
  gbp_post: 'gbp_post.standard',
};

export const ALL_BOUND = ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'photos'] as const;

export function piece<K extends PieceKind>(kind: K, o: Partial<PieceVersion<K>> = {}): PieceVersion<K> {
  return {
    kind,
    versionNo: 1,
    prose: PROSE[kind],
    templateKey: TEMPLATE[kind],
    boundFields: kind === 'open_house_invite' ? [...ALL_BOUND, 'open_house_at'] : [...ALL_BOUND],
    assets: [
      { objectId: oid(2), position: 2 },
      { objectId: oid(1), position: 1 },
    ],
    openHouse: kind === 'open_house_invite' ? { startsAt: at('2026-11-14T19:00:00Z'), endsAt: at('2026-11-14T21:00:00Z'), zone: ZONE } : null,
    ...o,
  };
}

export const withProse = <K extends PieceKind>(kind: K, prose: Partial<ProseByKind[K]>): PieceVersion<K> => piece(kind, { prose: { ...PROSE[kind], ...prose } });
