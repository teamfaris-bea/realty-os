// bulk_actions / bulk_action_items persistence and the per-person facts a bulk preflight reads (parity module
// 63; R-PAR-33..R-PAR-42). Every query runs under the caller's RLS: the creator as themself (draft, confirm,
// each run item), Owner/Admin (cancel), or the system actor (run bookkeeping, notices).
import type { Tx } from '@realty/db';
import { hmacBytes } from '@realty/db';
import { sql } from 'kysely';

export interface ActionRow {
  id: string;
  kind: 'tag' | 'untag' | 'stage' | 'assign' | 'enroll' | 'email' | 'text';
  status: 'draft' | 'confirmed' | 'running' | 'completed' | 'canceled' | 'failed';
  createdByUserId: string;
  createdByRole: string;
  source: 'selection' | 'smart_list';
  smartListId: string | null;
  params: Record<string, unknown>;
  templateId: string | null;
  templateVersion: number | null;
  subjectSnapshot: string | null;
  bodySnapshot: string | null;
  targetCount: number | null;
  counts: Record<string, unknown>;
  idempotencyKey: string;
  confirmedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
}

interface Raw {
  id: string;
  kind: ActionRow['kind'];
  status: ActionRow['status'];
  created_by_user_id: string;
  created_by_role: string;
  source: ActionRow['source'];
  smart_list_id: string | null;
  params: Record<string, unknown>;
  template_id: string | null;
  template_version: number | null;
  subject_snapshot: string | null;
  body_snapshot: string | null;
  target_count: number | null;
  counts: Record<string, unknown>;
  idempotency_key: string;
  confirmed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested_at: Date | null;
  failure_code: string | null;
  created_at: Date;
}

const COLS = sql`id, kind, status, created_by_user_id, created_by_role, source, smart_list_id, params, template_id, template_version,
  subject_snapshot, body_snapshot, target_count, counts, idempotency_key, confirmed_at, started_at, finished_at, cancel_requested_at,
  failure_code, created_at`;

const row = (x: Raw): ActionRow => ({
  id: x.id,
  kind: x.kind,
  status: x.status,
  createdByUserId: x.created_by_user_id,
  createdByRole: x.created_by_role,
  source: x.source,
  smartListId: x.smart_list_id,
  params: x.params,
  templateId: x.template_id,
  templateVersion: x.template_version === null ? null : Number(x.template_version),
  subjectSnapshot: x.subject_snapshot,
  bodySnapshot: x.body_snapshot,
  targetCount: x.target_count === null ? null : Number(x.target_count),
  counts: x.counts,
  idempotencyKey: x.idempotency_key,
  confirmedAt: x.confirmed_at,
  startedAt: x.started_at,
  finishedAt: x.finished_at,
  cancelRequestedAt: x.cancel_requested_at,
  failureCode: x.failure_code,
  createdAt: x.created_at,
});

export async function actionById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<ActionRow | null> {
  const r = o.lock
    ? await sql<Raw>`SELECT ${COLS} FROM bulk_actions WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<Raw>`SELECT ${COLS} FROM bulk_actions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function actionByKey(tx: Tx, key: string): Promise<ActionRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM bulk_actions WHERE tenant_id = app.tenant_id() AND idempotency_key = ${key}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** The caller's recent actions (the creator, tenant-wide roles, the creator's TL: RLS). */
export async function recentActions(tx: Tx, limit: number): Promise<ActionRow[]> {
  const r = await sql<Raw>`SELECT ${COLS} FROM bulk_actions WHERE tenant_id = app.tenant_id() ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(tx);
  return r.rows.map(row);
}

export interface ActionInsert {
  id: string;
  kind: ActionRow['kind'];
  role: string;
  source: 'selection' | 'smart_list';
  smartListId: string | null;
  params: Record<string, unknown>;
  templateId: string | null;
  templateVersion: number | null;
  subject: string | null;
  body: string | null;
  idempotencyKey: string;
}

/** A draft as the creator (RLS: created_by = me, role = my role). false when the key exists already. */
export async function insertDraft(tx: Tx, a: ActionInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, smart_list_id, params, template_id,
                              template_version, subject_snapshot, body_snapshot, idempotency_key)
    VALUES (app.tenant_id(), ${a.id}, ${a.kind}, app.user_id(), ${a.role}, ${a.source}, ${a.smartListId}, ${JSON.stringify(a.params)}::jsonb,
            ${a.templateId}, ${a.templateVersion}, ${a.subject}, ${a.body}, ${a.idempotencyKey})
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

/** The frozen target: one pending item per person (and its one address, for sends). */
export async function insertItems(tx: Tx, actionId: string, items: readonly { contactId: string; addressHmac: string | null }[]): Promise<void> {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    await sql`
      INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id, address_hmac)
      SELECT app.tenant_id(), ${actionId}::uuid, x.contact_id, x.address_hmac
        FROM unnest(${chunk.map((c) => c.contactId)}::uuid[], ${chunk.map((c) => (c.addressHmac ? hmacBytes(c.addressHmac) : null))}::bytea[])
             AS x(contact_id, address_hmac)`.execute(tx);
  }
}

/** Draft bookkeeping: the frozen count and the preflight counts (creator, while a draft). */
export async function setDraftCounts(tx: Tx, id: string, targetCount: number, counts: Record<string, unknown>): Promise<void> {
  await sql`UPDATE bulk_actions SET target_count = ${targetCount}, counts = ${JSON.stringify(counts)}::jsonb
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function setCounts(tx: Tx, id: string, counts: Record<string, unknown>): Promise<void> {
  await sql`UPDATE bulk_actions SET counts = ${JSON.stringify(counts)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** draft → confirmed by the creator (the DB guard checks creator, role, frozen count and the text switch). */
export async function markConfirmed(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'draft'`.execute(tx);
}

