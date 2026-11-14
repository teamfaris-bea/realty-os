// The one seam between the AI ISA's seller part (apps/api/src/isa/seller, ISA-3) and module 71 (api/cma, lanes V1-C,
// V2-A, V2-B) plus module 24's reads that module 71 already exposes through cma/deps.ts. Every CMA import of
// isa/seller goes through this file, so a change of a CMA export is a one-file change here. The architecture test
// (architecture.test.ts) proves that the pipeline and the statement rules are re-exported only here and called only in
// comps.ts, and that no other non-test isa file names the sold fields.
//
// The statement rules are V2-A's own (cma/statement.ts; R-CMA-9 "Statements", E604, E605), applied as V2-A's share
// email applies them (cma/report.ts buildReport, then refusalFor(report, 'email')): see emailStatementRendering below.
// statement.test.ts pins it to refusalFor over a table of statements, attributions and disclaimers. Batch 16 replaced
// the two stand-ins that refused every statement until V2-A merged.
import type { DisplayListing } from '@realty/core/listings';
import { type ListingRow, type MlsEligibility, SIZE, clientSoldView, clientView } from '../../cma/deps.js';
import { type Prominence, canonicalText, emailStatementOk, printable, statementProminence } from '../../cma/statement.js';

export { compsForSubjectInTx, type CompsForSubject, type RefListing, type StoredResult, type SubjectRecord } from '../../cma/service.js';
export { AI_ISA_PACK, AI_ISA_SELLER_PACK, CMA_PLATFORM_PACK, type Blocker, type ClientShare, type CmaConnections, clientReadiness, nearMatches, notLivingAreaSize, readinessConnections } from '../../cma/gates.js';
export { type ResolvedSubject, newest, resolveSubject } from '../../cma/subject.js';
export { connectionSizeField, defaultAddress, platformCleared, listingRows } from '../../cma/repos.js';
export {
  LISTING_COLS,
  type ListingRow,
  type MlsConnectionFacts,
  type MlsEligibility,
  addressKey,
  connectionClientEligible,
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

export { EMAIL_MAX_STATEMENT_POINT_SIZE, canonicalText } from '../../cma/statement.js';

/** A statement as the licence pack records it for the subject's state (valuationStatement). */
export interface LicenceStatement {
  text: string;
  minPointSize: number;
}

/** A statement a plain-text email may carry: its canonical text and the prominence V2-A gives it. */
export interface RenderedStatement {
  /** NFC, CRLF made LF, trimmed: the text V2-A judges and sends (canonicalText) */
  text: string;
  /** the strictest minimum of the statements that share this text */
  minPointSize: number;
  prominence: Prominence;
  pointSize: number;
}

/**
 * What a comps email may carry under V2-A's share-email rules, or the refusal (as report.ts's Refusal: the part, and the
 * code points a substitution would change).
 */
export type StatementRendering =
  | { ok: true; statements: RenderedStatement[]; attributions: string[]; disclaimers: string[] }
  | { ok: false; code: 'CMA_STATEMENT_NOT_RENDERABLE' | 'EMAIL_TYPE_SIZE'; part: 'statement' | 'attribution' | 'disclaimer'; codePoints?: string[] };

const unique = (xs: readonly string[]) => [...new Set(xs.map((x) => canonicalText(x).trim()).filter((x) => x !== ''))];

/**
 * V2-A's statement rules for an email (R-CMA-9 "Statements"; E604, E605), in report.ts's order and over its exports
 * (statement.ts printable, statementProminence, emailStatementOk):
 *   1. the statements once per canonical text, each with the strictest minimum of those that share it (buildReport);
 *   2. a statement the PDF renderer would substitute: CMA_STATEMENT_NOT_RENDERABLE, naming its code points;
 *   3. a minimum above 12 pt (EMAIL_MAX_STATEMENT_POINT_SIZE, or not a number): EMAIL_TYPE_SIZE, since a plain-text email
 *      carries no type size (owner question e);
 *   4. an attribution, then a disclaimer, that would be substituted: CMA_STATEMENT_NOT_RENDERABLE.
 * Each statement's prominence is statementProminence(min), or display when none is large enough (buildReport's); an
 * email statement is always at body, 12 pt. VERIFY WITH COUNSEL / MLS (the statements and their sizes, C6, V4).
 */
export function emailStatementRendering(i: { statements: readonly LicenceStatement[]; attributions: readonly string[]; disclaimers: readonly string[] }): StatementRendering {
  const mins = new Map<string, number>();
  for (const s of i.statements) {
    const t = canonicalText(s.text).trim();
    if (t === '') continue;
    mins.set(t, Math.max(mins.get(t) ?? -Infinity, s.minPointSize));
  }
  for (const t of mins.keys()) {
    const p = printable(t);
    if (!p.ok) return { ok: false, code: 'CMA_STATEMENT_NOT_RENDERABLE', part: 'statement', codePoints: p.codePoints };
  }
  if ([...mins.values()].some((m) => !emailStatementOk(m))) return { ok: false, code: 'EMAIL_TYPE_SIZE', part: 'statement' };
  const attributions = unique(i.attributions);
  const disclaimers = unique(i.disclaimers);
  for (const [part, texts] of [['attribution', attributions], ['disclaimer', disclaimers]] as const) {
    for (const t of texts) {
      const p = printable(t);
      if (!p.ok) return { ok: false, code: 'CMA_STATEMENT_NOT_RENDERABLE', part, codePoints: p.codePoints };
    }
  }
  const statements = [...mins].map(([text, minPointSize]) => {
    const prominence = statementProminence(minPointSize) ?? 'display';
    return { text, minPointSize, prominence, pointSize: SIZE[prominence]! };
  });
  return { ok: true, statements, attributions, disclaimers };
}

/** The stored price of a fact's kind (H3's re-check): the sale price for a sold fact, else the asking price. */
export function storedPriceOf(row: ListingRow, kind: string | null): string | null {
  const v = kind === 'sold' ? row.close_price_cents : row.list_price_cents;
  return v === null || v === undefined ? null : String(v);
}
