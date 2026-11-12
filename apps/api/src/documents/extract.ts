// documents.extract and the manual run (deliverable 6; R-DOC-2, R-AST-1, R-AST-19, E131, E159, E416-E418).
//
//   1. TX1 as the system: the document is clean, a PDF, deal-scoped, a contract kind, has no clean newer version and
//      has not been read yet; its bytes;
//   2. the extractor, outside any transaction, with the text in memory only (never stored, logged or sent to a model);
//   3. TX2: re-check, then ONE contract_extraction action (requires_approval, category contract, proposed, owned by
//      the uploader, contact NULL, dedupe contract_extraction:{documentId}) with one date_time claim per candidate:
//      verified (page + char-range evidence, plaintext snippet, verbatim_verified) or needs_review (E131, E417).
//      no_text / no_dates / unreadable write the action with no claims and the outcome's sentence (E159).
// No extractor, a photo, a listing or a contact document: nothing is written; the view says why (E418).
// Nothing extracted changes a deal date: a person confirms each claim through module 31 (confirm.ts).
import type { Actor, Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import type { Claim } from '@realty/core/assistant';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { insertAction } from '../assistant/repos/actions.js';
import { getObject } from '../crypto/objects.js';
import { COPY } from './copy.js';
import { decideCandidate } from './decide.js';
import { FINDER_VERSION, findContractDates, hasRelativeDeadline } from './finder.js';
import { EXTRACT_LIMITS, type ExtractResult } from './provider.js';
import { extractable, extractionDedupeKey } from './read.js';
import type { RunTx } from './scan.js';
import type { DocumentDeps } from './types.js';

export type ExtractOutcome = 'dates' | 'no_text' | 'no_dates' | 'unreadable';
export type ExtractRun = { result: 'not_configured' } | { result: 'not_eligible' } | { result: 'exists' } | { result: 'gone' } | { result: 'proposed'; outcome: ExtractOutcome; claims: number };

interface EligibleRow {
  id: string;
  deal_id: string;
  kind: string;
  uploaded_by_user_id: string;
  created_at: Date;
  object_id: string;
  storage_key: string;
  dek_wrapped: Buffer;
  content_type: string;
}

/** Clean, PDF, deal-scoped, a contract kind, no clean newer version, not read yet (as the caller sees it). */
async function eligible(tx: Tx, documentId: string): Promise<EligibleRow | null | 'exists'> {
  const r = await sql<EligibleRow>`
    SELECT d.id, d.deal_id, d.kind, d.uploaded_by_user_id, d.created_at, o.id AS object_id, o.storage_key, o.dek_wrapped, o.content_type
      FROM documents d JOIN stored_objects o ON o.tenant_id = d.tenant_id AND o.id = d.object_id
     WHERE d.tenant_id = app.tenant_id() AND d.id = ${documentId} AND d.scan_status = 'clean' AND d.deal_id IS NOT NULL
       AND o.purpose = 'document' AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL AND o.content_type = 'application/pdf'
       AND NOT EXISTS (
         WITH RECURSIVE down(id) AS (
           SELECT n.id FROM documents n WHERE n.tenant_id = d.tenant_id AND n.supersedes_id = d.id
           UNION SELECT n.id FROM down JOIN documents n ON n.tenant_id = d.tenant_id AND n.supersedes_id = down.id)
         SELECT 1 FROM down JOIN documents c ON c.tenant_id = d.tenant_id AND c.id = down.id WHERE c.scan_status = 'clean')`.execute(tx);
  const row = r.rows[0];
  if (!row || !extractable({ deal_id: row.deal_id, kind: row.kind as never, content_type: row.content_type })) return null;
  const a = await sql<{ id: string }>`SELECT id FROM assistant_actions WHERE tenant_id = app.tenant_id() AND dedupe_key = ${extractionDedupeKey(documentId)}`.execute(tx);
  return a.rows.length > 0 ? 'exists' : row;
}

export async function extractDocument(deps: DocumentDeps, actor: Actor, runTx: RunTx, documentId: string): Promise<ExtractRun> {
  const extractor = deps.providers.textExtractor;
  if (!extractor.configured) return { result: 'not_configured' };
  const tenantId = actor.tenantId as TenantId;
  const read = await runTx(async (tx) => {
    const e = await eligible(tx, documentId);
    if (e === null || e === 'exists') return e;
    const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, e.object_id, e.storage_key, new Uint8Array(e.dek_wrapped));
    return { row: e, bytes };
  });
  if (read === null) return { result: 'not_eligible' };
  if (read === 'exists') return { result: 'exists' };
  if (!read.bytes) return { result: 'gone' };
  // outside any transaction; a ProviderError propagates and the job retries. The text lives in memory only.
  const res = await extractor.extract(read.bytes, EXTRACT_LIMITS);
  read.bytes.fill(0);
  return runTx(async (tx) => {
    const e = await eligible(tx, documentId);
    if (e === null) return { result: 'not_eligible' } as const;
    if (e === 'exists') return { result: 'exists' } as const;
    return writeProposalInTx(tx, deps, { tenantId, documentId, dealId: e.deal_id, uploaderId: e.uploaded_by_user_id, uploadedAt: instantFromDate(e.created_at) }, res, { engine: extractor.version.split('/')[0] ?? 'extractor', version: extractor.version });
  });
}

