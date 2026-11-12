// Applies core/ownership effects (ARCHITECTURE §5 step 7).
//
// Inline (in the command transaction, limited to rows the actor's own RLS may write): timers (jobs),
// notifications + delivery rows, the actor's own feed items and membership counters, the audit
// mirror of human commands. Contact-column effects (inactivity deadlines, last human touch, soft
// delete, merged_into) ride along with the projection write itself (see apply.ts).
// Everything that writes OTHER users' rows (feed items, re-homing handbacks, invalidating drafts,
// pausing agent enrollments, collaborator rows) and any routing goes to ONE `ownership.followup`
// job (dedupe followup:{command_id}) that applies them as the system actor under the same locks.
import type { Actor, ContactId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { Effect, NotificationSpec, OwnershipProjection, PeopleFacts } from '@realty/core/ownership';
import { sql } from 'kysely';
import { type JobSpec, cancel, enqueue, enqueueAll } from '../jobs.js';
import { insertAuditRow } from '../repos/audit.js';
import { insertUnlessDuplicate } from '../savepoint.js';
import type { JsonValue } from '../schema.js';
import type { Tx } from '../tenantTx.js';

/** PII-free notification titles (lock screens never show names, numbers or bodies: ARCHITECTURE §12). */
const TITLES: Record<string, string> = {
  LEAD_OFFER: 'New lead offer',
  FIRST_TOUCH_BREACHED: 'First touch is overdue',
  FIRST_TOUCH_MISSED: 'A lead went back to the pond (no first touch)',
  REASSIGNED_TO_YOU: 'A lead was assigned to you',
  REASSIGNED_AWAY: 'A lead was reassigned',
  // R-OWN-18: an assign of a lead on offer withdraws the offer, and the agent it was on offer to is told (batch 6 review R5)
  OFFER_RESCINDED: 'A lead offered to you was assigned to someone else',
  OWNER_DEACTIVATED: 'A lead was moved to you',
  AUTO_PAUSED: 'Lead offers paused after missed offers',
  NO_ELIGIBLE_AGENT: 'A lead went to the pond: nobody was available',
  INACTIVITY_WARNING: 'A lead will return to the pond soon',
  INACTIVITY: 'A lead returned to the pond (inactivity)',
  REINQUIRY: 'A lead you own inquired again',
  REINQUIRY_CLOSED: 'A closed contact inquired again',
  MERGED: 'Two contacts were merged',
};

export const FOLLOWUP_JOB_KIND = 'ownership.followup';
export const followupDedupeKey = (commandId: string) => `followup:${commandId}`;

export interface FollowupPayload {
  [k: string]: JsonValue;
  commandId: string;
  contactId: string;
  /** effects to apply as the system actor (ids, codes and instants only) */
  effects: JsonValue[];
  /** notifications created inline whose push / SMS deliveries the system must add */
  fanoutNotificationIds: string[];
}

export interface EffectContext {
  actor: Actor;
  ids: IdGenerator;
  now: Instant;
  contactId: ContactId;
  /** projection before and after the command (audit diff, re-home targets) */
  before: OwnershipProjection | null;
  after: OwnershipProjection | null;
  people?: PeopleFacts;
  commandKind: string;
}

/** Creates a notification and its delivery rows; returns the id when the user needs a system fan-out. */
async function notify(tx: Tx, c: EffectContext, userId: UserId, n: NotificationSpec): Promise<string | null> {
  const id = c.ids.next<'NotificationId'>();
  const title = TITLES[n.reasonCode] ?? 'Lead update';
  const inserted = await insertUnlessDuplicate(
    tx,
    sql`INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
        VALUES (app.tenant_id(), ${id}, ${userId}, ${n.kind}, ${n.priority}, ${title}, NULL, ${n.subjectType}, ${n.subjectId},
                ${n.dedupeKey})`,
    'notifications_tenant_id_user_id_dedupe_key_key',
  );
  if (!inserted) return null; // already notified (idempotent)
  // In-app is the durable record (always correct even if every push fails).
  await sql`
    INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status)
    VALUES (app.tenant_id(), ${c.ids.next<'NotificationDeliveryId'>()}, ${id}, 'in_app', 'in_app', 'delivered')`.execute(tx);
  const canSeeTargets = c.actor.kind === 'system' || (c.actor.kind === 'user' && c.actor.userId === userId);
  if (!canSeeTargets) return id;
  await addChannelDeliveries(tx, c.ids, id, userId, n.priority, c.now);
  return null;
}

/** Push deliveries for every live subscription; SMS to a verified alert phone for critical kinds. */
export async function addChannelDeliveries(tx: Tx, ids: IdGenerator, notificationId: string, userId: string, priority: string, now: Instant): Promise<void> {
  const subs = await sql<{ id: string }>`
    SELECT id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND revoked_at IS NULL
     ORDER BY id`.execute(tx);
  for (const s of subs.rows) {
    await sql`
      INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
      VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}, ${notificationId}, 'web_push', ${s.id}, 'pending',
              ${toIso(now)}::timestamptz)
      ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
  }
  if (priority !== 'critical') return;
  const phone = await sql<{ ok: boolean }>`
    SELECT alert_phone_verified_at IS NOT NULL AS ok FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  if (phone.rows[0]?.ok) {
    // SMS to an agent passes canContact(recipient=user) at delivery time (notify.deliver); pending needs no decision yet.
    await sql`
      INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
      VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}, ${notificationId}, 'sms', 'alert_phone', 'pending',
              ${toIso(now)}::timestamptz)
      ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
  }
}

async function upsertFeed(tx: Tx, c: EffectContext, e: Extract<Effect, { kind: 'upsertFeed' }>): Promise<void> {
  const i = e.item;
  await sql`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at,
                                     score, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${c.ids.next<'FeedItemId'>()}, ${i.userId}, ${i.itemType}, ${i.band}, ${i.contactId},
            ${i.subjectType}, ${i.subjectId}, ${i.dueAt === null ? null : toIso(i.dueAt)}::timestamptz, 0,
            ${JSON.stringify(i.reasons)}::jsonb, ${i.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open', 'snoozed')
    DO UPDATE SET due_at = EXCLUDED.due_at, reasons = EXCLUDED.reasons, band = EXCLUDED.band, updated_at = now()`.execute(tx);
}

async function resolveFeed(tx: Tx, c: EffectContext, userId: string, dedupeKey: string): Promise<void> {
  await sql`
    UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${toIso(c.now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND dedupe_key = ${dedupeKey} AND state IN ('open', 'snoozed')`.execute(tx);
}

/**
 * R-AST-7: pending drafts bound to another owner or ownership period are invalidated. Uses the
 * contact's CURRENT projection, so a late follow-up still invalidates exactly the stale drafts.
 */
export async function invalidateDrafts(tx: Tx, contactId: ContactId, cur: OwnershipProjection | null): Promise<number> {
  const owner = cur?.state === 'owned' ? cur.ownerUserId : null;
  const period = cur?.state === 'owned' ? cur.periodSeq : null;
  const r = await sql`
    UPDATE assistant_actions SET status = 'invalidated', updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND status = 'proposed'
       AND kind IN ('message_draft', 'autonomous_message', 'seller_update_draft', 'next_step', 'ai_isa_message')
       AND (owner_user_id IS DISTINCT FROM ${owner}::uuid OR bound_ownership_seq IS DISTINCT FROM ${period}::bigint)`.execute(tx);
  // AI ISA (D12 proposed, R-ISA-16): an owner change stops live AI care in this same transaction (the ledger; the
  // stop-signal job then ends it with its handoff). A same-owner new period is a pause (reinquiry), not a stop.
  // (Skipped on a schema before the AI ISA migration, e.g. the upgrade tests that run today's code on older schemas.)
  if (await aiIsaSchema(tx)) await sql`
    INSERT INTO ai_isa_stop_signals (tenant_id, contact_id, reason, source_table, source_id)
    SELECT a.tenant_id, a.contact_id, 'owner_change', 'contacts', a.contact_id FROM ai_isa_assignments a
     WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ${contactId} AND a.ended_at IS NULL AND a.owner_user_id IS DISTINCT FROM ${owner}::uuid`.execute(tx);
  if (await aiIsaSchema(tx)) await sql`
    INSERT INTO jobs (tenant_id, queue, kind, payload, run_at)
    SELECT s.tenant_id, 'realtime', 'ai_isa.stop_signal', jsonb_build_object('signalId', s.id), clock_timestamp() FROM ai_isa_stop_signals s
     WHERE s.tenant_id = app.tenant_id() AND s.contact_id = ${contactId} AND s.reason = 'owner_change' AND s.created_at >= now()`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** R-AST-8: ownership change pauses agent-scoped live enrollments (owner_change). */
async function pauseAgentEnrollments(tx: Tx, contactId: ContactId, now: Instant): Promise<void> {
  await sql`
    UPDATE playbook_enrollments e SET state = 'paused', pause_reason = 'owner_change', paused_at = ${toIso(now)}::timestamptz,
           updated_at = now()
      FROM playbooks p
     WHERE e.tenant_id = app.tenant_id() AND e.contact_id = ${contactId} AND e.state = 'active'
       AND p.tenant_id = e.tenant_id AND p.id = e.playbook_id AND p.scope = 'agent'`.execute(tx);
}

/**
 * The user who must act on open handbacks when the lead is not owned: the previous owner's Team
 * Lead, else the first active Owner/Admin. Never the previous owner (they may have lost visibility).
 */
export function unownedHandbackTarget(people: PeopleFacts | undefined, previousOwner: UserId | null): UserId | null {
  const tls = previousOwner ? (people?.teamLeadsOf[previousOwner] ?? []).filter((u) => u !== previousOwner) : [];
  return tls[0] ?? people?.admins[0] ?? null;
}

/** ARCHITECTURE §10: open handbacks and their feed items follow the CURRENT owner (or the TL). */
export async function rehomeHandbacks(tx: Tx, contactId: ContactId, target: UserId): Promise<number> {
  const moved = await sql<{ id: string }>`
    UPDATE assistant_actions SET owner_user_id = ${target}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'handback' AND status = 'proposed'
       AND owner_user_id IS DISTINCT FROM ${target}::uuid
    RETURNING id`.execute(tx);
  const ids = moved.rows.map((r) => r.id);
  if (ids.length > 0) {
    await sql`
      UPDATE priority_feed_items SET user_id = ${target}, updated_at = now()
       WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${ids}::uuid[]) AND state IN ('open', 'snoozed')`.execute(tx);
  }
  // Feed items about handbacks the TARGET already holds stay as they are; others' are moved above.
  return ids.length;
}

function auditChanges(c: EffectContext): { [k: string]: JsonValue } {
  return {
    command: c.commandKind,
    state: { from: c.before?.state ?? null, to: c.after?.state ?? null },
    owner_user_id: { from: c.before?.ownerUserId ?? null, to: c.after?.ownerUserId ?? null },
    pond_id: { from: c.before?.pondId ?? null, to: c.after?.pondId ?? null },
    seq: { from: c.before?.seq ?? null, to: c.after?.seq ?? null },
  };
}

/**
 * Applies effects in this transaction. Contact-column effects are skipped here (they were written
 * with the projection). Returns notification ids that still need a system channel fan-out.
 */
export async function applyEffects(tx: Tx, c: EffectContext, effects: readonly Effect[]): Promise<string[]> {
  const fanout: string[] = [];
  // Timer enqueues are buffered and written in one round trip (enqueueAll: same rows, same outcome, job
  // ids in effect order). The buffer is flushed before anything else that touches jobs (a cancel, a
  // routing follow-up) and at the end, so the jobs table sees the same sequence of changes as before;
  // the other effects write other tables, which no job insert reads.
  const timers: JobSpec[] = [];
  const flush = async () => {
    if (timers.length === 0) return;
    await enqueueAll(tx, timers.splice(0));
  };
  for (const e of effects) {
    switch (e.kind) {
      case 'enqueueTimer':
        timers.push({ queue: 'realtime', kind: e.jobKind, runAt: e.runAt, dedupeKey: e.dedupeKey, payload: { ...e.fence } });
        break;
      case 'cancelTimers':
        await flush();
        await cancel(tx, e.dedupeKeys);
        break;
      case 'notify': {
        const id = await notify(tx, c, e.userId, e.notification);
        if (id) fanout.push(id);
        break;
      }
      case 'upsertFeed':
        await upsertFeed(tx, c, e);
        break;
      case 'resolveFeed':
        await resolveFeed(tx, c, e.userId, e.dedupeKey);
        break;
      case 'invalidateDrafts':
        await invalidateDrafts(tx, c.contactId, c.after);
        break;
      case 'pauseAgentEnrollments':
        await pauseAgentEnrollments(tx, c.contactId, c.now);
        break;
      case 'rehomeHandbacks': {
        const cur = c.after;
        // in ownership.followup `before` is unknown: the command carried the previous owner (apply.ts runEffects)
        const carried = (e as { previousOwnerUserId?: UserId | null }).previousOwnerUserId;
        const previousOwner = carried !== undefined ? carried : (c.before?.ownerUserId ?? null);
        const target = cur?.state === 'owned' ? cur.ownerUserId : (e.toUserId ?? unownedHandbackTarget(c.people, previousOwner));
        if (target) await rehomeHandbacks(tx, c.contactId, target);
        break;
      }
      case 'routingCursor':
        await sql`
          INSERT INTO routing_rotation_state (tenant_id, rule_id, cursor, version) VALUES (app.tenant_id(), ${e.ruleId},
                 ${JSON.stringify(e.cursor)}::jsonb, 1)
          ON CONFLICT (tenant_id, rule_id) DO UPDATE SET cursor = EXCLUDED.cursor,
                 version = routing_rotation_state.version + 1, updated_at = now()`.execute(tx);
        break;
      case 'membershipAutoPause':
        await sql`
          UPDATE memberships SET accepting_leads = false, auto_paused_at = ${toIso(c.now)}::timestamptz, updated_at = now()
           WHERE tenant_id = app.tenant_id() AND user_id = ${e.userId}`.execute(tx);
        break;
      case 'missedOfferCounter':
        if (e.op === 'increment') {
          await sql`UPDATE memberships SET consecutive_missed_offers = consecutive_missed_offers + 1, updated_at = now()
                     WHERE tenant_id = app.tenant_id() AND user_id = ${e.userId}`.execute(tx);
        } else {
          await sql`UPDATE memberships SET consecutive_missed_offers = 0, updated_at = now()
                     WHERE tenant_id = app.tenant_id() AND user_id = ${e.userId} AND consecutive_missed_offers <> 0`.execute(tx);
        }
        break;
      case 'addCollaborator':
        await sql`
          INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, expires_at)
          VALUES (app.tenant_id(), ${c.contactId}, ${e.userId}, ${e.role}, ${toIso(e.expiresAt)}::timestamptz)
          ON CONFLICT (tenant_id, contact_id, user_id) DO UPDATE SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at,
                 removed_at = NULL`.execute(tx);
        break;
      case 'route':
        await flush();
        // Only reachable for a system actor without a routing snapshot: route in the follow-up job.
        await enqueueFollowup(tx, { commandId: c.ids.next<'CommandId'>(), contactId: c.contactId, effects: [e], fanoutNotificationIds: [] }, c.ids);
        break;
      case 'audit':
        await insertAuditRow(tx, c.actor, c.ids, c.now, {
          action: e.action,
          entityType: 'contact',
          entityId: c.contactId,
          changes: auditChanges(c),
          reason: e.reason ?? null,
        });
        break;
      case 'setInactivityDeadlines':
      case 'recordHumanTouch':
      case 'markDeleted':
      case 'clearDeleted':
      case 'markMergedInto':
        break; // written with the projection
    }
  }
  await flush();
  return fanout;
}

/** Enqueues the single ownership.followup job of a command (dedupe followup:{command_id}). */
export async function enqueueFollowup(tx: Tx, p: Omit<FollowupPayload, 'commandId'> & { commandId: string }, ids: IdGenerator, runAt?: Instant): Promise<void> {
  const key = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.commandId) ? p.commandId : ids.next<'CommandId'>();
  await enqueue(tx, {
    queue: 'realtime',
    kind: FOLLOWUP_JOB_KIND,
    priority: 10,
    ...(runAt === undefined ? {} : { runAt }),
    dedupeKey: followupDedupeKey(key),
    payload: { ...p, commandId: key },
  });
}

/** Whether the AI ISA tables exist (migration ai_isa applied). */
export async function aiIsaSchema(tx: Tx): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT to_regclass('public.ai_isa_stop_signals') IS NOT NULL AS ok`.execute(tx);
  return r.rows[0]!.ok;
}
