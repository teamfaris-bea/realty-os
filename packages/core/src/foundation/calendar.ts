// Business time (BUILD_PLAN module 1; R-OWN-9 offer window, R-OWN-13 first-touch SLA, R-OWN-15).
//
// A BusinessCalendar is a daily local window [open, close) in one IANA zone on selected weekdays,
// e.g. tenant routing hours 08:00–21:00 every day in the tenant zone. Durations count real elapsed
// milliseconds inside those windows. Boundaries use the elapsed-time DST rule (see tz.ts): a
// boundary inside a spring-forward gap moves to the transition; an ambiguous (fall-back) boundary
// takes the earlier offset (first occurrence).
//
// Deadlines are computed once with the calendar in force and stored as UTC instants (R-OWN-15);
// nothing here is ever re-evaluated against a later calendar.
import { DAY_MS, type Instant, SECOND_MS, instant } from './time.js';
import {
  type IanaZone,
  type LocalTime,
  type Weekday,
  ianaZone,
  isoWeekdayOfWall,
  localTime,
  resolveWall,
  wallMs,
} from './tz.js';

export interface BusinessCalendar {
  zone: IanaZone;
  open: LocalTime;
  close: LocalTime;
  days: ReadonlySet<Weekday>;
}

export const ALL_WEEKDAYS: ReadonlySet<Weekday> = new Set<Weekday>([1, 2, 3, 4, 5, 6, 7]);

/**
 * Builds a validated calendar. `open`/`close` accept 'HH:MM[:SS]' strings (as Postgres returns
 * `time` columns) or LocalTime values. Days default to every day (tenant routing hours have no
 * weekday setting in Phase 1).
 */
export function businessCalendar(i: {
  zone: string;
  open: string | LocalTime;
  close: string | LocalTime;
  days?: Iterable<Weekday>;
}): BusinessCalendar {
  const z = ianaZone(i.zone);
  if (z === null) throw new RangeError(`businessCalendar: unknown IANA zone ${i.zone}`);
  const cal: BusinessCalendar = {
    zone: z,
    open: typeof i.open === 'string' ? localTime(i.open) : i.open,
    close: typeof i.close === 'string' ? localTime(i.close) : i.close,
    days: i.days ? new Set(i.days) : ALL_WEEKDAYS,
  };
  assertCalendar(cal);
  return cal;
}

function assertCalendar(cal: BusinessCalendar): void {
  if (!(cal.open >= 0 && cal.close <= 86_400 && cal.open < cal.close)) {
    throw new RangeError('BusinessCalendar: requires 00:00 <= open < close <= 24:00');
  }
  if (cal.days.size === 0) throw new RangeError('BusinessCalendar: at least one business weekday is required');
  for (const d of cal.days) {
    if (!Number.isInteger(d) || d < 1 || d > 7) throw new RangeError(`BusinessCalendar: bad weekday ${String(d)}`);
  }
  if (ianaZone(cal.zone) === null) throw new RangeError(`BusinessCalendar: unknown IANA zone ${cal.zone}`);
}

/**
 * Returns a cursor over business intervals [start, end) in chronological order, beginning with the
 * local day that contains `from`. Empty intervals (both boundaries collapsed into one DST gap) are
 * skipped. The walk always terminates for a validated calendar: at least one weekday is a business
 * day and open < close, so every week has a non-empty interval (a DST gap removes at most one hour
 * on one day a year).
 */
function intervalCursor(from: Instant, cal: BusinessCalendar): () => [number, number] {
  let dayWall = Math.floor(wallMs(from, cal.zone) / DAY_MS) * DAY_MS - DAY_MS;
  return () => {
    for (;;) {
      dayWall += DAY_MS;
      if (!cal.days.has(isoWeekdayOfWall(dayWall))) continue;
      const s = resolveWall(dayWall + cal.open * SECOND_MS, cal.zone, 'earlier');
      const e = resolveWall(dayWall + cal.close * SECOND_MS, cal.zone, 'earlier');
      if (e > s) return [s, e];
    }
  };
}

/** Whether `at` is inside business hours. */
export function isBusinessOpen(at: Instant, cal: BusinessCalendar): boolean {
  assertCalendar(cal);
  const next = intervalCursor(at, cal);
  for (;;) {
    const [s, e] = next();
    if (s > at) return false;
    if (at < e) return true;
  }
}

/**
 * The next instant at which business is open: `at` itself when open, otherwise the start of the
 * next business interval. (E8: a lead at 02:00 is offered at once; its window counts from here.)
 */
export function nextOpening(at: Instant, cal: BusinessCalendar): Instant {
  assertCalendar(cal);
  const next = intervalCursor(at, cal);
  for (;;) {
    const [s, e] = next();
    if (at < e) return instant(Math.max(s, at));
  }
}

/**
 * `start` plus `seconds` of business time. Counting starts at `start` if business is open, else
 * at the next opening. A duration that ends exactly at a close returns the close instant, which
 * keeps the function additive: add(add(s, a), b) == add(s, a + b). Zero seconds returns `start`.
 * Monotonic in both `start` and `seconds`.
 */
export function addBusinessDuration(start: Instant, seconds: number, cal: BusinessCalendar): Instant {
  assertCalendar(cal);
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`addBusinessDuration: seconds must be finite and >= 0 (got ${seconds})`);
  let remaining = Math.round(seconds * SECOND_MS);
  if (remaining === 0) return start;
  const next = intervalCursor(start, cal);
  for (;;) {
    const [s, e] = next();
    if (e <= start) continue;
    const from = Math.max(s, start);
    const available = e - from;
    if (remaining <= available) return instant(from + remaining);
    remaining -= available;
  }
}

/** Business milliseconds elapsed in [a, b) (0 when b <= a). The inverse of addBusinessDuration. */
export function businessMsBetween(a: Instant, b: Instant, cal: BusinessCalendar): number {
  assertCalendar(cal);
  if (b <= a) return 0;
  let total = 0;
  const next = intervalCursor(a, cal);
  for (;;) {
    const [s, e] = next();
    if (s >= b) return total;
    if (e <= a) continue;
    total += Math.min(e, b) - Math.max(s, a);
  }
}
