// assistant_actions + assistant_claims + evidence_refs, feed items and notifications written by
// api/assistant. Every claim not flagged needs_review carries >= 1 verbatim-verified evidence ref
// (deferred DB trigger, R-AST-1); transcript-sourced snippets are stored encrypted (snippet_enc).
import type { CheckedEvidenceRef, Claim } from '@realty/core/assistant';
import { EXPLANATION_MAX, SNIPPET_MAX } from '@realty/core/assistant';
import type { IdGenerator, Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../../crypto/envelope.js';

export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'blocked' | 'expired' | 'superseded' | 'invalidated';

export interface ActionInsert {
  id: string;
  contactId: string | null;
  kind: string;
  category: string;
  autonomy: 'requires_approval' | 'within_playbook' | 'internal';
  playbookVersionId: string | null;
  status: ActionStatus;
  ownerUserId: string | null;
  explanation: string;
  payload: Record<string, unknown>;
  pinnedInboundSeq: number | null;
  boundOwnershipSeq: number | null;
  aiRunId: string | null;
  triggerRef: Record<string, unknown>;
  dedupeKey: string | null;
  claims: readonly Claim[];
  /** set together with status approved/rejected (CHECK: a decision names its decider) */
  decidedByUserId?: string | null;
}

export const snippetAad = (evidenceId: string) => ({ table: 'evidence_refs', column: 'snippet_enc', rowId: evidenceId });

function clipExplanation(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return (t === '' ? 'The assistant prepared this for you.' : t).slice(0, EXPLANATION_MAX);
}

/** Inserts the action and its claims/evidence. Returns false (nothing written) when the dedupe key exists. */
export async function insertAction(tx: Tx, env: { envelope: EnvelopeService; tenantId: string; ids: IdGenerator }, a: ActionInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id,
      explanation, payload, pinned_inbound_seq, bound_ownership_seq, ai_run_id, trigger_ref, dedupe_key, decided_by_user_id, decided_at)
    VALUES (app.tenant_id(), ${a.id}, ${a.contactId}, ${a.kind}, ${a.category}, ${a.autonomy}, ${a.playbookVersionId}, ${a.status}, ${a.ownerUserId},
      ${clipExplanation(a.explanation)}, ${JSON.stringify(a.payload)}::jsonb, ${a.pinnedInboundSeq}, ${a.boundOwnershipSeq}, ${a.aiRunId},
      ${JSON.stringify(a.triggerRef)}::jsonb, ${a.dedupeKey}, ${a.decidedByUserId ?? null}, CASE WHEN ${a.decidedByUserId ?? null}::uuid IS NULL THEN NULL ELSE now() END)
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`.execute(tx);
  if (r.rows.length === 0) return false;
  await insertClaims(tx, env, a.id, a.claims, 0);
  return true;
}

/** Appends claims to an existing action (ordinals continue after `startOrdinal`). */
export async function insertClaims(tx: Tx, env: { envelope: EnvelopeService; tenantId: string; ids: IdGenerator }, actionId: string, claims: readonly Claim[], startOrdinal: number): Promise<void> {
  let ordinal = startOrdinal;
  for (const c of claims) {
    await sql`
      INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, structured, needs_review)
      VALUES (app.tenant_id(), ${c.id}, ${actionId}, ${ordinal++}, ${c.kind}, ${c.text}, ${c.structured === undefined ? null : JSON.stringify(c.structured)}::jsonb,
              ${c.needsReview})`.execute(tx);
    for (const e of c.evidence) await insertEvidence(tx, env, c.id, e);
  }
}

async function insertEvidence(tx: Tx, env: { envelope: EnvelopeService; tenantId: string; ids: IdGenerator }, claimId: string, e: CheckedEvidenceRef): Promise<void> {
  const id = env.ids.next<'EvidenceRefId'>();
  const snippet = e.snippet.slice(0, SNIPPET_MAX);
  // A snippet quoted from a call transcript is as sensitive as the transcript: field-encrypted (ARCHITECTURE §8).
  const encrypted = e.sourceType === 'call' && e.locator.kind === 'transcript_offset';
  const enc = encrypted ? Buffer.from(await env.envelope.inTx(tx, env.tenantId as TenantId).encrypt(env.tenantId as TenantId, snippetAad(id), Buffer.from(snippet, 'utf8'))) : null;
  await sql`
    INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, snippet_enc, verbatim_verified)
    VALUES (app.tenant_id(), ${id}, ${claimId}, ${e.sourceType}, ${e.sourceId}, ${JSON.stringify(e.locator)}::jsonb,
            ${encrypted ? null : snippet}, ${enc}, ${e.verified})`.execute(tx);
}

export interface ActionRow {
  id: string;
  contactId: string | null;
  kind: string;
  category: string;
  autonomy: 'requires_approval' | 'within_playbook' | 'internal';
  playbookVersionId: string | null;
  status: ActionStatus;
  ownerUserId: string | null;
  explanation: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  pinnedInboundSeq: number | null;
  boundOwnershipSeq: number | null;
  decidedByUserId: string | null;
  triggerRef: Record<string, unknown>;
  createdAt: Instant;
}

type RawAction = {
  id: string;
  contact_id: string | null;
  kind: string;
  action_category: string;
  autonomy: ActionRow['autonomy'];
  playbook_version_id: string | null;
  status: ActionStatus;
  owner_user_id: string | null;
  explanation: string;
  payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
  pinned_inbound_seq: string | null;
  bound_ownership_seq: string | null;
  decided_by_user_id: string | null;
  trigger_ref: Record<string, unknown>;
  created_at: Date;
};

const num = (v: string | null) => (v === null ? null : Number(v));

function actionRow(x: RawAction): ActionRow {
  return {
    id: x.id,
    contactId: x.contact_id,
    kind: x.kind,
    category: x.action_category,
    autonomy: x.autonomy,
    playbookVersionId: x.playbook_version_id,
    status: x.status,
    ownerUserId: x.owner_user_id,
    explanation: x.explanation,
    payload: x.payload,
    editedPayload: x.edited_payload,
    pinnedInboundSeq: num(x.pinned_inbound_seq),
    boundOwnershipSeq: num(x.bound_ownership_seq),
    decidedByUserId: x.decided_by_user_id,
    triggerRef: x.trigger_ref,
    createdAt: instantFromDate(x.created_at),
  };
}

const ACTION_COLS = sql`id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id, explanation, payload,
  edited_payload, pinned_inbound_seq, bound_ownership_seq, decided_by_user_id, trigger_ref, created_at`;

/** The action if the caller's RLS shows it (null otherwise). `lock` takes a row lock. */
export async function actionById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<ActionRow | null> {
  const r = o.lock
    ? await sql<RawAction>`SELECT ${ACTION_COLS} FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<RawAction>`SELECT ${ACTION_COLS} FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? actionRow(r.rows[0]) : null;
}

export async function actionByDedupeKey(tx: Tx, key: string): Promise<ActionRow | null> {
  const r = await sql<RawAction>`SELECT ${ACTION_COLS} FROM assistant_actions WHERE tenant_id = app.tenant_id() AND dedupe_key = ${key}`.execute(tx);
  return r.rows[0] ? actionRow(r.rows[0]) : null;
}

/**
 * Kinds decided only on their own path, never by the generic card taps: a contract extraction's dates are confirmed or
 * rejected claim by claim on the document (module 42, /documents/:id/extraction), where a confirm writes the deal date
 * through module 31. A generic reject would close the extraction for good and a generic claim review would mark a
 * claim decided without a date (b11 sends-gates/F1, api-ui/F1). The generic approve stays acknowledge-only for it.
 * An AI ISA handoff (module 75) is acknowledged on POST /ai-isa/handoffs/:id/ack and its deadline is met only by a
 * human touch (R-ISA-30): the generic approve ("Got it") invalidated it as a stale draft and the generic reject
 * ("Dismiss") decided it, and either closed its pinned card while the deadline stayed open; both refuse it (b12
 * recheck R11). The system closes its card and executes it once the handoff is done (isa/handoff.ts closeHandoffInTx,
 * b12 recheck R13).
 */
export const OWN_DECISION_PATH_KINDS: readonly string[] = ['contract_extraction', 'ai_isa_handoff'];

/**
 * Open (proposed) actions owned by the current user, newest first. Autonomous messages of an approved
 * playbook are not cards: they are not waiting for the agent, and a tap could not stop them (the playbook
 * is paused or stopped from the enrollment instead). Kinds with their own decision path are not cards either.
 */
export async function inboxActions(tx: Tx, limit: number): Promise<ActionRow[]> {
  const r = await sql<RawAction>`
    SELECT ${ACTION_COLS} FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND owner_user_id = app.user_id() AND status = 'proposed' AND autonomy <> 'within_playbook'
       AND kind <> ALL (${[...OWN_DECISION_PATH_KINDS]}::text[])
     ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(tx);
  return r.rows.map(actionRow);
}

