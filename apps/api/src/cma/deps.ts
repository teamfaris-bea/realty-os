// The one seam between module 71 (api/cma) and the modules it calls but does not own (PHASE2_3_PLAN §5.3).
//
// From lane V1-A (core/listings, api/mls): addressKey, geoCell, valuationUse, soldCandidates, mlsRowsAtAddress,
// liveNearMatches, the valuation facts of a row, clientSoldView. From lane V1-B (core/valuation): prepareCma, the
// CmaRef / CmaSubject / CmaSale schemas and CMA_DEFAULTS.
//
// V1-C starts with V1-A and V1-B from the same base (base/cma), so until they merge these names come from
// ./interim/** — stand-ins with the same names and contracts, built only so this module can be written and tested
// against real Postgres. At the merge (the orchestrator's word) every line below is re-pointed at the real module and
// ./interim/** is deleted; nothing else in apps/api/src/cma imports ./interim directly. Tracked in the lane report.
import { type DisplayListing, applyDisplayRules } from '@realty/core/listings';
import type { MlsEligibility } from '../mls/eligibility.js';
import { factsOfRow } from '../mls/eligibility.js';
import { soldFieldsAllowed } from './interim/pack.js';
import type { ValuationRow } from './interim/sold.js';

export { addressKey, geoCell, uspsState, distanceMiles, type AddressParts } from './interim/address.js';
export { valuationUse, soldFieldsAllowed, STRICTEST_VALUATION_USE, type ValuationUse, type AvmFlagScope } from './interim/pack.js';
export { soldCandidates, mlsRowsAtAddress, liveNearMatches, listingRow, listingRows, mirrorsOf, saleOfRow, LIVE_STATUSES, type ValuationRow, type SoldRead } from './interim/sold.js';
export {
  prepareCma,
  monthsBefore,
  CMA_DEFAULTS,
  CMA_METHOD_VERSION,
  CMA_TIERS,
  CMA_PROPERTY_TYPES,
  CmaSubjectSchema,
  CmaSubjectFactsSchema,
  CmaRefSchema,
  CmaSaleSchema,
  type CmaSubject,
  type CmaSubjectFacts,
  type CmaRef,
  type CmaSale,
  type CmaCandidate,
  type CmaResult,
  type CmaTier,
  type CmaPropertyType,
  type TierRead,
} from './interim/valuation.js';

/**
 * The client rendering of an MLS sold row (V1-A: applyDisplayRules with the sold fields; clientSoldView for a mirrored
 * team sale), or null when it must not reach a client now. A mirror is judged as the MLS row it is: the sold price and
 * date are MLS data even when the team row is the authority for the listing (E366).
 */
export function clientSoldView(e: MlsEligibility, storedPacks: ReadonlyMap<string, unknown>, mlsRow: ValuationRow): DisplayListing | null {
  if (mlsRow.source !== 'mls' || mlsRow.mls_connection_id === null || !e.clientIds.includes(mlsRow.mls_connection_id) || !mlsRow.display_allowed) return null;
  if (!soldFieldsAllowed(storedPacks.get(mlsRow.mls_connection_id))) return null;
  return applyDisplayRules({ ...factsOfRow(mlsRow), teamListingId: null }, e.pack(mlsRow.mls_connection_id)!, 'client');
}
