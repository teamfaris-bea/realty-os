// Automation state touched by api/comms: the conversation pause, live enrollments and their step runs
// (R-AST-9, ARCHITECTURE §10), the facts dispatch re-reads for assistant messages (R-GATE-4), and the
// handback with its deterministic, evidence-backed claims (R-AST-1, R-AST-9).
import type { Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export type PauseReason = 'client_reply' | 'opt_out' | 'wrong_number';

/** Sets the automation pause on a conversation; keeps the earliest pause. Returns whether it newly paused. */
export async function pauseConversation(tx: Tx, conversationId: string, reason: PauseReason, messageId: string | null, now: Instant): Promise<boolean> {
  const r = await sql`
    UPDATE conversations SET automation_paused_at = ${toIso(now)}::timestamptz, automation_pause_reason = ${reason},
           automation_paused_by_message_id = ${messageId}
     WHERE tenant_id = app.tenant_id() AND id = ${conversationId} AND automation_paused_at IS NULL`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

/**
 * Pauses (or, for a wrong number, stops) every active enrollment of these contacts and cancels their
 * scheduled step runs. Step runs are system-written (RLS): a user-context caller passes
 * `stepRuns: false`; the playbook step job re-checks the enrollment state anyway.
 */
export async function pauseEnrollments(tx: Tx, contactIds: readonly string[], reason: PauseReason, messageId: string | null, now: Instant, o: { stepRuns?: boolean } = {}): Promise<{ id: string; contactId: string }[]> {
  if (contactIds.length === 0) return [];
  const r =
    reason === 'wrong_number'
      ? await sql<{ id: string; contact_id: string }>`
          UPDATE playbook_enrollments SET state = 'stopped', stop_reason = 'wrong_number', ended_at = ${toIso(now)}::timestamptz,
                 pause_reason = NULL, paused_at = NULL
           WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${contactIds}::uuid[]) AND state IN ('active','paused')
          RETURNING id, contact_id`.execute(tx)
      : await sql<{ id: string; contact_id: string }>`
          UPDATE playbook_enrollments SET state = 'paused', pause_reason = ${reason}, paused_at = ${toIso(now)}::timestamptz,
                 paused_by_message_id = ${messageId}
           WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${contactIds}::uuid[]) AND state = 'active'
          RETURNING id, contact_id`.execute(tx);
  const ids = r.rows.map((x) => x.id);
  if (ids.length > 0 && o.stepRuns !== false) {
    await sql`
      UPDATE playbook_step_runs SET status = 'canceled_paused', updated_at = now()
       WHERE tenant_id = app.tenant_id() AND enrollment_id = ANY (${ids}::uuid[]) AND status = 'scheduled'`.execute(tx);
  }
  return r.rows.map((x) => ({ id: x.id, contactId: x.contact_id }));
}

export async function liveEnrollment(tx: Tx, contactId: string): Promise<{ id: string; state: string } | null> {
  const r = await sql<{ id: string; state: string }>`
    SELECT id, state FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND state IN ('active','paused')`.execute(tx);
  return r.rows[0] ?? null;
}

/** Human-only resume (DB guard RESUME_REQUIRES_HUMAN): clears the pause and resumes paused enrollments. */
export async function resumeAutomation(tx: Tx, contactId: string, userId: string): Promise<{ resumed: number; wasPaused: boolean }> {
  const c = await sql`
    UPDATE conversations SET automation_paused_at = NULL, automation_pause_reason = NULL, automation_paused_by_message_id = NULL
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND automation_paused_at IS NOT NULL`.execute(tx);
  const e = await sql`
    UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, paused_by_message_id = NULL,
           resumed_by_user_id = ${userId}
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND state = 'paused' AND pause_reason IN ('client_reply','manual')`.execute(tx);
  return { resumed: Number(e.numAffectedRows ?? 0n), wasPaused: Number(c.numAffectedRows ?? 0n) === 1 };
}

// ---- assistant facts for dispatch ------------------------------------------------------------------

export interface ActionFacts {
  id: string;
  kind: string;
  autonomy: 'requires_approval' | 'within_playbook' | 'internal';
  status: string;
  ownerUserId: string | null;
  boundOwnershipSeq: number | null;
  decidedByUserId: string | null;
  playbookVersionId: string | null;
}

export async function actionFacts(tx: Tx, id: string): Promise<ActionFacts | null> {
  const r = await sql<{ id: string; kind: string; autonomy: ActionFacts['autonomy']; status: string; owner_user_id: string | null; bound_ownership_seq: string | null; decided_by_user_id: string | null; playbook_version_id: string | null }>`
    SELECT id, kind, autonomy, status, owner_user_id, bound_ownership_seq, decided_by_user_id, playbook_version_id FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const a = r.rows[0];
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    autonomy: a.autonomy,
    status: a.status,
    ownerUserId: a.owner_user_id,
    boundOwnershipSeq: a.bound_ownership_seq === null ? null : Number(a.bound_ownership_seq),
    decidedByUserId: a.decided_by_user_id,
    playbookVersionId: a.playbook_version_id,
  };
}

export interface PlaybookFacts {
  versionStatus: string;
  contentSha256: string;
  steps: unknown[];
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  ownerFirstName: string | null;
  latestApproval: { decision: 'approve' | 'revoke'; contentSha256: string } | null;
}

export async function playbookFacts(tx: Tx, versionId: string): Promise<PlaybookFacts | null> {
  const r = await sql<{ status: string; content_sha256: string; steps: unknown[]; scope: 'team' | 'agent'; owner_user_id: string | null; display_name: string | null }>`
    SELECT v.status, v.content_sha256, v.steps, p.scope, p.owner_user_id, u.display_name
      FROM playbook_versions v JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
      LEFT JOIN users u ON u.id = p.owner_user_id
     WHERE v.tenant_id = app.tenant_id() AND v.id = ${versionId}`.execute(tx);
  const v = r.rows[0];
  if (!v) return null;
  const a = await sql<{ decision: 'approve' | 'revoke'; content_sha256: string }>`
    SELECT decision, content_sha256 FROM playbook_approvals WHERE tenant_id = app.tenant_id() AND playbook_version_id = ${versionId}
     ORDER BY decided_at DESC, id DESC LIMIT 1`.execute(tx);
  return {
    versionStatus: v.status,
    contentSha256: v.content_sha256,
    steps: v.steps,
    scope: v.scope,
    ownerUserId: v.owner_user_id,
    ownerFirstName: v.display_name ? (v.display_name.trim().split(/\s+/)[0] ?? null) : null,
    latestApproval: a.rows[0] ? { decision: a.rows[0].decision, contentSha256: a.rows[0].content_sha256 } : null,
  };
}

export async function stepRunFacts(tx: Tx, id: string): Promise<{ id: string; stepKey: string; enrollmentId: string; enrollmentState: string } | null> {
  const r = await sql<{ id: string; step_key: string; enrollment_id: string; state: string }>`
    SELECT s.id, s.step_key, s.enrollment_id, e.state FROM playbook_step_runs s
      JOIN playbook_enrollments e ON e.tenant_id = s.tenant_id AND e.id = s.enrollment_id
     WHERE s.tenant_id = app.tenant_id() AND s.id = ${id}`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, stepKey: x.step_key, enrollmentId: x.enrollment_id, enrollmentState: x.state } : null;
}

/** decisionId: the blocked-send gate_decisions row, when the step's message was blocked. */
export async function updateStepRun(tx: Tx, id: string, u: { status: string; decisionId: string | null; messageId?: string }): Promise<void> {
  await sql`
    UPDATE playbook_step_runs SET status = ${u.status}, last_gate_decision_id = COALESCE(${u.decisionId}::uuid, last_gate_decision_id),
           message_id = COALESCE(${u.messageId ?? null}::uuid, message_id), updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function markActionExecuted(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = 'executed' WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('approved','proposed')`.execute(tx);
}

// ---- handback ---------------------------------------------------------------------------------------

export interface ClaimSpec {
  id: string;
  kind: 'client_statement' | 'sent_summary' | 'fact';
  text: string;
  evidence: { id: string; sourceType: 'message' | 'email' | 'call'; sourceId: string; locator: Record<string, unknown>; snippet: string };
}

export interface HandbackSpec {
  id: string;
  contactId: string;
  ownerUserId: string;
  explanation: string;
  payload: Record<string, unknown>;
  pinnedInboundSeq: number;
  boundOwnershipSeq: number | null;
  dedupeKey: string;
  claims: ClaimSpec[];
}

/** One handback per (enrollment, message) (unique dedupe key). Returns false when it already exists. */
export async function insertHandback(tx: Tx, h: HandbackSpec): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload,
      pinned_inbound_seq, bound_ownership_seq, dedupe_key)
    VALUES (app.tenant_id(), ${h.id}, ${h.contactId}, 'handback', 'internal', 'internal', 'proposed', ${h.ownerUserId}, ${h.explanation.slice(0, 300)},
      ${JSON.stringify(h.payload)}::jsonb, ${h.pinnedInboundSeq}, ${h.boundOwnershipSeq}, ${h.dedupeKey})
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`.execute(tx);
  if (r.rows.length === 0) return false;
  let ordinal = 0;
  for (const c of h.claims) {
    await sql`
      INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review)
      VALUES (app.tenant_id(), ${c.id}, ${h.id}, ${ordinal++}, ${c.kind}, ${c.text.slice(0, 300)}, false)`.execute(tx);
    await sql`
      INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
      VALUES (app.tenant_id(), ${c.evidence.id}, ${c.id}, ${c.evidence.sourceType}, ${c.evidence.sourceId}, ${JSON.stringify(c.evidence.locator)}::jsonb,
              ${c.evidence.snippet.slice(0, 500)}, true)`.execute(tx);
  }
  return true;
}

export async function messagesInFlight(tx: Tx, contactId: string, now: Instant): Promise<{ id: string; body: string; at: Instant | null }[]> {
  const r = await sql<{ id: string; body: string; dispatched_at: Date | null }>`
    SELECT id, body, dispatched_at FROM messages
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'outbound' AND NOT imported AND initiator = 'assistant'
       AND (status = 'dispatching' OR (status IN ('sent','delivered','dispatch_unknown') AND dispatched_at > ${toIso(now)}::timestamptz - interval '60 seconds'))
     ORDER BY dispatched_at DESC NULLS LAST LIMIT 1`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, body: x.body, at: x.dispatched_at ? instantFromDate(x.dispatched_at) : null }));
}

/** A suggested draft for the new owner when an old owner's scheduled text is blocked (E15). */
export async function insertSuggestedDraft(tx: Tx, d: { id: string; contactId: string; ownerUserId: string; body: string; channel: string; boundOwnershipSeq: number | null; dedupeKey: string; fromMessageId: string }): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload,
      bound_ownership_seq, dedupe_key, trigger_ref)
    VALUES (app.tenant_id(), ${d.id}, ${d.contactId}, 'message_draft', 'novel_message', 'requires_approval', 'proposed', ${d.ownerUserId},
      ${'The previous agent scheduled this message before the lead moved to you. It was not sent; send it yourself if it still fits.'},
      ${JSON.stringify({ channel: d.channel, body: d.body })}::jsonb, ${d.boundOwnershipSeq}, ${d.dedupeKey},
      ${JSON.stringify({ blockedMessageId: d.fromMessageId })}::jsonb)
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}
