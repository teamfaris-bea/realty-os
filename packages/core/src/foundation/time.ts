// Instants and injected clocks (BUILD_PLAN module 1).
//
// Core never reads the wall clock. `now` is the DB `clock_timestamp()` read inside the transaction
// (R-OWN-6) and is passed in as an `Instant`; the API process supplies a `Clock` for the few places
// that need one outside a transaction (ids). Tests use `fixedClock(t)` / `steppingClock()`.
import type { Brand } from './ids.js';

/** Epoch milliseconds, UTC. Always an integer. */
export type Instant = Brand<number, 'Instant'>;

export interface Clock {
  now(): Instant;
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Largest/smallest instant ECMAScript dates can represent (±8.64e15 ms). */
const MAX_DATE_MS = 8.64e15;

/** Brands an epoch-ms number. Throws on non-integers or out-of-range values (programming errors). */
export function instant(ms: number): Instant {
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_DATE_MS) {
    throw new RangeError(`instant: not an integer epoch-ms value in range: ${String(ms)}`);
  }
  return ms as Instant;
}

// An ISO-8601 timestamp WITH an explicit offset. Strings without one would be parsed in the
// process time zone, which is ambient state core must not depend on.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parses an ISO-8601 timestamp that carries `Z` or `±hh:mm`. Returns null for anything else. */
export function instantFromIso(iso: string): Instant | null {
  const m = ISO_WITH_OFFSET.exec(iso);
  if (!m) return null;
  // Reject calendar overflow such as 2026-02-30 (Date.parse rolls it over silently in some engines).
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59) return null;
  // Date.parse only keeps millisecond precision; truncate extra fraction digits first.
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : instant(ms);
}

/** Like `instantFromIso` but throws: for literals in code and tests. */
export function at(iso: string): Instant {
  const t = instantFromIso(iso);
  if (t === null) throw new RangeError(`at: not an ISO timestamp with offset: ${iso}`);
  return t;
}

/** Converts a JS Date (e.g. from `pg`) to an Instant. */
export function instantFromDate(d: Date): Instant {
  return instant(d.getTime());
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` */
export function toIso(t: Instant): string {
  return new Date(t).toISOString();
}

export function plusMs(t: Instant, ms: number): Instant {
  return instant(t + ms);
}

export function plusSeconds(t: Instant, seconds: number): Instant {
  return instant(t + Math.round(seconds * SECOND_MS));
}

export function maxInstant(a: Instant, b: Instant): Instant {
  return a >= b ? a : b;
}

export function minInstant(a: Instant, b: Instant): Instant {
  return a <= b ? a : b;
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month (UTC arithmetic, no ambient zone).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toInstantArg(t: Instant | number | string): Instant {
  return typeof t === 'string' ? at(t) : instant(t);
}

// ---------------------------------------------------------------------------------------------
// Deterministic clocks (tests, replays). They never read the wall clock.

export interface ManualClock extends Clock {
  /** Moves the clock to `t`. */
  set(t: Instant | number | string): void;
  /** Moves the clock forward (or backward, for negative values) by `ms`. */
  advance(ms: number): void;
}

/** A clock that always returns the same instant until moved with `set` / `advance`. */
export function fixedClock(t: Instant | number | string): ManualClock {
  let current = toInstantArg(t);
  return {
    now: () => current,
    set: (next) => {
      current = toInstantArg(next);
    },
    advance: (ms) => {
      current = plusMs(current, ms);
    },
  };
}

/** A clock that returns `start`, then `start + step`, `start + 2·step`, … on successive reads. */
export function steppingClock(start: Instant | number | string = 0, stepMs = SECOND_MS): Clock & { readonly reads: number } {
  if (!Number.isSafeInteger(stepMs) || stepMs < 0) throw new RangeError('steppingClock: stepMs must be a non-negative integer');
  const base = toInstantArg(start);
  let reads = 0;
  return {
    now: () => instant(base + stepMs * reads++),
    get reads() {
      return reads;
    },
  };
}
