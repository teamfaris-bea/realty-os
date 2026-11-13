// Types for MLS/IDX listings (PHASE2_3_PLAN module 23; DATA_MODEL Part 2 R-MLS-1…5).
//
// - `ResoLike` is one record as a RESO Web API feed returns it. Feeds vary, so every field is `unknown`
//   and normalization (normalize.ts) validates each one.
// - `FieldMapping` is the per-MLS / per-connection override: which RESO field names to read and how the
//   feed's status vocabulary maps onto our `listings.status` values.
// - `ListingFacts` mirrors the `listings` row (0001_init.sql + 0018 section 4). It is a structural
//   superset of `@realty/core/assistant`'s `ListingFacts`, so MLS rows can be fed to `matchListing`.
// - `LicensePack` is `integration_connections.license_pack`, entered by the Owner/Admin from their MLS
//   agreement. EVERY value is VERIFY WITH COUNSEL / MLS; anything missing or invalid parses to the
//   strictest value, and display is never "allowed" by default (licence.ts).
import type { Brand, Instant, ListingId } from '../foundation/index.js';
import type { ListingStatus, PropertyType } from '../assistant/index.js';

export type { ListingStatus, PropertyType };

export const LISTING_STATUSES = ['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired'] as const satisfies readonly ListingStatus[];

/** integration_connections.id of an `mls_feed` connection. */
export type MlsConnectionId = Brand<string, 'IntegrationConnectionId'>;

export type ListingSource = 'team' | 'mls';
export type Audience = 'agent' | 'client' | 'public';

// ---- feed input -------------------------------------------------------------------------------

/** One RESO Media entry (only what we read). */
export interface ResoMediaLike {
  readonly MediaURL?: unknown;
  readonly Order?: unknown;
  readonly MediaCategory?: unknown;
  readonly [field: string]: unknown;
}

/**
 * A RESO Data Dictionary shaped record. Every field is optional and untyped: feeds differ, and a
 * mapping may point any of our fields at another name (custom `X_` fields included).
 */
export interface ResoLike {
  readonly ListingKey?: unknown;
  readonly ListingId?: unknown;
  readonly StandardStatus?: unknown;
  readonly MlsStatus?: unknown;
  readonly ListPrice?: unknown;
  readonly BedroomsTotal?: unknown;
  readonly BathroomsTotalInteger?: unknown;
  readonly LivingArea?: unknown;
  readonly UnparsedAddress?: unknown;
  readonly StreetNumber?: unknown;
  readonly StreetDirPrefix?: unknown;
  readonly StreetName?: unknown;
  readonly StreetSuffix?: unknown;
  readonly StreetDirSuffix?: unknown;
  readonly UnitNumber?: unknown;
  readonly City?: unknown;
  readonly StateOrProvince?: unknown;
  readonly PostalCode?: unknown;
  readonly PropertyType?: unknown;
  readonly PropertySubType?: unknown;
  readonly PublicRemarks?: unknown;
  readonly ListingContractDate?: unknown;
  readonly ModificationTimestamp?: unknown;
  readonly ListOfficeName?: unknown;
  readonly InternetEntireListingDisplayYN?: unknown;
  readonly InternetAddressDisplayYN?: unknown;
  readonly PhotosCount?: unknown;
  readonly Media?: unknown;
  // sale and property facts (R-CMA-1)
  readonly ClosePrice?: unknown;
  readonly CloseDate?: unknown;
  readonly PurchaseContractDate?: unknown;
  readonly OriginalListPrice?: unknown;
  readonly ConcessionsAmount?: unknown;
  readonly SpecialListingConditions?: unknown;
  readonly DaysOnMarket?: unknown;
  readonly Latitude?: unknown;
  readonly Longitude?: unknown;
  readonly YearBuilt?: unknown;
  readonly LotSizeArea?: unknown;
  readonly LotSizeUnits?: unknown;
  readonly LotSizeAcres?: unknown;
  readonly LotSizeSquareFeet?: unknown;
  readonly SubdivisionName?: unknown;
  readonly GarageSpaces?: unknown;
  readonly PoolPrivateYN?: unknown;
  readonly Stories?: unknown;
  readonly InternetAutomatedValuationDisplayYN?: unknown;
  readonly [field: string]: unknown;
}

