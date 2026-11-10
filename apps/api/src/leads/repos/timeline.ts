// Contact timeline (BUILD_PLAN module 11): the `contact_timeline` view (security_invoker, so the
// caller's RLS applies to every base table: messages, calls, notes, the ownership ledger,
// appointments, behavior events). Keyset pagination on (occurred_at, item_id), newest first.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface TimelineRow {
  occurred_at: Date;
  item_type: string;
  item_id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  detail: string | null;
  preview: string | null;
  provenance: string;
  note: string | null;
  /** messages only: messages.status (null for other item types) */
  status: string | null;
  /** occurred_at as Postgres text (keyset cursors keep microseconds) */
  at_text: string;
}

export async function timeline(tx: Tx, contactId: string, limit: number, before: { at: string; id: string } | null): Promise<TimelineRow[]> {
  const r = await sql<TimelineRow>`
    SELECT t.occurred_at, t.occurred_at::text AS at_text, t.item_type, t.item_id, t.actor_user_id, u.display_name AS actor_name, t.detail, t.preview,
           t.provenance,
           CASE WHEN t.item_type = 'ownership' THEN (SELECT e.note FROM lead_ownership_events e
                                                    WHERE e.tenant_id = t.tenant_id AND e.event_id = t.item_id) END AS note,
           CASE WHEN t.item_type = 'message' THEN (SELECT m.status FROM messages m
                                                   WHERE m.tenant_id = t.tenant_id AND m.id = t.item_id) END AS status
      FROM contact_timeline t
      LEFT JOIN users u ON u.id = t.actor_user_id
     WHERE t.tenant_id = app.tenant_id() AND t.contact_id = ${contactId}::uuid
       AND (${before === null} OR (t.occurred_at, t.item_id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid))
     ORDER BY t.occurred_at DESC, t.item_id DESC
     LIMIT ${limit}`.execute(tx);
  return r.rows;
}