export async function markRunning(tx: Tx, id: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE bulk_actions SET status = 'running', started_at = COALESCE(started_at, now())
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'confirmed' RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export async function markFinished(tx: Tx, id: string, status: 'completed' | 'failed', counts: Record<string, unknown>, failureCode: string | null): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE bulk_actions SET status = ${status}, finished_at = now(), counts = ${JSON.stringify(counts)}::jsonb, failure_code = ${failureCode}
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('confirmed','running') RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export async function markCanceled(tx: Tx, id: string, counts: Record<string, unknown>): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE bulk_actions SET status = 'canceled', finished_at = now(), cancel_requested_at = COALESCE(cancel_requested_at, now()),
           cancel_requested_by = COALESCE(cancel_requested_by, app.user_id()), counts = ${JSON.stringify(counts)}::jsonb
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('draft','confirmed','running') RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export interface ItemRow {
  contactId: string;
  status: 'pending' | 'done' | 'skipped' | 'blocked' | 'failed' | 'canceled';
  reasonCode: string | null;
  addressHmac: string | null;
  messageId: string | null;
}

interface RawItem {
  contact_id: string;
  status: ItemRow['status'];
  reason_code: string | null;
  address_hmac: Buffer | null;
  message_id: string | null;
}

const item = (x: RawItem): ItemRow => ({ contactId: x.contact_id, status: x.status, reasonCode: x.reason_code, addressHmac: x.address_hmac ? x.address_hmac.toString('hex') : null, messageId: x.message_id });

/** Pending items in a stable order (by contact id), after `after` (keyset). */
export async function pendingItems(tx: Tx, actionId: string, after: string | null, limit: number): Promise<ItemRow[]> {
  const r = await sql<RawItem>`
    SELECT contact_id, status, reason_code, address_hmac, message_id FROM bulk_action_items
     WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND status = 'pending'
       AND (${after}::uuid IS NULL OR contact_id > ${after}::uuid)
     ORDER BY contact_id LIMIT ${limit}`.execute(tx);
  return r.rows.map(item);
}

/** One item locked for its transaction; null when not visible (RLS: the person's detail) or gone. */
export async function lockItem(tx: Tx, actionId: string, contactId: string): Promise<ItemRow | null> {
  const r = await sql<RawItem>`
    SELECT contact_id, status, reason_code, address_hmac, message_id FROM bulk_action_items
     WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND contact_id = ${contactId} FOR UPDATE`.execute(tx);
  return r.rows[0] ? item(r.rows[0]) : null;
}

/** A processed item is final (DB): only a pending item moves. Returns whether it moved. */
export async function finishItem(tx: Tx, actionId: string, contactId: string, status: Exclude<ItemRow['status'], 'pending'>, reasonCode: string | null, messageId: string | null = null): Promise<boolean> {
  const r = await sql<{ contact_id: string }>`
    UPDATE bulk_action_items SET status = ${status}, reason_code = ${reasonCode}, processed_at = now(), message_id = COALESCE(${messageId}::uuid, message_id)
     WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND contact_id = ${contactId} AND status = 'pending'
    RETURNING contact_id`.execute(tx);
  return r.rows.length === 1;
}

/** Cancel: every pending item of the action (creator, Owner/Admin through the system, or the runner). */
export async function cancelPendingItems(tx: Tx, actionId: string, reason: string): Promise<number> {
  const r = await sql<{ n: string }>`
    WITH x AS (UPDATE bulk_action_items SET status = 'canceled', reason_code = ${reason}, processed_at = now()
                WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND status = 'pending' RETURNING 1)
    SELECT count(*)::text AS n FROM x`.execute(tx);
  return Number(r.rows[0]?.n ?? 0);
}

/** R-PAR-42: queued, not-yet-dispatching messages of the action are canceled with it (system). */
export async function cancelQueuedMessages(tx: Tx, actionId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    UPDATE messages SET status = 'canceled', status_reason = 'BULK_CANCELED'
     WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Item outcomes for the counts (system: every item; a reader: the items RLS shows them). */
export async function itemOutcomes(tx: Tx, actionId: string): Promise<{ status: ItemRow['status']; reasonCode: string | null }[]> {
  const r = await sql<{ status: ItemRow['status']; reason_code: string | null }>`
    SELECT status, reason_code FROM bulk_action_items WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId}`.execute(tx);
  return r.rows.map((x) => ({ status: x.status, reasonCode: x.reason_code }));
}

/** Messages of the action still in flight (dispatching / dispatch_unknown follow the comms sweeper). */
export async function inFlightMessages(tx: Tx, actionId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM messages WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND status = 'dispatching'`.execute(tx);
  return Number(r.rows[0]?.n ?? 0);
}

export async function messageStatus(tx: Tx, messageId: string): Promise<{ status: string; statusReason: string | null } | null> {
  const r = await sql<{ status: string; status_reason: string | null }>`SELECT status, status_reason FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx);
  return r.rows[0] ? { status: r.rows[0].status, statusReason: r.rows[0].status_reason } : null;
}

/** The message a bulk send key created for this action, if any (a replay after a crash). */
export async function messageByKey(tx: Tx, key: string): Promise<{ id: string; status: string } | null> {
  const r = await sql<{ id: string; status: string }>`SELECT id, status FROM messages WHERE tenant_id = app.tenant_id() AND idempotency_key = ${key}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function cancelMessage(tx: Tx, messageId: string, reason: string): Promise<void> {
  await sql`UPDATE messages SET status = 'canceled', status_reason = ${reason}
             WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND status IN ('queued','scheduled')`.execute(tx);
}

// ---- tenant facts ---------------------------------------------------------------------------------

export async function batchTextEnabled(tx: Tx): Promise<boolean> {
  const r = await sql<{ on: boolean }>`SELECT batch_text_enabled AS on FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.on === true;
}

/**
 * Q-PAR-7: recipients of bulk emails confirmed in the tenant's current local day, by ANY creator. Must run
 * as the system actor (an agent sees only their own actions); the caller holds the tenant's bulk-email
 * advisory lock so two confirms cannot both pass the cap.
 */
export async function emailsConfirmedToday(tx: Tx): Promise<number> {
  const r = await sql<{ n: string | null }>`
    SELECT COALESCE(sum(b.target_count), 0)::text AS n
      FROM bulk_actions b JOIN tenant_settings s ON s.tenant_id = b.tenant_id
     WHERE b.tenant_id = app.tenant_id() AND b.kind = 'email' AND b.confirmed_at IS NOT NULL
       AND (b.confirmed_at AT TIME ZONE s.default_timezone)::date = (now() AT TIME ZONE s.default_timezone)::date`.execute(tx);
  return Number(r.rows[0]?.n ?? 0);
}

/** A transaction-scoped advisory lock on the tenant's daily bulk-email budget. */
export async function lockEmailBudget(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('bulk_email_budget:' || app.tenant_id()::text, 0))`.execute(tx);
}

/** An approved sender registration covering marketing use (R-PAR-40), for the team main or the creator's number. */
export async function smsMarketingRegistered(tx: Tx): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM phone_numbers n JOIN sender_registrations g ON g.tenant_id = n.tenant_id AND g.id = n.registration_id
       WHERE n.tenant_id = app.tenant_id() AND n.released_at IS NULL AND n.sms_capable AND g.status = 'approved'
         AND (n.purpose = 'team_main' OR (n.purpose = 'agent_direct' AND n.assigned_user_id = app.user_id()))
         AND g.use_case ~* 'marketing|promotion|mixed') AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

// ---- notifications ----------------------------------------------------------------------------------

/** One text-free notification with its in-app and push deliveries (system actor). */
export async function notify(tx: Tx, id: string, n: { userId: string; kind: 'bulk_finished' | 'reassigned_to_you' | 'reassigned_away'; title: string; body: string | null; subjectId: string; dedupeKey: string }, deliveryIds: () => string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
    VALUES (app.tenant_id(), ${id}, ${n.userId}, ${n.kind}, 'normal', ${n.title.slice(0, 120)}, ${n.body === null ? null : n.body.slice(0, 240)},
            'bulk_action', ${n.subjectId}, ${n.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING RETURNING id`.execute(tx);
  if (r.rows.length === 0) return false;
  await sql`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status)
            VALUES (app.tenant_id(), ${deliveryIds()}, ${id}, 'in_app', 'in_app', 'delivered')`.execute(tx);
  const subs = await sql<{ id: string }>`SELECT id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND user_id = ${n.userId} AND revoked_at IS NULL ORDER BY id`.execute(tx);
  for (const s of subs.rows) {
    await sql`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
              VALUES (app.tenant_id(), ${deliveryIds()}, ${id}, 'web_push', ${s.id}, 'pending', now())
              ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
  }
  return true;
}
