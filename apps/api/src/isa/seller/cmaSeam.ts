// The one seam between the AI ISA's seller part (apps/api/src/isa/seller, ISA-3) and module 71 (api/cma, lanes V1-C,
// V2-A, V2-B) plus module 24's reads that module 71 already exposes through cma/deps.ts. Every CMA import of
// isa/seller goes through this file, so a change of a CMA export is a one-file change here. The architecture test
// (architecture.test.ts) proves that the pipeline is re-exported only here and called only in comps.ts, and that no
// other non-test isa file names the sold fields.
//
// STUB(V2-A): `printable` and `statementProminence` are V2-A's statement.ts exports (not in the tree). Until V2-A
// merges they refuse every statement, so no comps email can be built (CMA_STATEMENT_NOT_RENDERABLE). Tests inject a
// double through SellerDeps.statement. Switch: replace the two stand-ins below with
// `export { printable, statementProminence } from '../../cma/statement.js';`.
import type { DisplayListing } from '@realty/core/listings';
import { type ListingRow, type MlsEligibility, clientSoldView, clientView } from '../../cma/deps.js';

export { compsForSubjectInTx, type CompsForSubject, type RefListing, type StoredResult, type SubjectRecord } from '../../cma/service.js';
export { AI_ISA_SELLER_PACK, CMA_PLATFORM_PACK, type Blocker, type ClientShare, type CmaConnections, clientReadiness, nearMatches, readinessConnections } from '../../cma/gates.js';
export { type ResolvedSubject, newest, resolveSubject } from '../../cma/subject.js';
export { connectionSizeField, defaultAddress, platformCleared, listingRows } from '../../cma/repos.js';
export {
  LISTING_COLS,
  type ListingRow,
  type MlsConnectionFacts,
  type MlsEligibility,
  addressKey,
  factsOfRow,
  liveNearMatches,
  mlsEligibility,
  mlsRowsAtAddress,
  streetOfKey,
  valuationEligible,
  valuationStatement,
} from '../../cma/deps.js';
export { filterSkippedSentence, tierName, tierReachedSentence, tierSkippedSentence, CMA_DEFAULTS } from '@realty/core/valuation';

/**
 * The client rendering of an MLS row with its sold fields where shown: a mirrored team sale through clientSoldView
 * with its team row (E366), else clientView. Kept here so no other seller file names clientSoldView.
 */
export function clientRendering(e: MlsEligibility, row: ListingRow, team: ListingRow | null): DisplayListing | null {
  if (team !== null) return clientSoldView(e, row, team);
  return clientView(e, row);
}

/** A rendered statement V2-A's rules allow in an email: the text at a point size of at least `pointSize`. */
export interface StatementRendering {
  ok: boolean;
  code: 'CMA_STATEMENT_NOT_RENDERABLE' | 'EMAIL_TYPE_SIZE' | null;
  pointSize: number;
}

/** STUB(V2-A): whether a statement can be printed in the channel. Refuses every statement until V2-A merges. */
export function printable(_text: string, _channel: 'email' | 'pdf'): boolean {
  return false;
}

/** STUB(V2-A): the prominence (point size) a statement must have: max(12, minPointSize); V2-A refuses email above 12 pt. */
export function statementProminence(minPointSize: number): StatementRendering {
  const pointSize = Math.max(12, minPointSize);
  return { ok: false, code: 'CMA_STATEMENT_NOT_RENDERABLE', pointSize };
}
