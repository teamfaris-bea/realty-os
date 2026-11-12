// Notifications and feed items written by api/comms (ARCHITECTURE §12: the delivery rows are created in
// the same transaction as their cause; in-app is the durable record). Titles are PII-minimized: first
// name + last initial at most, or nothing (tenant notification_detail); never numbers, emails or bodies.
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface NotifySpec {
  userId: string;
  kind: 'handback' | 'handback_hot' | 'inbound_message' | 'missed_call' | 'opt_out' | 'system' | 'exception' | 'ai_isa_handoff' | 'ai_isa_handoff_hot' | 'ai_isa_escalation' | 'ai_isa_ended' | 'ai_isa_paused' | 'ai_isa_handoff_overdue';
  priority: 'critical' | 'high' | 'normal' | 'low';
  title: string;
  body?: string | null;
  subjectType: string;
  subjectId: string;
  dedupeKey: string;
}

/** Inserts a notification with its delivery rows (system actor: push subscriptions + alert SMS when critical). */
export async function notifyUser(tx: Tx, ids: IdGenerator, n: NotifySpec, now: Instant): Promise<string | null> {
  const id = ids.next<'NotificationId'>();
  const r = await sql<{ id: string }>`
    INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
    VALUES (app.tenant_id(), ${id}, ${n.userId}, ${n.kind}, ${n.priority}, ${n.title.slice(0, 120)}, ${n.body ?? null}, ${n.subjectType},
            ${n.subjectId}, ${n.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING RETURNING id`.execute(tx);
  if (r.rows.length === 0) return null;
  await sql`
    INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status)
    VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}, ${id}, 'in_app', 'in_app', 'delivered')`.execute(tx);
  const subs = await sql<{ id: string }>`
    SELECT id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND user_id = ${n.userId} AND revoked_at IS NULL ORDER BY id`.execute(tx);
  for (const s of subs.rows) {
    await sql`
      INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
      VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}, ${id}, 'web_push', ${s.id}, 'pending', ${toIso(now)}::timestamptz)
      ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
  }
  if (n.priority === 'critical') {
    const phone = await sql<{ ok: boolean }>`
      SELECT alert_phone_verified_at IS NOT NULL AS ok FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${n.userId}`.execute(tx);
    if (phone.rows[0]?.ok) {
      await sql`
        INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
        VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}, ${id}, 'sms', 'alert_phone', 'pending', ${toIso(now)}::timestamptz)
        ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
    }
  }
  return id;
}

export interface FeedSpec {
  userId: string;
  itemType: 'handback' | 'unanswered_inbound' | 'missed_call' | 'assistant_draft' | 'ai_isa_handoff' | 'ai_isa_activity' | 'ai_isa_escalation';
  band: 'pinned' | 'scored';
  contactId: string | null;
  subjectType: string;
  subjectId: string;
  assistantActionId: string | null;
  score: number;
  reasons: { code: string; text: string }[];
  dedupeKey: string;
  dueAt?: Instant | null;
}

export async function upsertFeedItem(tx: Tx, ids: IdGenerator, f: FeedSpec): Promise<void> {
  await sql`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, due_at,
      score, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${f.userId}, ${f.itemType}, ${f.band}, ${f.contactId}, ${f.subjectType}, ${f.subjectId},
      ${f.assistantActionId}, ${f.dueAt ? toIso(f.dueAt) : null}::timestamptz, ${Math.max(0, Math.min(100, Math.round(f.score)))},
      ${JSON.stringify(f.reasons)}::jsonb, ${f.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET
      reasons = EXCLUDED.reasons, subject_id = EXCLUDED.subject_id, assistant_action_id = EXCLUDED.assistant_action_id, updated_at = now()`.execute(tx);
}

/** The PII-minimized label of a contact for notification titles (tenant setting notification_detail). */
export async function contactLabel(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ first_name: string | null; last_name: string | null; detail: string }>`
    SELECT c.first_name, c.last_name, s.notification_detail AS detail FROM contacts c JOIN tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
  const x = r.rows[0];
  if (!x || x.detail === 'none' || !x.first_name) return null;
  return x.last_name ? `${x.first_name} ${x.last_name.slice(0, 1).toUpperCase()}.` : x.first_name;
}

/** Who handles a contact now: the owner, else a Team Lead (default team first), else an Owner/Admin. */
export async function handlerOf(tx: Tx, contactId: string): Promise<{ userId: string | null; ownerUserId: string | null; stage: string; periodSeq: number | null; firstName: string | null }> {
  const r = await sql<{ owner_user_id: string | null; stage: string; ownership_period_seq: string | null; first_name: string | null }>`
    SELECT owner_user_id, stage, ownership_period_seq, first_name FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const c = r.rows[0];
  if (!c) return { userId: null, ownerUserId: null, stage: 'new', periodSeq: null, firstName: null };
  if (c.owner_user_id) return { userId: c.owner_user_id, ownerUserId: c.owner_user_id, stage: c.stage, periodSeq: c.ownership_period_seq === null ? null : Number(c.ownership_period_seq), firstName: c.first_name };
  const tl = await sql<{ user_id: string }>`
    SELECT m.user_id FROM memberships m
      LEFT JOIN team_members tm ON tm.tenant_id = m.tenant_id AND tm.user_id = m.user_id AND tm.is_lead
      LEFT JOIN teams t ON t.tenant_id = tm.tenant_id AND t.id = tm.team_id
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active' AND m.role IN ('team_lead','admin','owner')
     ORDER BY (m.role = 'team_lead') DESC, (t.is_default IS TRUE) DESC, (m.role = 'admin') DESC, m.user_id LIMIT 1`.execute(tx);
  return { userId: tl.rows[0]?.user_id ?? null, ownerUserId: null, stage: c.stage, periodSeq: null, firstName: c.first_name };
}

export async function adminUserIds(tx: Tx): Promise<string[]> {
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND status = 'active' AND role IN ('owner','admin') ORDER BY user_id`.execute(tx);
  return r.rows.map((x) => x.user_id);
}
