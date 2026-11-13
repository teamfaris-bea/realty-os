// The slots an AI call may offer (module 48 item 3; R-VOICE-4, E151, E428). Read in their own system transaction
// AFTER the takeover commits, never under the contact lock (a calendar read can take a second). Product defaults
// (each one constant): up to 6 slots of 30 minutes in the next 7 days, inside routing hours, starting at least 2 h
// from now, on half-hour boundaries, free per busyForBooking (the same busy times bookSlot reads). No owner, an
// owner who is not an active member, or a calendar that does not answer ⇒ no slots (E428). bookSlot stays the
// authority: a slot offered here can still be taken before the caller picks it (E151, SLOT_TAKEN).
import type { Instant, TenantId } from '@realty/core/foundation';
import { type BusinessCalendar, isBusinessOpen, toIso } from '@realty/core/foundation';
import type { OfferedSlot } from '@realty/core/voice';
import { type Database, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { type CalendarDeps, busyForBooking } from '../calendar/service.js';
import { systemActor } from '../worker/systemActor.js';

export const MAX_OFFERED_SLOTS = 6;
export const SLOT_MINUTES = 30;
export const SLOT_HORIZON_DAYS = 7;
export const SLOT_LEAD_HOURS = 2;

const MIN = 60_000;

/** Pure: the free half-hour slots in [now + lead, now + horizon) inside routing hours, earliest first. */
export function freeSlots(now: Instant, hours: BusinessCalendar, busy: readonly { start: string; end: string }[]): OfferedSlot[] {
  const len = SLOT_MINUTES * MIN;
  const first = Math.ceil((now + SLOT_LEAD_HOURS * 60 * MIN) / len) * len;
  const last = now + SLOT_HORIZON_DAYS * 24 * 60 * MIN;
  const taken = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const);
  const out: OfferedSlot[] = [];
  for (let t = first; t + len <= last && out.length < MAX_OFFERED_SLOTS; t += len) {
    if (!isBusinessOpen(t as Instant, hours) || !isBusinessOpen((t + len - 1) as Instant, hours)) continue;
    if (taken.some(([s, e]) => s < t + len && e > t)) continue;
    out.push({ start: t as Instant, end: (t + len) as Instant });
  }
  return out;
}

export async function offeredSlots(o: { db: Database; calendar: CalendarDeps; tenantId: string; ownerUserId: string | null; hours: BusinessCalendar; now: Instant }): Promise<OfferedSlot[]> {
  if (!o.ownerUserId) return [];
  const owner = o.ownerUserId;
  return withTenantTx(systemActor(o.tenantId, 'provider'), async (tx) => {
    const active = await sql<{ ok: boolean }>`SELECT status = 'active' AS ok FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${owner}`.execute(tx);
    if (active.rows[0]?.ok !== true) return [];
    const range = { start: toIso(o.now), end: toIso((o.now + SLOT_HORIZON_DAYS * 24 * 60 * MIN) as Instant) };
    // VERIFY: busyForBooking (and bookSlot) latency on a live call; a slow read delays the offer, never the disclosure
    const b = await busyForBooking(o.calendar, tx, o.tenantId as TenantId, owner, range);
    if (b.calendar === 'unavailable') return [];
    return freeSlots(o.now, o.hours, b.busy);
  }, { db: o.db, retries: 1 });
}
