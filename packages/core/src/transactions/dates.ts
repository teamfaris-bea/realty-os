// Local-date arithmetic for milestone plans (PHASE2_3_PLAN module 30; R-TXN-6, E95).
//
// Dates are contract dates (`deal_dates.due_on`, a Postgres `date`): local calendar dates with no
// zone. They are counted on the proleptic Gregorian calendar via UTC wall milliseconds, so DST can
// never shift a date. Business days are whatever the supplied BusinessDayCalendar says.
// **VERIFY WITH COUNSEL** (C9): which days count and which holidays exist are tenant data.
import { DAY_MS, type LocalDate, type Weekday, isoWeekdayOfWall, localDate } from '../foundation/index.js';
import type { BusinessDayCalendar, NonBusinessDayNote } from './types.js';

/** Hard bound on any single offset (a template rule beyond a year is a data error). */
export const MAX_OFFSET_DAYS = 366;

function wallOf(d: LocalDate): number {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
}

function dateOfWall(wall: number): LocalDate {
  return localDate(new Date(wall).toISOString().slice(0, 10));
}

/** `d` plus `days` calendar days (negative: earlier). */
export function addCalendarDays(d: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError('addCalendarDays: days must be an integer');
  return dateOfWall(wallOf(localDate(d)) + days * DAY_MS);
}

/** ISO weekday (1 = Monday) of a local date. */
export function weekdayOfDate(d: LocalDate): Weekday {
  return isoWeekdayOfWall(wallOf(localDate(d)));
}

/** Whole calendar days from `a` to `b` (b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((wallOf(localDate(b)) - wallOf(localDate(a))) / DAY_MS);
}

/** Why `d` is not a business day, or null when it is one. */
export function nonBusinessDay(d: LocalDate, cal: BusinessDayCalendar): NonBusinessDayNote | null {
  const holiday = cal.holidays.get(d);
  if (holiday !== undefined) {
    return { reason: 'holiday', holiday, note: `${d} is a holiday (${holiday}) in the ${cal.source} calendar. The date was not moved; check the contract before confirming.` };
  }
  if (!cal.days.has(weekdayOfDate(d))) {
    return { reason: 'weekend', note: `${d} is not a business day in the ${cal.source} calendar. The date was not moved; check the contract before confirming.` };
  }
  return null;
}

/**
 * The `n`-th business day after `anchor` (n = 0 is the anchor itself, whatever day it is). Day 1 is
 * the first business day strictly after the anchor. **VERIFY WITH COUNSEL** (C9): some forms count
 * the anchor day; a template that means that sets its offset accordingly.
 */
export function addBusinessDays(anchor: LocalDate, n: number, cal: BusinessDayCalendar): LocalDate {
  if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET_DAYS) throw new RangeError(`addBusinessDays: n must be an integer in 0..${MAX_OFFSET_DAYS}`);
  if (cal.days.size === 0) throw new RangeError('addBusinessDays: the calendar has no business weekdays');
  let d = localDate(anchor);
  let counted = 0;
  // Every week has at least one business weekday, so n business days lie within
  // 7 * (n + holidays + 1) calendar days.
  const bound = 7 * (n + cal.holidays.size + 1);
  for (let i = 0; counted < n; i++) {
    if (i > bound) throw new RangeError('addBusinessDays: no business day found (calendar data error)');
    d = addCalendarDays(d, 1);
    if (nonBusinessDay(d, cal) === null) counted++;
  }
  return d;
}

/** A calendar with the given business weekdays and holidays (tenant data, unreviewed by default). */
export function businessDayCalendar(i: {
  days?: Iterable<Weekday>;
  holidays?: Iterable<readonly [string, string]> | Readonly<Record<string, string>>;
  source?: string;
  reviewed?: boolean;
}): BusinessDayCalendar {
  const days = new Set<Weekday>(i.days ?? [1, 2, 3, 4, 5]);
  for (const d of days) if (!Number.isInteger(d) || d < 1 || d > 7) throw new RangeError(`businessDayCalendar: bad weekday ${String(d)}`);
  if (days.size === 0) throw new RangeError('businessDayCalendar: at least one business weekday is required');
  const entries: Iterable<readonly [string, string]> =
    i.holidays === undefined ? [] : Symbol.iterator in i.holidays ? (i.holidays as Iterable<readonly [string, string]>) : Object.entries(i.holidays);
  const holidays = new Map<LocalDate, string>();
  for (const [d, name] of entries) holidays.set(localDate(d), name);
  return { days, holidays, source: i.source ?? 'tenant_settings', reviewed: i.reviewed ?? false };
}
