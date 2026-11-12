// SQL of api/gbp (module 53). Every query runs inside the caller's withTenantTx under FORCE RLS:
//   - the sync, the replies' TX2 and the reconcile run as the tenant's system actor (gbp_reviews is written by the
//     system only, 0018 gbp_reviews_write; the 0170 guard checks every write);
//   - the pages and TX1 run as the signed-in person (members read reviews; an action is read through its own RLS).
// Nothing here names contacts or contact points: reviewers are never matched to contacts (R-GBP-5).
import { type Instant, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { GbpReview } from '../provider.js';

export interface PackState {
  cleared: boolean;
  fairHousingCleared: boolean;
  version: string | null;
}

export async function packState(tx: Tx): Promise<PackState> {
  const r = await sql<{ cleared: boolean; fh: boolean; version: string | null }>`
    SELECT app.platform_cleared('platform:gbp') AS cleared, app.platform_cleared('platform:fair_housing') AS fh,
           (SELECT j.version FROM jurisdiction_packs j WHERE j.key = 'platform:gbp' AND j.status = 'published' ORDER BY j.version DESC LIMIT 1) AS version`.execute(tx);
  const x = r.rows[0]!;
  return { cleared: x.cleared, fairHousingCleared: x.fh, version: x.version };
}

export interface LocationRow {
  id: string;
  status: string;
  display_name: string;
  external_account_id: string | null;
  credential_id: string | null;
  sync_cursor: string | null;
  last_synced_at: Date | null;
  next_sync_at: Date | null;
  last_error_code: string | null;
}

const LOCATION_COLS = sql`id, status, display_name, external_account_id, credential_id, sync_cursor, last_synced_at, next_sync_at, last_error_code`;

/** The tenant's GBP locations that are not disconnected or revoked (the status page). */
export async function locations(tx: Tx): Promise<LocationRow[]> {
  return (await sql<LocationRow>`SELECT ${LOCATION_COLS} FROM integration_connections
    WHERE tenant_id = app.tenant_id() AND kind = 'gbp_location' AND status NOT IN ('disconnected','revoked') ORDER BY display_name, id`.execute(tx)).rows;
}

/** Live locations whose stored next_sync_at is due (R-OWN-27: woken by stored instants). */
export async function dueLocations(tx: Tx, now: Instant): Promise<LocationRow[]> {
  return (await sql<LocationRow>`SELECT ${LOCATION_COLS} FROM integration_connections
    WHERE tenant_id = app.tenant_id() AND kind = 'gbp_location' AND status IN ('connected','degraded')
      AND external_account_id IS NOT NULL AND credential_id IS NOT NULL
      AND (next_sync_at IS NULL OR next_sync_at <= ${toIso(now)}::timestamptz) ORDER BY id`.execute(tx)).rows;
}

export async function locationById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<LocationRow | null> {
  const r = await sql<LocationRow>`SELECT ${LOCATION_COLS} FROM integration_connections
    WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND kind = 'gbp_location' ${o.forUpdate ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function credentialSecret(tx: Tx, credentialId: string): Promise<Buffer | null> {
  const r = await sql<{ secret_enc: Buffer | null; status: string }>`SELECT secret_enc, status FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId}::uuid`.execute(tx);
  const c = r.rows[0];
  return c && c.status === 'active' && c.secret_enc ? c.secret_enc : null;
}

/** The cursor fence write: only the pass that read `cursor` advances it. */
export async function advanceCursor(tx: Tx, id: string, next: string | null, errorCode: string | null): Promise<void> {
  await sql`UPDATE integration_connections SET sync_cursor = ${next}, last_synced_at = clock_timestamp(), last_error_code = ${errorCode}
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function finishPass(tx: Tx, id: string, nextAt: Instant, errorCode: string | null | undefined): Promise<void> {
  await sql`UPDATE integration_connections SET next_sync_at = ${toIso(nextAt)}::timestamptz ${errorCode === undefined ? sql`` : sql`, last_error_code = ${errorCode}`}
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

// ---- reviews ------------------------------------------------------------------------------------------------------

export interface ReviewRow {
  id: string;
  connection_id: string;
  external_review_id: string;
  rating: number | null;
  body: string | null;
  reviewer_display: string | null;
  reviewed_at: Date;
  reply_status: 'none' | 'drafted' | 'replied';
  reply_action_id: string | null;
  created_at: Date;
}

const REVIEW_COLS = sql`id, connection_id, external_review_id, rating, body, reviewer_display, reviewed_at, reply_status, reply_action_id, created_at`;

export async function reviewByExternal(tx: Tx, connectionId: string, externalReviewId: string): Promise<ReviewRow | null> {
  const r = await sql<ReviewRow>`SELECT ${REVIEW_COLS} FROM gbp_reviews
    WHERE tenant_id = app.tenant_id() AND connection_id = ${connectionId}::uuid AND external_review_id = ${externalReviewId} FOR UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

export async function reviewById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<ReviewRow | null> {
  const r = await sql<ReviewRow>`SELECT ${REVIEW_COLS} FROM gbp_reviews WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid ${o.forUpdate ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function reviewsOf(tx: Tx, connectionId: string | null, needsReply: boolean, limit = 200): Promise<ReviewRow[]> {
  return (await sql<ReviewRow>`SELECT ${REVIEW_COLS} FROM gbp_reviews
    WHERE tenant_id = app.tenant_id() ${connectionId ? sql`AND connection_id = ${connectionId}::uuid` : sql``}
      ${needsReply ? sql`AND reply_status <> 'replied' AND rating IS NOT NULL` : sql``}
    ORDER BY reviewed_at DESC, id LIMIT ${limit}`.execute(tx)).rows;
}

export async function insertReview(tx: Tx, id: string, connectionId: string, r: GbpReview): Promise<void> {
  await sql`INSERT INTO gbp_reviews (tenant_id, id, connection_id, external_review_id, rating, body, reviewer_display, reviewed_at, reply_status)
            VALUES (app.tenant_id(), ${id}::uuid, ${connectionId}::uuid, ${r.externalReviewId}, ${r.rating}, ${r.body}, ${r.reviewerDisplay}, ${r.reviewedAt}::timestamptz,
                    ${r.ownerReply ? 'replied' : 'none'})`.execute(tx);
}

export async function updateFacts(tx: Tx, id: string, r: GbpReview): Promise<void> {
  await sql`UPDATE gbp_reviews SET rating = ${r.rating}, body = ${r.body}, reviewer_display = ${r.reviewerDisplay}, reviewed_at = ${r.reviewedAt}::timestamptz
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function setReply(tx: Tx, id: string, status: ReviewRow['reply_status'], actionId: string | null): Promise<void> {
  await sql`UPDATE gbp_reviews SET reply_status = ${status}, reply_action_id = ${actionId} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** "Removed at Google": no rating, text or reviewer (0170 guard); a waiting draft is no longer wanted. */
export async function blankReview(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE gbp_reviews SET rating = NULL, body = NULL, reviewer_display = NULL WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** Live (not removed) reviews of a location that a complete sweep did not see. */
export async function unseenReviews(tx: Tx, connectionId: string, seen: readonly string[]): Promise<ReviewRow[]> {
  return (await sql<ReviewRow>`SELECT ${REVIEW_COLS} FROM gbp_reviews
    WHERE tenant_id = app.tenant_id() AND connection_id = ${connectionId}::uuid AND rating IS NOT NULL
      AND NOT (external_review_id = ANY (${[...seen]}::text[])) ORDER BY id FOR UPDATE`.execute(tx)).rows;
}

// ---- reply drafts (assistant_actions kind review_reply_draft, owner-less) -------------------------------------------

export interface DraftRow {
  id: string;
  kind: string;
  status: string;
  payload: { review_id?: string; text?: string; review_sha256?: string; guard?: string[]; mode?: string };
  edited_payload: { text?: string } | null;
  decided_at: Date | null;
  decided_by_user_id: string | null;
}

export async function actionById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<DraftRow | null> {
  const r = await sql<DraftRow>`SELECT id, kind, status, payload, edited_payload, decided_at, decided_by_user_id FROM assistant_actions
    WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid ${o.forUpdate ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function setActionStatus(tx: Tx, id: string, status: 'executed' | 'superseded' | 'invalidated'): Promise<void> {
  await sql`UPDATE assistant_actions SET status = ${status}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** Back to a draft waiting for a tap: the decision is cleared (0018 decision guard: a revert to proposed clears it). */
export async function revertToProposed(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = 'proposed', decided_by_user_id = NULL, decided_at = NULL, edited_payload = NULL, updated_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'approved'`.execute(tx);
}

/** Approved reply drafts of the tenant older than `before` (in flight with no answer: the reconcile settles them). */
export async function staleApprovedReviews(tx: Tx, before: Instant): Promise<{ review_id: string; action_id: string }[]> {
  return (await sql<{ review_id: string; action_id: string }>`
    SELECT g.id AS review_id, a.id AS action_id FROM gbp_reviews g
      JOIN assistant_actions a ON a.tenant_id = g.tenant_id AND a.id = g.reply_action_id
     WHERE g.tenant_id = app.tenant_id() AND g.reply_status = 'drafted' AND a.kind = 'review_reply_draft' AND a.status = 'approved'
       AND a.decided_at < ${toIso(before)}::timestamptz ORDER BY a.decided_at`.execute(tx)).rows;
}
