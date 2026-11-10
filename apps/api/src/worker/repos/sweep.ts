// Sweeper reads inside ONE tenant's system transaction: the stored deadlines and fences of the contacts
// app.due_work reported (R-OWN-15: the sweeper reads only stored instants, never live settings).
import type { ContactId, Instant } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface ContactTimerRow {
  id: ContactId;
  state: string;
  offerId: string | null;
  periodSeq: number | null;
  firstTouchDueAt: Instant | null;
  firstTouchAt: Instant | null;
  firstTouchBreachedAt: Instant | null;
  releaseDueAt: Instant | null;
  inactivityWarnAt: Instant | null;
  inactivityReleaseAt: Instant | null;
  routeDueAt: Instant | null;
  commandId: string;
}

const ts = (d: Date | null): Instant | null => (d ? instantFromDate(d) : null);

export async function contactTimerRows(tx: Tx, ids: readonly string[]): Promise<Map<string, ContactTimerRow>> {
  if (ids.length === 0) return new Map();
  const r = await sql<{
    id: string;
    ownership_state: string;
    offer_id: string | null;
    ownership_period_seq: string | null;
    first_touch_due_at: Date | null;
    first_touch_at: Date | null;
    first_touch_breached_at: Date | null;
    release_due_at: Date | null;
    inactivity_warn_at: Date | null;
    inactivity_release_at: Date | null;
    route_due_at: Date | null;
    ownership_command_id: string;
  }>`
    SELECT id, ownership_state, offer_id, ownership_period_seq, first_touch_due_at, first_touch_at, first_touch_breached_at,
           release_due_at, inactivity_warn_at, inactivity_release_at, route_due_at, ownership_command_id
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return new Map(
    r.rows.map((x) => [
      x.id,
      {
        id: x.id as ContactId,
        state: x.ownership_state,
        offerId: x.offer_id,
        periodSeq: x.ownership_period_seq === null ? null : Number(x.ownership_period_seq),
        firstTouchDueAt: ts(x.first_touch_due_at),
        firstTouchAt: ts(x.first_touch_at),
        firstTouchBreachedAt: ts(x.first_touch_breached_at),
        releaseDueAt: ts(x.release_due_at),
        inactivityWarnAt: ts(x.inactivity_warn_at),
        inactivityReleaseAt: ts(x.inactivity_release_at),
        routeDueAt: ts(x.route_due_at),
        commandId: x.ownership_command_id,
      },
    ]),
  );
}
