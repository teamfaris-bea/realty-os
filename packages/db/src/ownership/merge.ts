// R-OWN-24 / E69: communication and automation move with a merge, under both contact locks.
//   - the loser's messages and calls are re-pointed (contact + conversation) to the survivor's
//     conversation (created if the survivor had none); the loser's empty conversation stays with the
//     closed loser, so no row is deleted and no unique key is violated;
//   - pause wins: the survivor's conversation is paused if either side was, keeping the EARLIEST
//     automation_paused_at and its paused_by_message_id;
//   - the loser's live enrollment is stopped ('merged'); the survivor's continues, and is paused if
//     the loser's side was paused (one live enrollment per contact always holds);
//   - the loser's open handbacks and drafts move to the survivor; handbacks go to the surviving
//     owner (or the Team Lead / an Admin when unowned); drafts bound to the loser's period are
//     invalidated.
// Runs as a tenant-wide actor (system / Owner / Admin): inline in the merge transaction, or in the
// merge's ownership.followup for a Team Lead.
import type { ContactId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { PeopleFacts } from '@realty/core/ownership';
import { sql } from 'kysely';
import type { Tx } from '../tenantTx.js';
import { unownedHandbackTarget } from './effects.js';

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
           owner_user_id = CASE WHEN kind = 'handback' AND ${target}::uuid IS NOT NULL THEN ${target}::uuid ELSE owner_user_id END,
           status = CASE WHEN kind IN ('message_draft', 'autonomous_message', 'seller_update_draft', 'next_step') THEN 'invalidated'
                         ELSE status END,
           updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${loserId} AND status = 'proposed'
    RETURNING id, kind`.execute(tx);
  const handbacks = movedActions.rows.filter((r) => r.kind === 'handback').map((r) => r.id);
  if (handbacks.length > 0) {
    await sql`
      UPDATE priority_feed_items SET contact_id = ${survivorId},
             user_id = COALESCE(${target}::uuid, user_id), updated_at = now()
       WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${handbacks}::uuid[]) AND state IN ('open', 'snoozed')`.execute(tx);
  }
  const invalidated = movedActions.rows.filter((r) => r.kind !== 'handback').map((r) => r.id);
  if (invalidated.length > 0) {
    await sql`
      UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${toIso(now)}::timestamptz
       WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${invalidated}::uuid[]) AND state IN ('open', 'snoozed')`.execute(tx);
  }
}