/** Our fields that a mapping can point at a RESO field name. */
export type FactField =
  | 'listingKey'
  | 'mlsNumber'
  | 'status'
  | 'listPrice'
  | 'beds'
  | 'baths'
  | 'sqft'
  | 'unparsedAddress'
  | 'streetNumber'
  | 'streetDirPrefix'
  | 'streetName'
  | 'streetSuffix'
  | 'streetDirSuffix'
  | 'unitNumber'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'propertyType'
  | 'propertySubType'
  | 'description'
  | 'listDate'
  | 'modifiedAt'
  | 'listingBrokerageName'
  | 'internetDisplay'
  | 'addressDisplay'
  | 'photosCount'
  | 'media'
  | 'closePrice'
  | 'closeDate'
  | 'contractDate'
  | 'originalListPrice'
  | 'concessions'
  | 'saleConditions'
  | 'daysOnMarket'
  | 'latitude'
  | 'longitude'
  | 'yearBuilt'
  | 'lotSizeArea'
  | 'lotSizeUnits'
  | 'lotSizeAcres'
  | 'lotSizeSquareFeet'
  | 'subdivisionName'
  | 'garageSpaces'
  | 'poolPrivate'
  | 'stories'
  | 'avmDisplay';

/** RESO SpecialListingConditions, folded (listings.sale_conditions). */
export type SaleCondition = 'standard' | 'short_sale' | 'reo' | 'auction' | 'probate' | 'other';
export const SALE_CONDITIONS = ['standard', 'short_sale', 'reo', 'auction', 'probate', 'other'] as const satisfies readonly SaleCondition[];

/** Per-MLS overrides. Everything but the connection is optional and merges over the RESO defaults. */
export interface FieldMapping {
  /** The `mls_feed` connection the record came from (R-MLS-1: an mls row needs its connection). */
  readonly connectionId: MlsConnectionId;
  /** RESO field name to read for each of our fields (defaults: RESO_DEFAULT_FIELDS). */
  readonly fields?: Readonly<Partial<Record<FactField, string>>>;
  /** Feed status value → our status. Keys compare case- and space-insensitively; merged over the RESO StandardStatus defaults. */
  readonly statusMap?: Readonly<Record<string, ListingStatus>>;
  /** Feed PropertySubType / PropertyType value → our property type; merged over the defaults. Unknown ⇒ null. */
  readonly propertyTypeMap?: Readonly<Record<string, PropertyType>>;
  /** Key of the URL inside each Media entry (default `MediaURL`). */
  readonly mediaUrlKey?: string;
  /** Extra SubdivisionName values that mean "none" (vocabulary keys; merged over the defaults). VERIFY WITH MLS. */
  readonly subdivisionPlaceholders?: readonly string[];
  /** SpecialListingConditions value → our condition; merged over the defaults. Unknown ⇒ 'other'. */
  readonly saleConditionMap?: Readonly<Record<string, SaleCondition>>;
  /** Extra PropertyType values that are leases (vocabulary keys; merged over residentiallease/commerciallease). VERIFY WITH MLS. */
  readonly leasePropertyTypes?: readonly string[];
}

/**
 * The MLS sale and property facts of a listing (R-CMA-1; the S0 listings columns). Every value is null when the
 * feed did not send it or sent something unreadable or out of the column's bound; such RESO names are listed in
 * `unreadable`. Team rows carry EMPTY_VALUATION_FACTS (only the MLS sync writes these columns).
 */
