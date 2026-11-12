// Claim decisions through module 31 (deliverable 7; R-TXN-1, R-TXN-2, R-AST-1, R-AST-21, R-DOC-10, E412-E415).
//
// POST /documents/:id/extraction/claims/:claimId/confirm, as the person (milestone.confirm on the deal):
//   1. the claim, locked, must belong to this document's contract_extraction (RLS: the uploader's or a tenant-wide
//      actor's), be verified (EXTRACTION_CLAIM_NEEDS_REVIEW), not rejected or corrected (EXTRACTION_CLAIM_DECIDED),
//      of an open action (EXTRACTION_CLOSED), of a document with no clean newer version (DOCUMENT_SUPERSEDED);
//   2. a target: a new date of the claim's milestone, or an existing date of the deal of the same kind
//      (EXTRACTION_TARGET_KIND; another deal's date is NOT_FOUND inside confirmInTx);
//   3. confirmInTx with fromDocument: source 'document', the document basis, evidence_claim_id (the one writer of
//      deal dates; the DB re-checks the claim, 0140); a move of an existing date is the person's own move (E413);
//   4. the claim is confirmed as the person; a replay returns the same date (E414; the unique index is the backstop);
//   5. the action's status follows the claims: proposed → approved on the first confirm, approved → executed once no
//      unreviewed verified claim remains, proposed → rejected once every verified claim is rejected.
// documents/** writes no deal_dates SQL: only confirmInTx does.
import type { IdGenerator, Instant, LocalDate, UserActor } from '@realty/core/foundation';
import type { MilestoneKind } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { confirmInTx } from '../transactions/index.js';
import { extractionDedupeKey } from './read.js';
import * as R from './repos.js';

export type ConfirmTarget = { kind: 'new' } | { kind: 'existing'; dateId: string };

interface ClaimRow {
  id: string;
  action_id: string;
  needs_review: boolean;
  review_status: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected';
  structured: { milestone?: { kind?: string; label?: string; dueOn?: string } } | null;
  action_status: string;
}

const CLOSED = new Set(['rejected', 'superseded', 'invalidated', 'expired', 'blocked']);

async function lockedClaim(tx: Tx, documentId: string, claimId: string): Promise<ClaimRow> {
  const r = await sql<ClaimRow>`
    SELECT c.id, c.action_id, c.needs_review, c.review_status, c.structured, a.status AS action_status
      FROM assistant_claims c JOIN assistant_actions a ON a.tenant_id = c.tenant_id AND a.id = c.action_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${claimId} AND a.kind = 'contract_extraction'
       AND a.dedupe_key = ${extractionDedupeKey(documentId)}
     FOR UPDATE OF c, a`.execute(tx);
  const c = r.rows[0];
  if (!c) throw new AppError('NOT_FOUND');
  return c;
}

async function appliedDate(tx: Tx, claimId: string): Promise<string | null> {
  const r = await sql<{ id: string }>`SELECT id FROM deal_dates WHERE tenant_id = app.tenant_id() AND evidence_claim_id = ${claimId}`.execute(tx);
  return r.rows[0]?.id ?? null;
}