export async function setDecision(tx: Tx, id: string, d: { status: ActionStatus; decidedByUserId: string | null; now: Instant; editedPayload?: Record<string, unknown> | null }): Promise<void> {
  await sql`
    UPDATE assistant_actions SET status = ${d.status}, decided_by_user_id = ${d.decidedByUserId},
           decided_at = ${d.decidedByUserId === null ? null : toIso(d.now)}::timestamptz,
           edited_payload = COALESCE(${d.editedPayload === undefined || d.editedPayload === null ? null : JSON.stringify(d.editedPayload)}::jsonb, edited_payload)
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function setStatus(tx: Tx, id: string, status: ActionStatus): Promise<void> {
  await sql`UPDATE assistant_actions SET status = ${status} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function mergePayload(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
  await sql`UPDATE assistant_actions SET payload = payload || ${JSON.stringify(patch)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function claimCount(tx: Tx, actionId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM assistant_claims WHERE tenant_id = app.tenant_id() AND action_id = ${actionId}`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

// ---- claim + evidence views ------------------------------------------------------------------------

export interface EvidenceRow {
  id: string;
  sourceType: string;
  sourceId: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  encrypted: boolean;
  snippetEnc: Uint8Array | null;
  verified: boolean;
  sourceAvailable: boolean;
}

export interface ClaimRow {
  id: string;
  actionId: string;
  ordinal: number;
  kind: string;
  text: string;
  structured: Record<string, unknown> | null;
  needsReview: boolean;
  reviewStatus: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected';
  evidence: EvidenceRow[];
}

export async function claimsOf(tx: Tx, actionIds: readonly string[]): Promise<ClaimRow[]> {
  if (actionIds.length === 0) return [];
  const c = await sql<{ id: string; action_id: string; ordinal: number; claim_kind: string; text: string; structured: Record<string, unknown> | null; needs_review: boolean; review_status: ClaimRow['reviewStatus'] }>`
    SELECT id, action_id, ordinal, claim_kind, text, structured, needs_review, review_status FROM assistant_claims
     WHERE tenant_id = app.tenant_id() AND action_id = ANY (${actionIds}::uuid[]) ORDER BY action_id, ordinal`.execute(tx);
  const ids = c.rows.map((x) => x.id);
  const e =
    ids.length === 0
      ? { rows: [] }
      : await sql<{ id: string; claim_id: string; source_type: string; source_id: string; locator: Record<string, unknown>; snippet: string | null; snippet_enc: Buffer | null; verbatim_verified: boolean; source_available: boolean }>`
          SELECT id, claim_id, source_type, source_id, locator, snippet, snippet_enc, verbatim_verified, source_available FROM evidence_refs
           WHERE tenant_id = app.tenant_id() AND claim_id = ANY (${ids}::uuid[]) ORDER BY created_at, id`.execute(tx);
  const byClaim = new Map<string, EvidenceRow[]>();
  for (const x of e.rows) {
    const list = byClaim.get(x.claim_id) ?? [];
    list.push({ id: x.id, sourceType: x.source_type, sourceId: x.source_id, locator: x.locator, snippet: x.snippet, encrypted: x.snippet_enc !== null, snippetEnc: x.snippet_enc ? new Uint8Array(x.snippet_enc) : null, verified: x.verbatim_verified, sourceAvailable: x.source_available });
    byClaim.set(x.claim_id, list);
  }
  return c.rows.map((x) => ({ id: x.id, actionId: x.action_id, ordinal: x.ordinal, kind: x.claim_kind, text: x.text, structured: x.structured, needsReview: x.needs_review, reviewStatus: x.review_status, evidence: byClaim.get(x.id) ?? [] }));
}

export async function claimById(tx: Tx, id: string): Promise<(ClaimRow & { lockedAction: string }) | null> {
  const r = await sql<{ action_id: string }>`SELECT action_id FROM assistant_claims WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const a = r.rows[0];
  if (!a) return null;
  const c = (await claimsOf(tx, [a.action_id])).find((x) => x.id === id);
  return c ? { ...c, lockedAction: a.action_id } : null;
}

export async function reviewClaim(tx: Tx, id: string, r: { status: 'confirmed' | 'corrected' | 'rejected'; userId: string; now: Instant; text?: string; structured?: Record<string, unknown> }): Promise<void> {
  await sql`
    UPDATE assistant_claims SET review_status = ${r.status}, reviewed_by_user_id = ${r.userId}, reviewed_at = ${toIso(r.now)}::timestamptz,
           text = COALESCE(${r.text ?? null}, text), structured = COALESCE(${r.structured === undefined ? null : JSON.stringify(r.structured)}::jsonb, structured)
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

// ---- feed + notifications ------------------------------------------------------------------------------

export interface FeedSpec {
  userId: string;
  itemType: 'assistant_draft' | 'saved_search_review' | 'promise_due' | 'handback';
  contactId: string | null;
  subjectType: string;
  subjectId: string;
  assistantActionId: string | null;
  score: number;
  reasons: { code: string; text: string }[];
  dedupeKey: string;
  band?: 'pinned' | 'scored';
  dueAt?: Instant | null;
}

export async function upsertFeed(tx: Tx, ids: IdGenerator, f: FeedSpec): Promise<void> {
  await sql`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, due_at,
      score, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${f.userId}, ${f.itemType}, ${f.band ?? 'scored'}, ${f.contactId}, ${f.subjectType}, ${f.subjectId},
      ${f.assistantActionId}, ${f.dueAt ? toIso(f.dueAt) : null}::timestamptz, ${Math.max(0, Math.min(100, Math.round(f.score)))},
      ${JSON.stringify(f.reasons)}::jsonb, ${f.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET
      reasons = EXCLUDED.reasons, subject_id = EXCLUDED.subject_id, assistant_action_id = EXCLUDED.assistant_action_id, updated_at = now()`.execute(tx);
}

/**
 * Closes the caller's open feed items about an action (approve / reject / dismiss): comms/repos/notify.ts
 * resolveFeedFor, re-exported here for the assistant's own callers. It lives there so that isa/handoff.ts, which is
 * reachable from mailSync/**, closes a handoff's card with no value import of assistant/** (R-GMAIL-14).
 */
export { resolveFeedFor } from '../../comms/repos/notify.js';
