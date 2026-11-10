// Message reads/writes of the worker's comms.dispatch_stale handler (system actor, one tenant).
import type { ContactId, Instant } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export const DISPATCH_STALE_AFTER_MS = 20 * 60 * 1000; // max job lease 15 min + 5 min margin (F2)

export async function messageDispatchState(tx: Tx, messageId: string): Promise<{ contactId: ContactId; status: string; dispatchedAt: Instant | null } | null> {
  const r = await sql<{ contact_id: string; status: string; dispatched_at: Date | null }>`
    SELECT contact_id, status, dispatched_at FROM messages
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND direction = 'outbound'`.execute(tx);
  const x = r.rows[0];
  return x ? { contactId: x.contact_id as ContactId, status: x.status, dispatchedAt: x.dispatched_at ? instantFromDate(x.dispatched_at) : null } : null;
}

/**
 * dispatching → dispatch_unknown, only while still `dispatching` and only once dispatched_at is older
 * than the stale threshold by the DB clock. Returns whether the row moved. Never touches any other status
 * (a late TX2 that already wrote sent/delivered/failed wins), and never re-sends.
 */
export async function markDispatchUnknown(tx: Tx, messageId: string): Promise<boolean> {
  const r = await sql`
    UPDATE messages SET status = 'dispatch_unknown', status_reason = 'DISPATCH_STALE'
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND direction = 'outbound' AND status = 'dispatching'
       AND dispatched_at <= clock_timestamp() - make_interval(secs => ${DISPATCH_STALE_AFTER_MS / 1000})`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}
