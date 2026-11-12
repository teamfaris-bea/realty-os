// Types, strict input schemas and defaults of the comparable-sales valuation engine (module 70, D9).
//
// The engine values a home from the team's own MLS sold data: it is an estimate, never an appraisal,
// and it never calls a third-party AVM. Its inputs are property, transaction, time and location facts
// only (R-CMA-2). The three input schemas are strict: any other key (listing text, photos, a contact,
// demographics, schools, crime, a prediction) is refused at runtime. That is the fair-housing
// validator; the import-boundary test and the R-PRED-4 lint keep the same line in the code.
//
// Pure: no I/O, no clock, no randomness. Every money value is integer cents.
import { z } from 'zod';

/** Changing any field of CMA_DEFAULTS changes this (R-CMA-5); the defaults test pins the pair. */
export const CMA_METHOD_VERSION = 'cma/1';

/** The same union as core/listings PropertyType (checked by a test; this module imports nothing from listings). */
export const CMA_PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'manufactured', 'other'] as const;
export type CmaPropertyType = (typeof CMA_PROPERTY_TYPES)[number];

/** The same values as listings.sale_conditions (S0 CHECK) and core/listings SaleCondition (lane V1-A). */
export const CMA_SALE_CONDITIONS = ['standard', 'short_sale', 'reo', 'auction', 'probate', 'other'] as const;
export type CmaSaleCondition = (typeof CMA_SALE_CONDITIONS)[number];

/** The same union as core/listings ListingStatus. */
export const CMA_LISTING_STATUSES = ['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired'] as const;
export type CmaListingStatus = (typeof CMA_LISTING_STATUSES)[number];

/** Property types the engine values. Land and 'other' are not valued in V1 (owner question g). */
export const CMA_SUPPORTED_TYPES: readonly CmaPropertyType[] = Object.freeze(['single_family', 'condo', 'townhouse', 'multi_family', 'manufactured']);

/** Area tiers, narrowest first (R-CMA-2). */
export const CMA_TIERS = ['subdivision', 'within_1mi', 'postal_code', 'within_3mi', 'city'] as const;
export type CmaTier = (typeof CMA_TIERS)[number];

// ---------------------------------------------------------------- rule (every default VERIFY)

export interface CmaRule {
  /** First look-back, in months. VERIFY (agent lore: 3-6 months; Fannie B4-1.3-08 allows older sales with a reason). */
  readonly lookbackMonths: number;
  /** Second look-back, tried across every tier when the first finds too few. VERIFY. */
  readonly extendedLookbackMonths: number;
  /** Fewest comps that give a value (R-CMA-4). VERIFY. */
  readonly minComps: number;
  /** Comps used for the value. VERIFY. */
  readonly maxComps: number;
  /** Rows V1-C reads per tier; only used to word the "limit reached" sentence. VERIFY. */
  readonly tierLimit: number;
  /** Rows V1-C reads for the rate pool, and the most pool sales the engine fits rates on. VERIFY. */
  readonly ratePoolLimit: number;
  /** Months of sales in the rate pool. VERIFY. */
  readonly ratePoolMonths: number;
  /** A closed price below this looks like a rent or a data error (F13). VERIFY. */
  readonly minSalePriceCents: number;
  /** A closed price below this share of the original list price looks like an error (F13). VERIFY. */
  readonly minCloseToOriginalListBps: number;
  /** Size similarity: within this share of the subject's size. VERIFY (agent lore: +-20 %). */
  readonly sizeToleranceBps: number;
  /** Bedroom similarity: within this many bedrooms. VERIFY. */
  readonly bedsTolerance: number;
  /** Year-built similarity: within this many years. VERIFY. */
  readonly yearBuiltTolerance: number;
  /** "Within 1 mi" tier radius, in metres. VERIFY. */
  readonly nearRadiusM: number;
  /** "Within 3 mi" tier radius, and the subdivision tier's distance alternative to the postal code (F5). VERIFY. */
  readonly farRadiusM: number;
  /** Time trend: fewest pool sales. VERIFY. */
  readonly timeMinSales: number;
  /** Time trend: fewest distinct months. VERIFY. */
  readonly timeMinMonths: number;
  /** Feature rates: fewest pairs (F11). VERIFY. */
  readonly minPairs: number;
  /** Feature rates: fewest sales on each side (with/without, above/below the median) (F11). VERIFY. */
  readonly minSalesPerSide: number;
  /** Feature rates: fewest distinct values for a non-binary feature (F11). VERIFY. */
  readonly minDistinctValues: number;
  /** Size rate: pairs at least this many sq ft apart. VERIFY. */
  readonly sizePairMinDiffSqft: number;
  /** How many not-used sales are listed (the closest), besides every sale the agent excluded (always listed). */
  readonly notUsedLimit: number;
  /** Back-test: most sales tested. VERIFY. */
  readonly backtestMaxSales: number;
  /** Back-test: window of recent sales, in months before the valuation date. VERIFY. */
  readonly backtestWindowMonths: number;
  /** Back-test: fewest valued sales before a result is stated. VERIFY. */
  readonly backtestMinSales: number;
  /** Back-test: the "within" band, in basis points of the sale price. VERIFY. */
  readonly backtestWithinBps: number;
}