export interface ValuationFacts {
  readonly closePriceCents: number | null;
  /** `YYYY-MM-DD` */
  readonly closeDate: string | null;
  /** `YYYY-MM-DD` (RESO PurchaseContractDate) */
  readonly contractDate: string | null;
  readonly originalListPriceCents: number | null;
  readonly concessionsCents: number | null;
  /** [] = not recorded */
  readonly saleConditions: readonly SaleCondition[];
  readonly daysOnMarket: number | null;
  /** integer microdegrees; both null or both set */
  readonly latitudeE6: number | null;
  readonly longitudeE6: number | null;
  readonly yearBuilt: number | null;
  /** whole square feet */
  readonly lotSqft: number | null;
  /** null for a placeholder ("None", "N/A", …) */
  readonly subdivisionName: string | null;
  /** tenths: 2.5 spaces is 25 */
  readonly garageSpacesX10: number | null;
  readonly poolPrivate: boolean | null;
  /** tenths: 1.5 stories is 15 */
  readonly storiesX10: number | null;
  /** the RESO field name sqft was read from (null when sqft is null) */
  readonly sizeSource: string | null;
  readonly isLease: boolean;
  /** InternetAutomatedValuationDisplayYN: true only for an explicit yes */
  readonly avmDisplayAllowed: boolean;
  /** RESO names present in the record but invalid or out of bound (each dropped to null) */
  readonly unreadable: readonly string[];
}

export const EMPTY_VALUATION_FACTS: ValuationFacts = Object.freeze({
  closePriceCents: null,
  closeDate: null,
  contractDate: null,
  originalListPriceCents: null,
  concessionsCents: null,
  saleConditions: Object.freeze([]) as readonly SaleCondition[],
  daysOnMarket: null,
  latitudeE6: null,
  longitudeE6: null,
  yearBuilt: null,
  lotSqft: null,
  subdivisionName: null,
  garageSpacesX10: null,
  poolPrivate: null,
  storiesX10: null,
  sizeSource: null,
  isLease: false,
  avmDisplayAllowed: false,
  unreadable: Object.freeze([]) as readonly string[],
});

/** The normalization version stored in listings.mls_normalize_version (1 = before R-CMA-1). */
export const NORMALIZE_VERSION = 2;

// ---- normalized row -----------------------------------------------------------------------------

/** Our normalized listing, mirroring the `listings` columns (money in integer cents, baths ×10). */
export interface ListingFacts {
  /** listings.id; null for a record normalized from the feed and not yet stored. */
  readonly id: ListingId | null;
  readonly source: ListingSource;
  /** RESO ListingKey (stable feed key); null for team rows. */
  readonly listingKey: string | null;
  /** listings.mls_number (upsert key with source, R-MLS-1). */
  readonly mlsNumber: string | null;
  readonly status: ListingStatus;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly listPriceCents: number | null;
  readonly beds: number | null;
  readonly bathsX10: number | null;
  readonly sqft: number | null;
  readonly propertyType: PropertyType | null;
  readonly description: string | null;
  /** `YYYY-MM-DD` */
  readonly listDate: string | null;
  readonly mlsConnectionId: MlsConnectionId | null;
  readonly mlsModifiedAt: Instant | null;
  readonly listingBrokerageName: string | null;
  /** listings.display_allowed: the listing broker allows internet display (IDX). Never defaulted to true. */
  readonly displayAllowed: boolean;
  /** RESO InternetAddressDisplayYN; never defaulted to true. Stored in listings.attributes. */
  readonly addressDisplayAllowed: boolean;
  /** Feed photo URLs in feed order (referenced, not re-hosted, unless the pack allows it: R-MLS-4). */
  readonly photoUrls: readonly string[];
  readonly photosCount: number | null;
  /** An mls row mirroring one of our own listings (R-MLS-5). */
  readonly teamListingId: ListingId | null;
  readonly lastSeenInFeedAt: Instant | null;
  readonly offMarketAt: Instant | null;
  /** MLS sale and property facts (R-CMA-1); EMPTY_VALUATION_FACTS for team rows. */
  readonly valuation: ValuationFacts;
}

