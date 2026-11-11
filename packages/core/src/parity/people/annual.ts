// Annual dates (R-PAR-20): birthdays and home anniversaries. The next occurrence is computed in the
// tenant's timezone; 29 February falls on 28 February in non-leap years. Nothing is ever sent by this.
import { type IanaZone, type LocalDate, localDate, localDateOf } from '../../foundation/tz.js';
import type { Instant } from '../../foundation/time.js';
import { DAY_MS, daysInMonth } from '../../foundation/time.js';

function parts(d: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new RangeError(`bad date ${d}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** The month/day of `date` in `year` (29 Feb → 28 Feb when `year` is not a leap year). */
export function occurrenceIn(date: LocalDate, year: number): LocalDate {
  const [, m, d] = parts(date);
  const day = Math.min(d, daysInMonth(year, m));
  return localDate(`${pad(year, 4)}-${pad(m)}-${pad(day)}`);
}

/** The next occurrence of an annual date on or after today (local to `tz` at `now`). */
export function nextAnnualOccurrence(date: LocalDate, tz: IanaZone, now: Instant): LocalDate {
  const today = localDateOf(now, tz);
  const [y] = parts(today);
  const thisYear = occurrenceIn(date, y);
  return thisYear >= today ? thisYear : occurrenceIn(date, y + 1);
}

/** Whole days from today (local) to the next occurrence: 0 = today. */
export function daysUntilAnnual(date: LocalDate, tz: IanaZone, now: Instant): number {
  const today = localDateOf(now, tz);
  const next = nextAnnualOccurrence(date, tz, now);
  const [a, b, c] = parts(today);
  const [x, y, z] = parts(next);
  return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / DAY_MS);
}

/** "Coming up in N days": the next occurrence is within [0, days]. */
export function annualComingUp(date: LocalDate, tz: IanaZone, now: Instant, days: number): boolean {
  return daysUntilAnnual(date, tz, now) <= days;
}