export const CMA_DEFAULTS: CmaRule = Object.freeze({
  lookbackMonths: 12, // VERIFY
  extendedLookbackMonths: 24, // VERIFY
  minComps: 3, // VERIFY
  maxComps: 6, // VERIFY
  tierLimit: 300, // VERIFY
  ratePoolLimit: 600, // VERIFY
  ratePoolMonths: 24, // VERIFY
  minSalePriceCents: 1_000_000, // $10,000. VERIFY
  minCloseToOriginalListBps: 2_000, // 20 %. VERIFY
  sizeToleranceBps: 2_000, // +-20 %. VERIFY
  bedsTolerance: 1, // VERIFY
  yearBuiltTolerance: 25, // VERIFY
  nearRadiusM: 1_609, // 1 mi. VERIFY
  farRadiusM: 4_828, // 3 mi. VERIFY
  timeMinSales: 30, // VERIFY
  timeMinMonths: 6, // VERIFY
  minPairs: 30, // VERIFY
  minSalesPerSide: 10, // VERIFY
  minDistinctValues: 3, // VERIFY
  sizePairMinDiffSqft: 50, // VERIFY
  notUsedLimit: 50,
  backtestMaxSales: 50, // VERIFY
  backtestWindowMonths: 6, // VERIFY
  backtestMinSales: 10, // VERIFY
  backtestWithinBps: 1_000, // 10 %. VERIFY
});

// ---------------------------------------------------------------- strict input schemas (fair housing)

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(5, 7));
    const d = Number(s.slice(8, 10));
    if (m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }, 'not a calendar date');
const Cents = z.number().int().min(0).max(100_000_000_000);
const Count = z.number().int().min(0).max(1_000_000_000);
const Text = z.string().max(200);
const Lat = z.number().int().min(-90_000_000).max(90_000_000);
const Lon = z.number().int().min(-180_000_000).max(180_000_000);

/** A comp's reference. `identity` is V1-C's listingIdentity (one per home listing across team and MLS rows). */
export const CmaRefSchema = z.strictObject({
  identity: z.string().min(1).max(200),
  source: z.enum(['team', 'mls']),
  teamListingId: z.string().min(1).max(200).nullable(),
  mlsNumber: z.string().min(1).max(200).nullable(),
  connectionId: z.string().min(1).max(200).nullable(),
});

const PropertyFacts = {
  propertyType: z.enum(CMA_PROPERTY_TYPES).nullable(),
  sqft: Count.nullable(),
  /** The RESO field sqft was read from; sizes are compared only like with like (V3). */
  sizeSource: Text.nullable(),
  beds: z.number().int().min(0).max(1_000).nullable(),
  bathsX10: z.number().int().min(0).max(10_000).nullable(),
  yearBuilt: z.number().int().min(1600).max(2100).nullable(),
  lotSqft: Count.nullable(),
  garageSpacesX10: z.number().int().min(0).max(10_000).nullable(),
  poolPrivate: z.boolean().nullable(),
  storiesX10: z.number().int().min(0).max(10_000).nullable(),
  latE6: Lat.nullable(),
  lonE6: Lon.nullable(),
  postalCode: Text.nullable(),
  city: Text.nullable(),
  region: Text.nullable(),
  subdivisionName: Text.nullable(),
  addressKey: Text.nullable(),
} as const;