export type ListingsIssueCode = 'MLS_RECORD_INVALID' | 'MLS_FIELD_MISSING' | 'MLS_FIELD_INVALID' | 'MLS_STATUS_UNKNOWN';

/** A reason one feed record could not be normalized. `field` is the RESO field name read. */
export interface Issue {
  readonly code: ListingsIssueCode;
  readonly field: string;
  readonly detail: string;
}

/** Codes this module names for the API (E141: the DB trigger raises it; the sync skips the record). */
export type ListingsErrorCode = 'MLS_STALE_UPDATE';

// ---- licence pack ---------------------------------------------------------------------------------

/** Fields a licence pack can allow per audience. `address` = street lines; `locality` = city/region/postal code. */
export const DISPLAY_FIELDS = [
  'mlsNumber',
  'status',
  'listPrice',
  'beds',
  'baths',
  'sqft',
  'propertyType',
  'description',
  'listDate',
  'address',
  'locality',
  'photos',
  'closePrice',
  'closeDate',
  'yearBuilt',
  'lotSize',
  'subdivision',
] as const;
export type DisplayField = (typeof DISPLAY_FIELDS)[number];

export interface AudienceRules {
  /** Fields shown to this audience. Default: none. */
  readonly fields: readonly DisplayField[];
  /** Listing statuses this audience may see (e.g. sold data is often restricted). Default: none. */
  readonly statuses: readonly ListingStatus[];
}

/** Parsed `integration_connections.license_pack`. VERIFY WITH COUNSEL / MLS: every value. */
export interface LicensePack {
  /** When counsel reviewed this pack (ISO with offset). Null ⇒ nothing is shown to clients or the public (R-MLS-2). */
  readonly reviewedByCounselAt: string | null;
  /** Feed data older than this is stale (R-MLS-3). Null (not configured) ⇒ always stale. */
  readonly maxStalenessHours: number | null;
  /** Attribution every client/public rendering carries. Null ⇒ client/public renderings are refused. */
  readonly attributionText: string | null;
  /** Disclaimer every client/public rendering carries. Null ⇒ client/public renderings are refused. */
  readonly disclaimerText: string | null;
  /** Whether MLS photos may be copied to our storage. Default false: referenced by URL (R-MLS-4). */
  readonly allowRehostPhotos: boolean;
  /** Whether a client/public rendering needs the listing brokerage name. Default true. */
  readonly requireListingBrokerage: boolean;
  readonly audiences: { readonly client: AudienceRules; readonly public: AudienceRules };
  /** Valuation use of the sold data (D9; its own counsel stamp). Strictest by default. */
  readonly valuation: ValuationLicence;
}

/** Uses of MLS sold data for values (R-CMA-6, R-CMA-7). */
export type ValuationUse = 'agent_cma' | 'client_cma' | 'automated_notes';

/**
 * `license_pack.valuation`: what the MLS agreement allows for valuations, entered by the Owner/Admin from the
 * agreement and counsel (VERIFY WITH COUNSEL / MLS, V1, V4, V6). Its counsel stamp is its own, so adding it never
 * changes the display pack's review state (E371).
 */
export interface ValuationLicence {
  /** Agents may prepare CMAs from the sold data (the Owner/Admin's statement from the agreement). */
  readonly agentCma: boolean;
  /** CMAs and seller-update value ranges may be shared with clients. */
  readonly clientCma: boolean;
  /** Automated home-value notes may carry values built from the sold data. */
  readonly automatedNotes: boolean;
  /** Where InternetAutomatedValuationDisplayYN = N on the subject's live listing withholds values (V6). */
  readonly avmFlagScope: 'all_client_outputs' | 'internet_display_only';
  /** The required valuation statement per state (USPS code), from counsel. None is shipped. */
  readonly statements: Readonly<Record<string, { readonly text: string; readonly minPointSize: number }>>;
  /** When counsel reviewed this section (ISO with offset); null ⇒ no client use. */
  readonly reviewedByCounselAt: string | null;
}

// ---- display ----------------------------------------------------------------------------------------

