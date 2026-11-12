// The one seam between module 71 (api/cma) and the modules it calls but does not own (PHASE2_3_PLAN §5.3). Every other
// file in apps/api/src/cma takes these names from here.
//
// From lane V1-A (core/listings, api/mls): addressKey, streetOfKey and cellsWithin, the USPS code of a state
// (uspsCode), the licence pack's valuation section (LicensePack.valuation, read by valuationEligible and
// valuationStatement), the client sold fields (DISPLAY_FIELDS closePrice/closeDate, rendered by applyDisplayRules
// through clientView and clientSoldView), soldCandidates (TierQuery / SoldQuery), mlsRowsAtAddress, liveNearMatches,
// and a row's valuation facts (ListingRow, factsOfRow).
// From lane V1-B (core/valuation): prepareCma, CMA_DEFAULTS, CMA_METHOD_VERSION, the tiers and property types, the
// strict CmaSubject / CmaSale / CmaRef schemas, and the date and place keys the engine itself uses.
//
// The only code here adapts one shape to the other: a listings row to the engine's sale (saleOfRow) and V1-A's tier
// names to V1-B's (ENGINE_TIER). Neither re-implements a rule of either lane.
import type { CmaSale, CmaTier } from '@realty/core/valuation';
import type { SoldTier } from '../mls/comps.js';
import { type ListingRow, factsOfRow } from '../mls/eligibility.js';

export { addressKey, cellsWithin, streetOfKey, uspsCode, valuationStatement, EMPTY_VALUATION_FACTS } from '@realty/core/listings';
export {
  LISTING_COLS,
  type ListingRow,
  type MlsConnectionFacts,
  type MlsEligibility,
  clientSoldView,
  clientView,
  connectionClientEligible,
  factsOfRow,
  mlsEligibility,
  valuationEligible,
  type ValuationRefusal,
} from '../mls/eligibility.js';
export { liveNearMatches, mlsRowsAtAddress, soldCandidates, type SoldCandidates, type SoldQuery, type SoldTier, type TierQuery } from '../mls/comps.js';
export {
  prepareCma,
  addMonths,
  postalKey,
  subdivisionKey,
  CMA_DEFAULTS,
  CMA_METHOD_VERSION,
  CMA_PROPERTY_TYPES,
  CMA_SUPPORTED_TYPES,
  CMA_TIERS,
  CmaCandidateSchema,
  CmaSubjectSchema,
  type CmaCandidate,
  type CmaPropertyType,
  type CmaRef,
  type CmaResult,
  type CmaSale,
  type CmaSubject,
  type CmaTier,
} from '@realty/core/valuation';

/** V1-A's tier read names → V1-B's tier names (the same areas: V1-A reads geo cells, V1-B measures the real distance). */
export const ENGINE_TIER: Readonly<Record<SoldTier, CmaTier | 'rate_pool'>> = Object.freeze({
  subdivision: 'subdivision',
  cells_1mi: 'within_1mi',
  postal_code: 'postal_code',
  cells_3mi: 'within_3mi',
  city: 'city',
  rate_pool: 'rate_pool',
});

/**
 * A listings row as the engine's sale: V1-A's facts and valuation facts, field for field (V1-B validates it strictly).
 * For a mirrored team sale (E366, R-MLS-5) pass the team row too: its property type, list price, beds and baths win
 * where it has them; the close price and every sale fact, the size and its source, and the location are the MLS
 * mirror's (a team row carries no valuation facts: only the MLS sync writes them).
 */
export function saleOfRow(r: ListingRow, team: ListingRow | null = null): CmaSale {
  const f = factsOfRow(r);
  const t = team === null ? null : factsOfRow(team);
  const v = f.valuation;
  return {
    status: f.status,
    closePriceCents: v.closePriceCents,
    closeDate: v.closeDate,
    contractDate: v.contractDate,
    listPriceCents: t?.listPriceCents ?? f.listPriceCents,
    originalListPriceCents: v.originalListPriceCents,
    concessionsCents: v.concessionsCents,
    saleConditions: [...v.saleConditions],
    isLease: v.isLease,
    propertyType: t?.propertyType ?? f.propertyType,
    sqft: f.sqft,
    sizeSource: v.sizeSource,
    beds: t?.beds ?? f.beds,
    bathsX10: t?.bathsX10 ?? f.bathsX10,
    yearBuilt: v.yearBuilt,
    lotSqft: v.lotSqft,
    garageSpacesX10: v.garageSpacesX10,
    poolPrivate: v.poolPrivate,
    storiesX10: v.storiesX10,
    latE6: v.latitudeE6,
    lonE6: v.longitudeE6,
    postalCode: f.postalCode,
    city: f.city,
    region: f.region,
    subdivisionName: v.subdivisionName,
    addressKey: r.address_key,
    daysOnMarket: v.daysOnMarket,
  };
}
