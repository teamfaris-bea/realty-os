// R-OWN-24 / E69: communication and automation move with a merge, under both contact locks.
//   - the loser's messages and calls are re-pointed (contact + conversation) to the survivor's
//     conversation (created if the survivor had none); the loser's empty conversation stays with the
//     closed loser, so no row is deleted and no unique key is violated;
//   - pause wins: the survivor's conversation is paused if either side was, keeping the EARLIEST
//     automation_paused_at and its paused_by_message_id;
//   - the loser's live enrollment is stopped ('merged'); the survivor's continues, and is paused if
//     the loser's side was paused (one live enrollment per contact always holds); the loser's scheduled
//     trigger firings (module 26, no enrollment) are skipped as CONTACT_REMOVED;
//   - the loser's open handbacks and drafts move to the survivor; handbacks (and pending AI ISA
//     handoff cards, b12 review F2) go to the surviving owner (or the Team Lead / an Admin when
//     unowned); drafts bound to the loser's period are invalidated.
// Parity module 66 (R-PAR-45): the loser's points (copied, so every opt-out keeps blocking the merged
// person), tags, custom values, relationships, notes and stage history move in the merge transaction
// itself, by the definer trigger app.contacts_merge_children on contacts.merged_into_contact_id.
// Runs as a tenant-wide actor (system / Owner / Admin): inline in the merge transaction, or in the
// merge's ownership.followup for a Team Lead. Then the callers' MergeSteps run, in the same transaction
// and as the same actor: the merge rules of modules this package does not know (batch 10 review
// ownership-data/F4: api/cma's CMA drafts), so a database migrated only partway (a migration's backfill
// test) never meets a table it does not have.
import { aiIsaSchema } from './effects.js';
import type { ContactId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { PeopleFacts } from '@realty/core/ownership';
import { sql } from 'kysely';
import type { Tx } from '../tenantTx.js';
import { collapseHandoffCards, unownedHandbackTarget } from './effects.js';

/**
 * A step another module runs in the merge's move transaction, after the communication move, as the same tenant-wide
 * actor (inline for the system / Owner / Admin, in the ownership.followup for a Team Lead). It must be idempotent: a
 * re-delivered follow-up runs it again.
 */
export type MergeStep = (tx: Tx, survivorId: ContactId, loserId: ContactId) => Promise<void>;

interface ConvRow {
  id: string;
  automation_paused_at: Date | null;
  automation_pause_reason: string | null;
  automation_paused_by_message_id: string | null;
}

async function conversationOf(tx: Tx, contactId: ContactId): Promise<ConvRow | null> {
  const r = await sql<ConvRow>`
    SELECT id, automation_paused_at, automation_pause_reason, automation_paused_by_message_id FROM conversations
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} FOR UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

export async function mergeCommunication(
  tx: Tx,
  now: Instant,
  ids: IdGenerator,
  survivorId: ContactId,
  loserId: ContactId,
  survivingOwner: UserId | null,
  people: PeopleFacts | undefined,
  previousOwner: UserId | null,
  steps: readonly MergeStep[] = [],
): Promise<void> {
  const lconv = await conversationOf(tx, loserId);
  let moved = 0;
  let sconv = await conversationOf(tx, survivorId);
  if (lconv) {
    if (!sconv) {
      const id = ids.next<'ConversationId'>();
      await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${id}, ${survivorId})`.execute(tx);
      sconv = { id, automation_paused_at: null, automation_pause_reason: null, automation_paused_by_message_id: null };
    }
    const movedMessages = await sql`UPDATE messages SET contact_id = ${survivorId}, conversation_id = ${sconv.id}
               WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId}`.execute(tx);
    const movedCalls = await sql`UPDATE calls SET contact_id = ${survivorId}, conversation_id = ${sconv.id}
               WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId}`.execute(tx);
    moved = Number(movedMessages.numAffectedRows ?? 0) + Number(movedCalls.numAffectedRows ?? 0);
    // pause wins; the earliest pause (and the message that caused it) is kept
    const lp = lconv.automation_paused_at;
    const sp = sconv.automation_paused_at;
    if (lp && (!sp || lp < sp)) {
      await sql`
        UPDATE conversations SET automation_paused_at = ${lp.toISOString()}::timestamptz,
               automation_pause_reason = ${lconv.automation_pause_reason}, automation_paused_by_message_id = ${lconv.automation_paused_by_message_id},
               updated_at = now()
         WHERE tenant_id = app.tenant_id() AND id = ${sconv.id}`.execute(tx);
    }
    // The counters are folded in only by the run that actually moved the loser's history: a re-run of
    // the same merge follow-up (worker crash after commit, duplicate delivery) finds nothing left to
    // move and must not add the loser's inbound_seq a second time.
    if (moved > 0) {
      await sql`
        UPDATE conversations s SET
               last_inbound_at = GREATEST(s.last_inbound_at, l.last_inbound_at),
               last_outbound_at = GREATEST(s.last_outbound_at, l.last_outbound_at),
               inbound_seq = s.inbound_seq + l.inbound_seq, updated_at = now()
          FROM conversations l
         WHERE s.tenant_id = app.tenant_id() AND s.id = ${sconv.id} AND l.tenant_id = s.tenant_id AND l.id = ${lconv.id}`.execute(tx);
    }
  }
  const loserPaused = lconv?.automation_paused_at ?? null;
  // the loser's live enrollment stops; the survivor's continues, paused if the loser's side was paused
  const stopped = await sql`
    UPDATE playbook_enrollments SET state = 'stopped', stop_reason = 'merged', ended_at = ${toIso(now)}::timestamptz,
           pause_reason = NULL, paused_at = NULL, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId} AND state IN ('active', 'paused')`.execute(tx);
  moved += Number(stopped.numAffectedRows ?? 0);
  // Module 26 trigger firings (R-NURT-1) have no enrollment, so stopping enrollments leaves them: the loser's
  // still-scheduled firings are skipped here, visibly, as a firing of a merged-away record is when it executes
  // (CONTACT_REMOVED). A message one of them already queued moved to the survivor above; its autonomous action is
  // invalidated below and dispatch refuses it (ASSISTANT_ACTION_WITHDRAWN, b7 sends/F2).
  await sql`
    UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
           trigger_ref = trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', 'CONTACT_REMOVED',
                                                            'text', 'This contact was merged into another record or removed.'))
     WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId} AND enrollment_id IS NULL AND status = 'scheduled'`.execute(tx);
  // Pausing the survivor's enrollment belongs to the first application only: on a re-run (nothing
  // left to move) a human may already have resumed it, and a resume must not be undone. The
  // survivor CONVERSATION pause above is idempotent (earliest pause kept) and still blocks
  // automation at dispatch (R-GATE-4) either way.
  if (loserPaused && moved > 0) {
    await sql`
      UPDATE playbook_enrollments SET state = 'paused', pause_reason = ${lconv?.automation_pause_reason ?? 'client_reply'},
             paused_at = ${loserPaused.toISOString()}::timestamptz, paused_by_message_id = ${lconv?.automation_paused_by_message_id ?? null},
             updated_at = now()
       WHERE tenant_id = app.tenant_id() AND contact_id = ${survivorId} AND state = 'active'`.execute(tx);
  }
  // open handbacks / drafts move to the survivor; handbacks to the surviving owner (or TL / Admin)
  const target = survivingOwner ?? unownedHandbackTarget(people, previousOwner);
  const movedActions = await sql<{ id: string; kind: string }>`
    UPDATE assistant_actions SET contact_id = ${survivorId},
           owner_user_id = CASE WHEN kind IN ('handback', 'ai_isa_handoff') AND ${target}::uuid IS NOT NULL THEN ${target}::uuid ELSE owner_user_id END,
           status = CASE WHEN kind IN ('message_draft', 'autonomous_message', 'seller_update_draft', 'next_step', 'ai_isa_message') THEN 'invalidated'
                         ELSE status END,
           updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId} AND status = 'proposed'
    RETURNING id, kind`.execute(tx);
  // AI ISA (D12 proposed, R-ISA-16, E526): a merge stops live AI care on both records in this transaction (the guard and
  // liveness treat both as ended at commit; the stop-signal job writes the handoffs). No UPDATE right on the loser's
  // assignment is needed: the ledger insert is allowed to any tenant actor. (Skipped on a pre-AI-ISA schema.)
  const isa = await aiIsaSchema(tx);
  if (isa) await sql`
    INSERT INTO ai_isa_stop_signals (tenant_id, contact_id, reason, source_table, source_id)
    SELECT DISTINCT a.tenant_id, a.contact_id, 'merged', 'contacts', ${loserId}::uuid FROM ai_isa_assignments a
     WHERE a.tenant_id = app.tenant_id() AND a.contact_id IN (${loserId}::uuid, ${survivorId}::uuid) AND a.ended_at IS NULL`.execute(tx);
  if (isa) await sql`
    INSERT INTO jobs (tenant_id, queue, kind, payload, run_at)
    SELECT s.tenant_id, 'realtime', 'ai_isa.stop_signal', jsonb_build_object('signalId', s.id), clock_timestamp() FROM ai_isa_stop_signals s
     WHERE s.tenant_id = app.tenant_id() AND s.reason = 'merged' AND s.source_id = ${loserId}::uuid AND s.created_at >= now()`.execute(tx);
  // b12 review F2: a pending AI ISA handoff card is routed like a handback (AI_ISA.md §10): it stays open and follows the
  // survivor and its owner. Its ai_isa_handoffs row stays frozen on the loser; the deadline sweep and the ack read the
  // merge root (0081). One open card per handoff remains for the target (a pond handoff had one per escalation user).
  const handoffCards = movedActions.rows.filter((r) => r.kind === 'ai_isa_handoff').map((r) => r.id);
  if (handoffCards.length > 0) await collapseHandoffCards(tx, handoffCards, target, now);
  const handbacks = movedActions.rows.filter((r) => r.kind === 'handback' || r.kind === 'ai_isa_handoff').map((r) => r.id);
  if (handbacks.length > 0) {
    await sql`
      UPDATE priority_feed_items SET contact_id = ${survivorId},
             user_id = COALESCE(${target}::uuid, user_id), updated_at = now()
       WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${handbacks}::uuid[]) AND state IN ('open', 'snoozed')`.execute(tx);
  }
  const invalidated = movedActions.rows.filter((r) => r.kind !== 'handback' && r.kind !== 'ai_isa_handoff').map((r) => r.id);
  if (invalidated.length > 0) {
    await sql`
      UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${toIso(now)}::timestamptz
       WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${invalidated}::uuid[]) AND state IN ('open', 'snoozed')`.execute(tx);
  }
  for (const step of steps) await step(tx, survivorId, loserId);
}
