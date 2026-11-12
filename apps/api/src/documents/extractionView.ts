// GET /documents/:id/extraction (deliverable 6; R-AST-2, R-DOC-2, E412, E413, E416, E418): the action, its claims
// and their evidence, each claim beside the deal's live dates of the same kind, and the date it was applied to (read
// from deal_dates.evidence_claim_id, never inferred). Visible to whoever sees the action (its owner, the uploader,
// and tenant-wide roles); another member sees the confirmed dates on the deal, not the extraction (404).
import { formatEvidence, type Locator } from '@realty/core/assistant';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { COPY } from './copy.js';
import type { DocumentLocator } from './decide.js';
import type { ExtractOutcome } from './extract.js';
import { type ReadCtx, documentView, extractionAction, platformState } from './read.js';
import * as R from './repos.js';

export interface ExtractionClaimView {
  id: string;
  ordinal: number;
  text: string;
  milestone: { kind: string; label: string; dueOn: string } | null;
  page: number | null;
  needsReview: boolean;
  reviewNote: string | null;
  reviewStatus: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected';
  evidence: { sourceType: 'document'; locator: DocumentLocator; snippet: string | null; verified: boolean; line: string | null }[];
  liveDates: { dateId: string; label: string | null; dueOn: string; status: string; source: string }[];
  appliedDateId: string | null;
  appliedNote: string | null;
}

export async function extractionView(tx: Tx, documentId: string, ctx: ReadCtx) {
  const d = await R.docById(tx, documentId);
  if (!d) throw new AppError('NOT_FOUND');
  const platform = await platformState(tx, ctx);
  const document = await documentView(tx, d, ctx, platform.portalCleared);
  const a = await extractionAction(tx, documentId);
  if (!a) {
    if (document.extraction.status === 'not_visible') throw new AppError('NOT_FOUND');
    return { document, action: null, claims: [] as ExtractionClaimView[], relativeDeadlineText: null as string | null, platform };
  }
  const claims = await sql<{ id: string; ordinal: number; text: string; structured: { milestone?: { kind: string; label: string; dueOn: string }; page?: number } | null; needs_review: boolean; review_status: ExtractionClaimView['reviewStatus'] }>`
    SELECT id, ordinal, text, structured, needs_review, review_status FROM assistant_claims
     WHERE tenant_id = app.tenant_id() AND action_id = ${a.id} ORDER BY ordinal`.execute(tx);
  const ev = await sql<{ claim_id: string; source_type: string; source_id: string; locator: Record<string, unknown>; snippet: string | null; verbatim_verified: boolean }>`
    SELECT e.claim_id, e.source_type, e.source_id, e.locator, e.snippet, e.verbatim_verified FROM evidence_refs e
     WHERE e.tenant_id = app.tenant_id() AND e.claim_id IN (SELECT id FROM assistant_claims WHERE tenant_id = app.tenant_id() AND action_id = ${a.id})
     ORDER BY e.created_at, e.id`.execute(tx);
  const dates = d.deal_id
    ? (await sql<{ id: string; kind: string; label: string | null; due_on: string; status: string; source: string; evidence_claim_id: string | null; completed_at: Date | null }>`
        SELECT id, kind, label, due_on::text AS due_on, status, source, evidence_claim_id, completed_at FROM deal_dates
         WHERE tenant_id = app.tenant_id() AND deal_id = ${d.deal_id} ORDER BY due_on, id`.execute(tx)).rows
    : [];
  const out: ExtractionClaimView[] = claims.rows.map((c) => {
    const m = c.structured?.milestone ?? null;
    const applied = dates.find((x) => x.evidence_claim_id === c.id) ?? null;
    return {
      id: c.id,
      ordinal: c.ordinal,
      text: c.text,
      milestone: m,
      page: c.structured?.page ?? null,
      needsReview: c.needs_review,
      reviewNote: c.needs_review ? COPY.needsReview : null,
      reviewStatus: c.review_status,
      evidence: ev.rows
        .filter((e) => e.claim_id === c.id)
        .map((e) => ({
          sourceType: 'document' as const,
          locator: e.locator as unknown as DocumentLocator,
          snippet: e.snippet,
          verified: e.verbatim_verified,
          line: e.snippet === null ? null : formatEvidence({ sourceType: 'document', sourceId: e.source_id, locator: e.locator as unknown as Locator, snippet: e.snippet }),
        })),
      liveDates: m ? dates.filter((x) => x.kind === m.kind && x.completed_at === null).map((x) => ({ dateId: x.id, label: x.label, dueOn: x.due_on, status: x.status, source: x.source })) : [],
      appliedDateId: applied?.id ?? null,
      appliedNote: applied && m && applied.due_on !== m.dueOn ? COPY.movedByPerson : null,
    };
  });
  const payload = a.payload as { outcome?: ExtractOutcome; relativeDeadlines?: boolean };
  return {
    document,
    action: { id: a.id, status: a.status, outcome: (payload.outcome ?? null) as ExtractOutcome | null, text: document.extraction.text },
    claims: out,
    relativeDeadlineText: payload.relativeDeadlines ? COPY.relativeDeadline : null,
    platform,
  };
}
