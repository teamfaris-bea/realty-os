// "Coming up in N days" for annual date fields (R-PAR-20; E176).
//
// The next occurrence is computed in the tenant's timezone from the stored month and day (the year of
// a birthday never matters). 29 February falls on 28 February in non-leap years. The result is a set
// of month-day keys (month × 100 + day, the expression of `contact_field_values_md_idx`), so the
// database compares integers with bound parameters and never computes dates from input. Pure.
import { type IanaZone, type Instant, localDateOf } from '../../foundation/index.js';

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** The local calendar day `n` days after (y, m, d). */
function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  let yy = y;
  let mm = m;
  let dd = d + n;
  while (dd > daysIn(yy, mm)) {
    dd -= daysIn(yy, mm);
    mm += 1;
    if (mm > 12) {
      mm = 1;
      yy += 1;
    }
  }
  return [yy, mm, dd];
}

/**
 * The month-day keys whose next occurrence falls within [today, today + days] in `zone`, today
 * included. A 29 February value is included on 28 February of a non-leap year.
 */
export function comingUpMonthDays(now: Instant, zone: IanaZone, days: number): number[] {
  if (!Number.isInteger(days) || days < 0) throw new RangeError('days must be a non-negative integer');
  const [y, m, d] = String(localDateOf(now, zone)).split('-').map(Number) as [number, number, number];
  const keys = new Set<number>();
  const span = Math.min(days, 366);
  for (let i = 0; i <= span; i++) {
    const [yy, mm, dd] = addDays(y, m, d, i);
    keys.add(mm * 100 + dd);
    if (mm === 2 && dd === 28 && !isLeapYear(yy)) keys.add(229);
  }
  return [...keys].sort((a, b) => a - b);
}

/** The month-day key after `k` on a leap-year calendar (229 follows 228; 101 follows 1231). */
function nextMonthDay(k: number): number {
  const m = Math.floor(k / 100);
  const d = k % 100;
  if (d < daysIn(2000, m)) return k + 1;
  return m === 12 ? 101 : (m + 1) * 100 + 1;
}

/** Collapses month-day keys into inclusive [from, to] ranges of consecutive keys (sorted, no wrap). */
export function monthDayRanges(keys: readonly number[]): [number, number][] {
  const sorted = [...new Set(keys)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && nextMonthDay(last[1]) === k) last[1] = k;
    else out.push([k, k]);
  }
  return out;
}

/** The next occurrence of an annual date (YYYY-MM-DD, any year) on or after today, as a local date string. */
export function nextAnnualLocalDate(value: string, now: Instant, zone: IanaZone): string {
  const [, vm, vd] = value.split('-').map(Number) as [number, number, number];
  const [y, m, d] = String(localDateOf(now, zone)).split('-').map(Number) as [number, number, number];
  const on = (yy: number): [number, number] => (vm === 2 && vd === 29 && !isLeapYear(yy) ? [2, 28] : [vm, vd]);
  let year = y;
  let [om, od] = on(year);
  if (om * 100 + od < m * 100 + d) {
    year += 1;
    [om, od] = on(year);
  }
  return `${String(year).padStart(4, '0')}-${String(om).padStart(2, '0')}-${String(od).padStart(2, '0')}`;
}
