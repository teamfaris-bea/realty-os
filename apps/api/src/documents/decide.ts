// decideCandidate (deliverable 6; R-AST-1, R-AST-2, R-DOC-2, E131, E417): pure. A candidate becomes a verified claim
// only when its snippet is found verbatim at its own character range of its own page (core verifyQuote with a
// char_range locator) AND the last date written in the snippet is the candidate's date. Anything else is a
// needs_review claim, which is never a date (the database agrees: 0069 deal_dates_evidence_guard).
import { type CheckedEvidenceRef, type Locator, verifyQuote } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import { type Candidate, datesIn } from './finder.js';

export interface DecideCtx {
  documentId: string;
  uploadedAt: Instant;
}

export type Decision = { verified: true; evidence: CheckedEvidenceRef } | { verified: false; evidence: CheckedEvidenceRef; reason: 'QUOTE_NOT_VERIFIED' | 'DATE_MISMATCH' };

/** The stored locator (the page rides along; core's char_range locator reads start/end on the page's text). */
export type DocumentLocator = { kind: 'char_range'; page: number; start: number; end: number };

export function decideCandidate(c: Candidate, pageText: string, ctx: DecideCtx): Decision {
  const locator = { kind: 'char_range', page: c.page, start: c.start, end: c.end } satisfies DocumentLocator;
  const ref = { sourceType: 'document' as const, sourceId: ctx.documentId, locator: locator as Locator, snippet: c.snippet };
  const q = verifyQuote({ kind: 'text', sourceType: 'document', sourceId: ctx.documentId, text: pageText, at: ctx.uploadedAt, author: 'client' }, ref);
  if (!q.verified) return { verified: false, evidence: { ...ref, verified: false, reason: q.reason }, reason: 'QUOTE_NOT_VERIFIED' };
  const dates = datesIn(c.snippet);
  const last = dates[dates.length - 1];
  if (!last || last.iso !== c.dueOn) return { verified: false, evidence: { ...ref, verified: true }, reason: 'DATE_MISMATCH' };
  return { verified: true, evidence: { ...ref, verified: true } };
}