export interface PhotoRef {
  readonly url: string;
  /** `reference`: hot-link the feed URL; `rehost_allowed`: the pack allows copying it to our storage. */
  readonly mode: 'reference' | 'rehost_allowed';
}

/**
 * A listing as one audience may see it. A field the audience may not see is absent (undefined) and
 * named in `omittedFields`. An MLS listing always carries its brokerage and `isTeamListing: false`
 * (R-MLS-4), and a client/public one the pack's attribution and disclaimer (R-MLS-2).
 */
export interface DisplayListing {
  readonly audience: Audience;
  readonly id: ListingId | null;
  readonly source: ListingSource;
  readonly sourceLabel: 'MLS' | 'Team';
  readonly isTeamListing: boolean;
  readonly listingBrokerageName: string | null;
  readonly attribution: string | null;
  readonly disclaimer: string | null;
  /** True when the street address is withheld (not allowed for the audience, or InternetAddressDisplayYN false). */
  readonly addressHidden: boolean;
  readonly omittedFields: readonly DisplayField[];
  readonly mlsNumber?: string | null;
  readonly status?: ListingStatus;
  readonly listPriceCents?: number | null;
  readonly beds?: number | null;
  readonly bathsX10?: number | null;
  readonly sqft?: number | null;
  readonly propertyType?: PropertyType | null;
  readonly description?: string | null;
  readonly listDate?: string | null;
  readonly address?: { readonly line1: string; readonly line2: string | null };
  readonly locality?: { readonly city: string; readonly region: string; readonly postalCode: string };
  readonly photos?: readonly PhotoRef[];
  readonly closePriceCents?: number | null;
  readonly closeDate?: string | null;
  readonly yearBuilt?: number | null;
  readonly lotSqft?: number | null;
  readonly subdivisionName?: string | null;
}

// ---- competing set ----------------------------------------------------------------------------------

/**
 * Which listings compete with a subject. Only property and market facts: no radius, no
 * neighbourhood-character, school or demographic criteria, and nothing about people (fair housing).
 */
export interface CompetingRule {
  /** Same city (and region), same 5-digit postal code, or either. */
  readonly area: 'city' | 'postal_code' | 'city_or_postal_code';
  /** List price within ±pct of the subject's (0–100). Null: any price. A subject without a price then matches nothing. */
  readonly priceBandPct: number | null;
  /** Beds within ±n of the subject's. Null: any. A subject without beds then matches nothing. */
  readonly bedsDelta: number | null;
  /**
   * D12 (proposed, docs/AI_ISA.md §6.3; optional, additive): living area within ±pct of the subject's (0–100).
   * Absent or null: any size. A subject without a size then matches nothing.
   */
  readonly sqftBandPct?: number | null;
  /** Require the subject's property type. */
  readonly samePropertyType: boolean;
  /** Statuses that compete. */
  readonly statuses: readonly ListingStatus[];
  /** At most this many listings. */
  readonly maxCount: number;
  /** Drop MLS listings whose broker opted out of internet display (set for client-facing output, R-MLS-2). */
  readonly onlyDisplayAllowed: boolean;
  /** The MLS feed is stale (feedStale): MLS candidates pause and only team listings remain (R-MLS-3). */
  readonly mlsFeedStale: boolean;
}

export type CompetingCriterion = 'area' | 'price_band' | 'beds' | 'sqft_band' | 'property_type' | 'status';

/** Why a listing is in the competing set: one entry per (listing, criterion it met). */
export interface CriterionMatch {
  /** `listingIdentity(l)` of the competing listing. */
  readonly listing: string;
  readonly criterion: CompetingCriterion;
  readonly detail: string;
}

/** R-MLS-5 / E81: a mirrored team listing and its mls row disagree on status. */
export interface MirrorStatusMismatch {
  readonly teamListingId: ListingId;
  readonly mlsListing: string;
  readonly teamStatus: ListingStatus;
  readonly mlsStatus: ListingStatus;
}
