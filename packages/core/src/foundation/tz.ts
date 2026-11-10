// IANA time zones, local-time resolution with explicit DST rules, recipient-local windows and
// recipient zone resolution (BUILD_PLAN module 1; R-CONSENT-13 time basis; E9).
//
// DST rules (DATA_MODEL R-CONSENT-13, BUILD_PLAN module 1):
// - A local time inside a spring-forward gap does not exist. It resolves to the next valid instant,
//   which is the transition instant itself (02:30 on a US spring-forward day becomes 03:00 DST).
// - A local time inside a fall-back overlap exists twice.
//     * Windows (quiet hours, contact windows): the LATER instant (the second, standard-time one).
//     * Elapsed time (business calendars, day arithmetic): the EARLIER offset, i.e. the first
//       occurrence (daylight time).
// - All arithmetic is on real elapsed milliseconds between the resolved instants.
//
// Offsets come from the runtime's IANA database through luxon (Intl). No ambient process zone is
// ever consulted: every function takes the zone explicitly.
import { IANAZone } from 'luxon';
import type { Brand } from './ids.js';
import { DAY_MS, type Instant, MINUTE_MS, SECOND_MS, instant } from './time.js';

export type IanaZone = Brand<string, 'IanaZone'>;

/**
 * Seconds after local midnight, 0..86400 (86400 = "24:00", end of day, allowed as a window end).
 * Build with `localTime('09:00')`; Postgres `time` values like '09:00:00' parse as well.
 */
export type LocalTime = Brand<number, 'LocalTime'>;

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A calendar date in some zone, `YYYY-MM-DD`. */
export type LocalDate = Brand<string, 'LocalDate'>;

/** How an ambiguous (fall-back) local time is resolved. Gaps always resolve to the transition. */
export type Disambiguation = 'earlier' | 'later';

// ---- zones --------------------------------------------------------------------------------------

const zoneCache = new Map<string, IANAZone>();
const canonicalCache = new Map<string, IanaZone | null>();

/**
 * Validates an IANA zone name from untrusted input and returns its canonical spelling
 * ('america/new_york' → 'America/New_York'). Null for unknown names, empty strings and
 * fixed-offset strings that are not IANA names.
 */
export function ianaZone(name: string | null | undefined): IanaZone | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const cached = canonicalCache.get(trimmed);
  if (cached !== undefined) return cached;
  let result: IanaZone | null = null;
  if (IANAZone.isValidZone(trimmed)) {
    // luxon validates through Intl, so Intl accepts the same name; it also gives the canonical case.
    result = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone as IanaZone;
  }
  canonicalCache.set(trimmed, result);
  return result;
}

/** Like `ianaZone` but throws: for literals in code and tests. */
export function zone(name: string): IanaZone {
  const z = ianaZone(name);
  if (z === null) throw new RangeError(`zone: unknown IANA time zone: ${name}`);
  return z;
}

function luxonZone(z: IanaZone): IANAZone {
  let lz = zoneCache.get(z);
  if (!lz) {
    lz = IANAZone.create(z);
    if (!lz.isValid) throw new RangeError(`unknown IANA time zone: ${z}`);
    zoneCache.set(z, lz);
  }
  return lz;
}

/** UTC offset of `z` at instant `t`, in milliseconds (e.g. -14400000 for EDT). */
export function zoneOffsetMs(z: IanaZone, t: number): number {
  return Math.round(luxonZone(z).offset(t) * MINUTE_MS);
}

// ---- local times and dates ----------------------------------------------------------------------

const LOCAL_TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** Parses 'HH:MM' or 'HH:MM:SS' (24 h). '24:00' is accepted as end of day. Throws on bad input. */
export function localTime(s: string): LocalTime {
  const m = LOCAL_TIME_RE.exec(s.trim());
  if (!m) throw new RangeError(`localTime: expected HH:MM[:SS], got ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = m[3] === undefined ? 0 : Number(m[3]);
  if (mi > 59 || se > 59 || h > 24 || (h === 24 && (mi > 0 || se > 0))) {
    throw new RangeError(`localTime: out of range: ${s}`);
  }
  return (h * 3600 + mi * 60 + se) as LocalTime;
}

/** Seconds since local midnight → branded LocalTime. */
export function localTimeFromSeconds(seconds: number): LocalTime {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) throw new RangeError(`localTimeFromSeconds: ${seconds}`);
  return seconds as LocalTime;
}

/** 'HH:MM' or 'HH:MM:SS' when seconds are present. */
export function formatLocalTime(t: LocalTime): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return s === 0 ? hm : `${hm}:${String(s).padStart(2, '0')}`;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates 'YYYY-MM-DD'. Throws on bad input. */
export function localDate(s: string): LocalDate {
  const m = LOCAL_DATE_RE.exec(s);
  if (!m) throw new RangeError(`localDate: expected YYYY-MM-DD, got ${s}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wall = Date.UTC(y, mo - 1, d);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`localDate: no such date: ${s}`);
  }
  return s as LocalDate;
}