export async function confirmClaimInTx(
  tx: Tx,
  actor: UserActor,
  ids: IdGenerator,
  documentId: string,
  claimId: string,
  b: { target: ConfirmTarget; reminderDaysBefore?: number | null | undefined },
  now: Instant,
): Promise<{ dateId: string; replay: boolean }> {
  const d = await R.docById(tx, documentId);
  if (!d || d.deal_id === null) throw new AppError('NOT_FOUND');
  const c = await lockedClaim(tx, documentId, claimId);
  if (c.review_status === 'confirmed') {
    const applied = await appliedDate(tx, claimId);
    if (applied) return { dateId: applied, replay: true };
  }
  if (c.needs_review) throw new AppError('EXTRACTION_CLAIM_NEEDS_REVIEW');
  if (c.review_status !== 'unreviewed') throw new AppError('EXTRACTION_CLAIM_DECIDED');
  if (CLOSED.has(c.action_status)) throw new AppError('EXTRACTION_CLOSED');
  if (await R.hasCleanSuccessor(tx, documentId)) throw new AppError('DOCUMENT_SUPERSEDED');
  const m = c.structured?.milestone;
  if (!m?.kind || !m.dueOn) throw new AppError('NOT_FOUND');
  let dateId: string | null = null;
  if (b.target.kind === 'existing') {
    const t = await sql<{ deal_id: string; kind: string }>`SELECT deal_id, kind FROM deal_dates WHERE tenant_id = app.tenant_id() AND id = ${b.target.dateId}`.execute(tx);
    const row = t.rows[0];
    if (!row || row.deal_id !== d.deal_id) throw new AppError('NOT_FOUND');
    if (row.kind !== m.kind) throw new AppError('EXTRACTION_TARGET_KIND');
    dateId = b.target.dateId;
  }
  const written = await confirmInTx(
    tx,
    actor,
    ids,
    {
      dealId: d.deal_id,
      dateId,
      ...(dateId === null ? { kind: m.kind as MilestoneKind, label: m.label ?? null } : {}),
      dueOn: m.dueOn as LocalDate,
      ...(b.reminderDaysBefore !== undefined ? { reminderDaysBefore: b.reminderDaysBefore } : {}),
      fromDocument: { claimId },
    },
    now,
  );
  await sql`UPDATE assistant_claims SET review_status = 'confirmed', reviewed_by_user_id = ${actor.userId}, reviewed_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${claimId}`.execute(tx);
  await recomputeActionInTx(tx, actor, c.action_id, 'confirm');
  return { dateId: written, replay: false };
}

export async function rejectClaimInTx(tx: Tx, actor: UserActor, documentId: string, claimId: string): Promise<void> {
  const c = await lockedClaim(tx, documentId, claimId);
  if (c.review_status === 'rejected') return; // a replay
  if (c.review_status !== 'unreviewed') throw new AppError('EXTRACTION_CLAIM_DECIDED');
  if (CLOSED.has(c.action_status)) throw new AppError('EXTRACTION_CLOSED');
  await sql`UPDATE assistant_claims SET review_status = 'rejected', reviewed_by_user_id = ${actor.userId}, reviewed_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${claimId}`.execute(tx);
  await recomputeActionInTx(tx, actor, c.action_id, 'reject');
}

/** The action's status from its claims, decided by the person (0018 decision guard: as themselves). */
async function recomputeActionInTx(tx: Tx, actor: UserActor, actionId: string, decision: 'confirm' | 'reject'): Promise<void> {
  const r = await sql<{ status: string; verified: number; unreviewed_verified: number; rejected_verified: number; confirmed: number; unreviewed: number }>`
    SELECT a.status,
           count(c.id) FILTER (WHERE NOT c.needs_review)::int AS verified,
           count(c.id) FILTER (WHERE NOT c.needs_review AND c.review_status = 'unreviewed')::int AS unreviewed_verified,
           count(c.id) FILTER (WHERE NOT c.needs_review AND c.review_status = 'rejected')::int AS rejected_verified,
           count(c.id) FILTER (WHERE c.review_status = 'confirmed')::int AS confirmed,
           count(c.id) FILTER (WHERE c.review_status = 'unreviewed')::int AS unreviewed
      FROM assistant_actions a LEFT JOIN assistant_claims c ON c.tenant_id = a.tenant_id AND c.action_id = a.id
     WHERE a.tenant_id = app.tenant_id() AND a.id = ${actionId}
     GROUP BY a.status`.execute(tx);
  const s = r.rows[0];
  if (!s) return;
  let status = s.status;
  const set = (to: string, decide: boolean) =>
    sql`UPDATE assistant_actions SET status = ${to}, updated_at = now()
          ${decide ? sql`, decided_by_user_id = ${actor.userId}, decided_at = now()` : sql``}
         WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  if (decision === 'confirm' && status === 'proposed') {
    await set('approved', true);
    status = 'approved';
  }
  if (status === 'approved' && s.unreviewed_verified === 0) {
    await set('executed', false);
    return;
  }
  // nothing was confirmed and every verified claim was rejected (a claim-less action: every claim reviewed)
  if (status === 'proposed' && s.confirmed === 0 && (s.verified > 0 ? s.rejected_verified === s.verified : s.unreviewed === 0)) await set('rejected', true);
}