/** The home being valued. Only propertyType and sqft are required to value it (F15). */
export const CmaSubjectSchema = z.strictObject({
  ...PropertyFacts,
  /** listingIdentity values of the subject's own listings (team rows and MLS mirrors). */
  ownIdentities: z.array(z.string().min(1).max(200)).max(100),
  /** MLS numbers the subject has been listed under. */
  ownMlsNumbers: z.array(z.string().min(1).max(200)).max(100),
});

/** One sale (or other listing record) offered as a possible comparable. */
export const CmaSaleSchema = z.strictObject({
  status: z.enum(CMA_LISTING_STATUSES),
  closePriceCents: Cents.nullable(),
  closeDate: IsoDate.nullable(),
  contractDate: IsoDate.nullable(),
  listPriceCents: Cents.nullable(),
  originalListPriceCents: Cents.nullable(),
  concessionsCents: Cents.nullable(),
  /** `[]` = not recorded. */
  saleConditions: z.array(z.enum(CMA_SALE_CONDITIONS)).max(CMA_SALE_CONDITIONS.length),
  isLease: z.boolean(),
  ...PropertyFacts,
  daysOnMarket: Count.nullable(),
});

export const CmaCandidateSchema = z.strictObject({ ref: CmaRefSchema, sale: CmaSaleSchema });

export const CmaTierReadSchema = z.strictObject({
  tier: z.enum([...CMA_TIERS, 'rate_pool']),
  limitReached: z.boolean(),
});

export type CmaRef = Readonly<z.infer<typeof CmaRefSchema>>;
export type CmaSubject = Readonly<z.infer<typeof CmaSubjectSchema>>;
export type CmaSale = Readonly<z.infer<typeof CmaSaleSchema>>;
export interface CmaCandidate {
  readonly ref: CmaRef;
  readonly sale: CmaSale;
}
export interface CmaTierRead {
  readonly tier: CmaTier | 'rate_pool';
  readonly limitReached: boolean;
}

export interface PrepareCmaInput {
  readonly subject: CmaSubject;
  readonly candidates: readonly CmaCandidate[];
  readonly tierReads: readonly CmaTierRead[];
  /** ISO date (YYYY-MM-DD) the value is as of. Supplied by the caller (core reads no clock). */
  readonly valuationDate: string;
  /** Overrides of CMA_DEFAULTS. A result made with any override carries a different method version. */
  readonly rule?: Partial<CmaRule>;
  /** identities the agent adds after seeing why they were not used (sale condition or plausibility only). */
  readonly include?: readonly string[];
  /** identities the agent removes from the comps. */
  readonly exclude?: readonly string[];
}

// ---------------------------------------------------------------- result

export type NotUsedReason =
  | 'not_sold'
  | 'no_close_price'
  | 'no_close_date'
  | 'after_valuation_date'
  | 'too_old'
  | 'lease'
  | 'other_property_type'
  | 'other_size_source'
  | 'no_size'
  | 'subject_listing'
  | 'subject_address'
  | 'duplicate'
  | 'sale_condition'
  | 'implausible_price'
  | 'excluded_by_agent'
  | 'outside_area'
  | 'size_not_similar'
  | 'beds_not_similar'
  | 'year_built_not_similar'
  | 'not_among_closest';

export interface NotUsedView {
  readonly ref: CmaRef;
  readonly reason: NotUsedReason;
  /** The sale conditions that kept it out, for reason 'sale_condition'. */
  readonly conditions: readonly CmaSaleCondition[];
  readonly distanceM: number | null;
  /** True when the agent may add it back (sale condition or plausibility only). */
  readonly includable: boolean;
  readonly sentence: string;
}

export type AdjustmentFeature = 'time' | 'size' | 'beds' | 'baths' | 'garage' | 'pool' | 'year_built' | 'lot' | 'stories' | 'concessions';

/** Support of a rate in sales, not only pairs (F11). */
export interface RateSupport {
  readonly kind: 'with_without' | 'above_below' | 'sales_months' | 'none';
  /** with / above / sales. */
  readonly first: number;
  /** without / below / distinct months. */
  readonly second: number;
  readonly pairs: number;
}