/** Midnight of `d` as "wall milliseconds" (the local date-time read as if it were UTC). */
function wallOfDate(d: LocalDate): number {
  const m = LOCAL_DATE_RE.exec(d);
  if (!m) throw new RangeError(`bad LocalDate ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateOfWall(wall: number): LocalDate {
  return new Date(wall).toISOString().slice(0, 10) as LocalDate;
}

/** The local wall clock of `t` in `z`, as wall milliseconds. */
export function wallMs(t: Instant, z: IanaZone): number {
  return t + zoneOffsetMs(z, t);
}

/** Wall milliseconds of local midnight of the local date containing `t`. */
function wallDayStart(t: Instant, z: IanaZone): number {
  return Math.floor(wallMs(t, z) / DAY_MS) * DAY_MS;
}

/** The local calendar date of `t` in `z`. */
export function localDateOf(t: Instant, z: IanaZone): LocalDate {
  return dateOfWall(wallDayStart(t, z));
}

/** ISO weekday (1 = Monday) of the local date of `t` in `z`. */
export function weekdayOf(t: Instant, z: IanaZone): Weekday {
  return isoWeekdayOfWall(wallDayStart(t, z));
}

export function isoWeekdayOfWall(wall: number): Weekday {
  const d = new Date(wall).getUTCDay(); // 0 = Sunday
  return (d === 0 ? 7 : d) as Weekday;
}

/** Seconds since local midnight of `t` in `z` (wall-clock reading, 0..86399). */
export function localSecondsOf(t: Instant, z: IanaZone): number {
  return Math.floor((wallMs(t, z) - wallDayStart(t, z)) / SECOND_MS);
}

/**
 * Converts a local wall time (wall ms) to an instant with explicit DST rules:
 * - exists once → that instant;
 * - exists twice (overlap) → `earlier` = first occurrence, `later` = second occurrence;
 * - does not exist (gap) → the transition instant, the first valid instant after the gap.
 */
export function resolveWall(wall: number, z: IanaZone, pick: Disambiguation): Instant {
  // Offsets a day either side of the wall time bracket any single transition near it.
  const before = zoneOffsetMs(z, wall - DAY_MS);
  const after = zoneOffsetMs(z, wall + DAY_MS);
  const candidates = before === after ? [wall - before] : [wall - before, wall - after].sort((a, b) => a - b);
  const valid = candidates.filter((t) => t + zoneOffsetMs(z, t) === wall);
  if (valid.length > 0) {
    // Two distinct valid candidates only in an overlap.
    return instant(pick === 'earlier' ? (valid[0] as number) : (valid[valid.length - 1] as number));
  }
  // Gap: the transition T satisfies wall - after < T <= wall - before. Find the first instant whose
  // offset differs from the offset at the low end (binary search on ms; ~22 steps for 1 h gaps).
  let lo = wall - after; // still the old offset
  let hi = wall - before; // already the new offset
  const loOffset = zoneOffsetMs(z, lo);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(z, mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return instant(hi);
}

/** The instant of local `time` on local `date` in `z`, with the DST rules of `resolveWall`. */
export function resolveLocal(date: LocalDate, time: LocalTime, z: IanaZone, pick: Disambiguation): Instant {
  return resolveWall(wallOfDate(date) + time * SECOND_MS, z, pick);
}

/** Start of the local day of `t` in `z` (local midnight; DST gaps at midnight resolve forward). */
export function startOfLocalDay(t: Instant, z: IanaZone): Instant {
  return resolveWall(wallDayStart(t, z), z, 'earlier');
}

/**
 * The same local wall time `days` calendar days later (negative: earlier) in `z`. Used for
 * tenant-zone calendar-day deadlines such as inactivity release (R-OWN-23). Elapsed-time rules:
 * a time that falls in a gap moves to the transition; an ambiguous time takes the earlier offset.
 */
export function addLocalDays(t: Instant, days: number, z: IanaZone): Instant {
  if (!Number.isInteger(days)) throw new RangeError('addLocalDays: days must be an integer');
  return resolveWall(wallMs(t, z) + days * DAY_MS, z, 'earlier');
}

// ---- recipient-local windows (quiet hours) --------------------------------------------------

function assertWindow(start: LocalTime, end: LocalTime): void {
  if (!(start >= 0 && end <= 86_400 && start < end)) {
    throw new RangeError(`window must satisfy 00:00 <= start < end <= 24:00 (got ${start}s..${end}s)`);
  }
}

/** The window [start, end) on the local date of wall `dayWall`, resolved with the window rule (later). */
function windowOn(dayWall: number, z: IanaZone, start: LocalTime, end: LocalTime): [Instant, Instant] {
  return [resolveWall(dayWall + start * SECOND_MS, z, 'later'), resolveWall(dayWall + end * SECOND_MS, z, 'later')];
}

/**
 * Whether `at` lies inside the half-open local window [start, end) of its local day in `z`.
 * Boundaries are resolved with the window rule: a boundary in a gap moves to the transition, an
 * ambiguous boundary takes the later instant (R-CONSENT-13).
 */
export function localWindowContains(at: Instant, z: IanaZone, start: LocalTime, end: LocalTime): boolean {
  assertWindow(start, end);
  const [s, e] = windowOn(wallDayStart(at, z), z, start, end);
  return s <= at && at < e;
}

function allContain(t: Instant, zones: readonly IanaZone[], start: LocalTime, end: LocalTime): boolean {
  return zones.every((z) => localWindowContains(t, z, start, end));
}

function searchIntersection(at: Instant, zones: readonly IanaZone[], start: LocalTime, end: LocalTime, horizonDays: number): Instant | null {
  // The earliest instant >= at inside every zone's window is either `at` or the opening of some
  // zone's window (the latest opening among the windows that contain it).
  const candidates: number[] = [];
  for (const z of zones) {
    const base = wallDayStart(at, z);
    for (let k = -1; k <= horizonDays; k++) {
      const s = resolveWall(base + k * DAY_MS + start * SECOND_MS, z, 'later');
      if (s > at) candidates.push(s);
    }
  }
  candidates.sort((a, b) => a - b);
  for (const c of candidates) {
    if (allContain(c as Instant, zones, start, end)) return c as Instant;
  }
  return null;
}

/**
 * The earliest instant >= `at` that is inside the window [start, end) in EVERY zone (the
 * intersection, R-CONSENT-13). Returns `at` itself when it is already inside.
 *
 * Returns null when the zones' windows never overlap (e.g. Pacific/Guam and Pacific/Pago_Pago
 * with an 11-hour window). Callers must treat that as "no contactable instant" (never as "now").
 * This null case is a documented correction to the BUILD_PLAN signature, which returned Instant.
 */
export function nextWindowStart(at: Instant, zones: readonly IanaZone[], start: LocalTime, end: LocalTime): Instant | null {
  assertWindow(start, end);
  if (zones.length === 0) throw new RangeError('nextWindowStart: at least one zone is required');
  if (allContain(at, zones, start, end)) return at;
  // A week covers every daily pattern; a year covers intersections that only open after a DST
  // change in one of the zones.
  return searchIntersection(at, zones, start, end, 8) ?? searchIntersection(at, zones, start, end, 370);
}

// ---- recipient zone resolution ------------------------------------------------------------------

export type TzSource = 'explicit' | 'address' | 'area_code' | 'tenant_default';

/**
 * Candidate recipient zones (R-CONSENT-13): explicit → contact point → address → area-code zones →
 * tenant zone. The first tier with a valid zone wins:
 * - `contactTz` (set explicitly on the contact) or `pointTz` (on the contact point): source `explicit`;
 * - `addressTz` (derived from the postal address): source `address`;
 * - area-code zones: evidence weaker than an address, so the tenant zone is ADDED (source `area_code`);
 * - nothing usable: the tenant zone alone (source `tenant_default`).
 * Invalid zone strings are ignored, never trusted. The caller applies the intersection of windows.
 */
export function resolveRecipientZones(i: {
  pointTz?: string | null;
  contactTz?: string | null;
  addressTz?: string | null;
  areaCodeZones: readonly IanaZone[];
  tenantZone: IanaZone;
}): { zones: IanaZone[]; source: TzSource } {
  const tenant = ianaZone(i.tenantZone);
  if (tenant === null) throw new RangeError(`resolveRecipientZones: tenant zone is not a valid IANA zone: ${i.tenantZone}`);
  const explicit = ianaZone(i.contactTz) ?? ianaZone(i.pointTz);
  if (explicit) return { zones: [explicit], source: 'explicit' };
  const address = ianaZone(i.addressTz);
  if (address) return { zones: [address], source: 'address' };
  const areaZones: IanaZone[] = [];
  for (const raw of i.areaCodeZones) {
    const z = ianaZone(raw);
    if (z && !areaZones.includes(z)) areaZones.push(z);
  }
  if (areaZones.length > 0) {
    if (!areaZones.includes(tenant)) areaZones.push(tenant);
    return { zones: areaZones, source: 'area_code' };
  }
  return { zones: [tenant], source: 'tenant_default' };
}
