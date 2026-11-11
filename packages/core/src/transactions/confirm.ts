// Confirming a milestone date: the stored instants (PHASE2_3_PLAN module 30; R-TXN-1, R-TXN-2,
// R-TXN-5, R-OWN-27, E96, E142, E143).
//
// confirmDate is called by module 31 for every deal-date write that confirms or moves a date, also
// from the Phase 1 deal-screen routes. It computes, once and in the tenant zone recorded in `basis`:
//   due_at       the end of the due day (23:59:59 local), so a deal spanning a DST change still has
//                its deadline at local end of day (E143);
//   reminder_at  `reminderDaysBefore` local days before the due date at the reminder local time
//                (09:00 by default); a reminder whose time already passed while the date is still
//                ahead is set to `now` (the next reconcile pass fires it once; firings are keyed
//                `txn:{deal_date}:{due_version}:{step}`, so a re-confirm never sends twice);
//                none once the due day has ended;
//   due_version  bumped when a confirmed date moves, exactly like the DB trigger, so drafts and
//                firings bound to the old version go stale (R-TXN-5, E96, E142).
// Only a person confirms, enters or moves a date (R-TXN-1; the DB guard `deal_dates_confirm_guard`
// enforces the same). Settings changes never move stored instants: nothing here re-reads a setting
// for an existing confirmed date except `repairInstants`, which only fills a missing `due_at` and
// prefers the zone already recorded in the basis (R-OWN-27).
import {
  type IanaZone,
  type Instant,
  type LocalDate,
  type Result,
  SECOND_MS,
  fail,
  ianaZone,
  instant,
  localDate,
  localTime,
  ok,
  resolveLocal,
} from '../foundation/index.js';
import { addCalendarDays } from './dates.js';
import type { Basis, ConfirmInput, ConfirmedInstants, DealDate, ProposalBasis, TransactionErrorCode } from './types.js';

export const DEFAULT_REMINDER_LOCAL_TIME = '09:00';
export const MAX_REMINDER_DAYS_BEFORE = 60;

/** The last second of local day `d` in `zone`: the start of the next local day minus one second. */
export function endOfLocalDay(d: LocalDate, zone: IanaZone): Instant {
  const nextStart = resolveLocal(addCalendarDays(localDate(d), 1), localTime('00:00'), zone, 'earlier');
  return instant(nextStart - SECOND_MS);
}

/** The proposal part of a stored basis (drops the zone and instant rules of an earlier confirm). */
export function proposalBasisOf(b: DealDate['basis'] | undefined): ProposalBasis {
  if (b === undefined || !('kind' in b)) return { kind: 'manual' };
  const { zone: _z, dueRule: _d, reminderRule: _r, ...rest } = b as Basis;
  return rest as ProposalBasis;
}

function computeReminder(
  dueOn: LocalDate,
  dueAt: Instant,
  daysBefore: number | null,
  time: string,
  zone: IanaZone,
  now: Instant,
): Instant | null {
  if (daysBefore === null) return null;
  if (dueAt <= now) return null; // the due day has ended: nothing is upcoming any more
  const at = resolveLocal(addCalendarDays(dueOn, -daysBefore), localTime(time), zone, 'earlier');
  return at < now ? now : instant(Math.min(at, dueAt));
}

function reminderFields(input: Pick<ConfirmInput, 'reminderDaysBefore' | 'reminderLocalTime'>):
  | { ok: true; daysBefore: number | null; time: string }
  | { ok: false } {
  const daysBefore = input.reminderDaysBefore ?? null;
  if (daysBefore !== null && (!Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > MAX_REMINDER_DAYS_BEFORE)) return { ok: false };
  const time = input.reminderLocalTime ?? DEFAULT_REMINDER_LOCAL_TIME;
  try {
    localTime(time);
  } catch {
    return { ok: false };
  }
  return { ok: true, daysBefore, time };
}

/**
 * Confirms (or re-confirms, or moves) a date. `prev` is the stored row, or null for a new date.
 * `zone` is `tenant_settings.default_timezone` at this moment; it is recorded in the basis.
 */
export function confirmDate(prev: DealDate | null, input: ConfirmInput, zone: IanaZone): Result<ConfirmedInstants, TransactionErrorCode> {
  if (input.actor.kind !== 'user') return fail('DATE_HUMAN_CONFIRMATION');
  if (prev !== null && prev.completedAt !== null) return fail('DATE_COMPLETED');
  if (prev !== null && prev.status === 'waived') return fail('DATE_WAIVED');
  const rem = reminderFields(input);
  if (!rem.ok) return fail('REMINDER_INVALID');
  const dueOn = localDate(input.dueOn);
  const moved = prev !== null && prev.status === 'confirmed' && prev.dueOn !== dueOn;
  const dueVersion = prev === null ? 1 : moved ? prev.dueVersion + 1 : prev.dueVersion;
  const dueAt = endOfLocalDay(dueOn, zone);
  const reminderAt = computeReminder(dueOn, dueAt, rem.daysBefore, rem.time, zone, input.now);
  const basis: Basis = {
    ...(input.basis ?? proposalBasisOf(prev?.basis)),
    zone,
    dueRule: 'end_of_local_day',
    reminderRule: rem.daysBefore === null ? null : { daysBefore: rem.daysBefore, localTime: rem.time },
  };
  return ok({ dueAt, reminderAt, dueVersion, basis });
}

/**
 * The milestones reconcile repair (R-TXN-2): a confirmed, uncompleted date whose `due_at` is missing
 * (typed on the Phase 1 screen before module 31, or dropped by a move the writer did not recompute)
 * gets its instants. It never moves the date and never bumps the version, so the system may run it.
 * The zone already recorded in the basis wins over the current tenant zone (R-OWN-27). Returns null
 * when there is nothing to repair.
 */
export function repairInstants(
  d: DealDate,
  tenantZone: IanaZone,
  now: Instant,
): { dueAt: Instant; reminderAt: Instant | null; basis: Basis } | null {
  if (d.status !== 'confirmed' || d.completedAt !== null || d.dueAt !== null) return null;
  const stored = 'kind' in d.basis ? (d.basis as Partial<Basis>) : {};
  const zone = (typeof stored.zone === 'string' ? ianaZone(stored.zone) : null) ?? tenantZone;
  const rule = stored.reminderRule ?? null;
  const dueAt = endOfLocalDay(d.dueOn, zone);
  const reminderAt = rule === null ? null : computeReminder(d.dueOn, dueAt, rule.daysBefore, rule.localTime, zone, now);
  return { dueAt, reminderAt, basis: { ...proposalBasisOf(d.basis), zone, dueRule: 'end_of_local_day', reminderRule: rule } };
}

/** R-TXN-2: only confirmed, uncompleted dates with stored instants drive reminders, risks and updates. */
export function drivesUpdates(d: Pick<DealDate, 'status' | 'completedAt' | 'dueAt'>): boolean {
  return d.status === 'confirmed' && d.completedAt === null && d.dueAt !== null;
}

/**
 * E142 / R-TXN-5: a draft or trigger firing bound to (deal date, due_version) is stale when the date
 * no longer drives updates or its version moved on. Approving a stale draft returns DRAFT_STALE.
 */
export function boundVersionStale(bound: { dueVersion: number }, current: Pick<DealDate, 'status' | 'completedAt' | 'dueAt' | 'dueVersion'> | null): boolean {
  return current === null || !drivesUpdates(current) || current.dueVersion !== bound.dueVersion;
}