export interface Adjustment {
  readonly feature: AdjustmentFeature;
  /** The subject's value in the feature's stored unit (months for time: the comp's months before the valuation date). */
  readonly subjectValue: number | null;
  readonly compValue: number | null;
  /** Per stored unit: cents (size, features), basis points a month (time), null (concessions). */
  readonly rate: number | null;
  readonly amountCents: number;
  readonly support: RateSupport;
  readonly sentence: string;
}

export interface CompView {
  readonly ref: CmaRef;
  readonly sale: CmaSale;
  /** The narrowest tier the sale is in; null for a sale the agent added from outside the tiers. */
  readonly tier: CmaTier | null;
  readonly distanceM: number | null;
  readonly includedByAgent: boolean;
  /** The labels a client rendering keeps with the comp, e.g. "short sale". */
  readonly labels: readonly string[];
  readonly adjustments: readonly Adjustment[];
  readonly adjustedPriceCents: number;
  /** Sum of |adjustment| in basis points of the close price (ranking, and shown). */
  readonly grossAdjustmentBps: number;
  /** The same without the size adjustment: the weights read this (F12, see adjust.ts adjustedPrice). */
  readonly weightBasisBps: number;
  /** The comp's weight in the value, in basis points (the weights sum to 10,000). */
  readonly weightBps: number;
  readonly why: readonly string[];
}

export interface AreaView {
  /** The narrowest tier that held enough comps, else the widest tried (null when no tier applies). */
  readonly tier: CmaTier | null;
  readonly lookbackMonths: number;
  readonly tiersSkipped: readonly CmaTier[];
  readonly tierReads: readonly CmaTierRead[];
  readonly sentences: readonly string[];
}

export interface RateView {
  readonly feature: Exclude<AdjustmentFeature, 'concessions'>;
  readonly applied: boolean;
  /** Per stored unit (see Adjustment.rate); null when it could not be measured. */
  readonly rate: number | null;
  readonly support: RateSupport;
  readonly sentence: string;
}

export interface MarketView {
  /** The rate pool's area tier (the reached tier widened to at least the postal code). */
  readonly poolTier: CmaTier | null;
  readonly poolMonths: number;
  readonly poolSales: number;
  readonly rates: readonly RateView[];
  readonly sentences: readonly string[];
}

/** Evidence, not a score (R-AST-13): how close the same method came on recent local sales, out of sample. */
export interface BacktestView {
  readonly salesTested: number;
  readonly notValued: number;
  readonly medianMissBps: number | null;
  readonly within10PctBps: number | null;
  readonly windowStart: string;
  readonly sentence: string;
}

export interface SubjectSaleView {
  readonly ref: CmaRef;
  readonly closeDate: string | null;
  readonly closePriceCents: number | null;
  readonly status: CmaListingStatus;
}

export type CmaUnavailableReason = 'NO_SALES' | 'INSUFFICIENT_COMPS' | 'SUBJECT_INCOMPLETE' | 'SUBJECT_TYPE_NOT_SUPPORTED';

interface CmaResultCommon {
  readonly methodVersion: string;
  readonly valuationDate: string;
  readonly comps: readonly CompView[];
  readonly notUsed: readonly NotUsedView[];
  /** How many candidates were not used (notUsed lists the closest notUsedLimit, and every sale the agent excluded). */
  readonly notUsedTotal: number;
  /** The subject's own earlier sales, matched by listing or address key (E365). Never comps. */
  readonly subjectSales: readonly SubjectSaleView[];
  readonly area: AreaView;
  readonly market: MarketView;
  readonly backtest: BacktestView;
  /** Plain sentences an agent reads first (filters skipped, older sales, unavailable reason). */
  readonly sentences: readonly string[];
}

export interface CmaAvailable extends CmaResultCommon {
  readonly available: true;
  readonly valueCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly closeDateSpan: { readonly earliest: string; readonly latest: string };
  readonly distanceSpanM: { readonly min: number; readonly max: number } | null;
}

export interface CmaUnavailable extends CmaResultCommon {
  readonly available: false;
  readonly reason: CmaUnavailableReason;
}

export type CmaResult = CmaAvailable | CmaUnavailable;