export interface ProposalTarget {
  tenantId: string;
  documentId: string;
  dealId: string;
  uploaderId: string;
  uploadedAt: Instant;
}

/** The action and its claims (exported for the E131/E417 tests, which inject candidates). */
export async function writeProposalInTx(tx: Tx, deps: Pick<DocumentDeps, 'envelope' | 'ids'>, t: ProposalTarget, res: ExtractResult, extractor: { engine: string; version: string }, inject?: (pages: { page: number; text: string }[]) => ReturnType<typeof findContractDates>): Promise<ExtractRun> {
  const pages = res.status === 'text' ? res.pages : [];
  const textPages = pages.filter((p) => p.text.trim() !== '');
  const candidates = textPages.length > 0 ? (inject ?? findContractDates)(textPages) : [];
  const outcome: ExtractOutcome = res.status === 'unreadable' ? 'unreadable' : textPages.length === 0 ? 'no_text' : candidates.length === 0 ? 'no_dates' : 'dates';
  const claims: Claim[] = [];
  for (const [ordinal, c] of candidates.entries()) {
    const page = textPages.find((p) => p.page === c.page);
    const d = decideCandidate(c, page?.text ?? '', { documentId: t.documentId, uploadedAt: t.uploadedAt });
    claims.push({
      id: deps.ids.next<'AssistantClaimId'>(),
      ordinal,
      kind: 'date_time',
      text: `${c.label}: ${c.dueOn} (page ${c.page})`.slice(0, 300),
      structured: { milestone: { kind: c.kind, label: c.label, dueOn: c.dueOn }, page: c.page },
      evidence: [d.evidence],
      needsReview: !d.verified,
      reviewReasons: d.verified ? [] : [d.reason],
    });
  }
  const explanation = outcome === 'dates' ? COPY.extractionExplanation : outcome === 'no_text' ? COPY.noText : outcome === 'no_dates' ? COPY.noDates : COPY.unreadable;
  const inserted = await insertAction(tx, { envelope: deps.envelope as never, tenantId: t.tenantId, ids: deps.ids }, {
    id: deps.ids.next<'AssistantActionId'>(),
    contactId: null,
    kind: 'contract_extraction',
    category: 'contract',
    autonomy: 'requires_approval',
    playbookVersionId: null,
    status: 'proposed',
    ownerUserId: t.uploaderId,
    explanation,
    payload: { documentId: t.documentId, dealId: t.dealId, outcome, pageCount: pages.length, extractor, finder: FINDER_VERSION, relativeDeadlines: hasRelativeDeadline(textPages) },
    pinnedInboundSeq: null,
    boundOwnershipSeq: null,
    aiRunId: null,
    triggerRef: { documentId: t.documentId, dealId: t.dealId },
    dedupeKey: extractionDedupeKey(t.documentId),
    claims,
  });
  return inserted ? { result: 'proposed', outcome, claims: claims.length } : { result: 'exists' };
}
