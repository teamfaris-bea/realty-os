// Recipient zones and the send window for AI ISA messages (R-ISA-10; E511, E512, E514; docs/AI_ISA.md §5.3).
//
// Explicit ONLY when the contact's zone was set by a person (`contacts.timezone_source = 'explicit'`): that zone
// alone. Otherwise the UNION of every phone's area-code zones (removed phones too), every contact point zone (weak
// evidence: no source column), the tenant zone, the zones of the inquiry postal code's state and of the contact
// addresses' states, and the conservative continental set (ET, CT, MT, Arizona, PT); Alaska and Hawaii join through
// the area code or the state. This deliberately does NOT use `resolveRecipientZones`' first-tier-wins rule (a point
// zone of unknown source would win there): a test pins the difference.
//
// The window is the intersection of [start, end) in every zone (`nextWindowStart`). Initiated messages also obey
// the initiated days and the holidays in every zone. No overlap ⇒ care ends with a handoff
// (ZONE_WINDOWS_DO_NOT_OVERLAP). VERIFY WITH COUNSEL (C-ISA-3): the union, the window and the holidays.
import {
  DAY_MS,
  type IanaZone,
  type Instant,
  type LocalTime,
  ianaZone,
  instant,
  localDateOf,
  nextWindowStart,
  startOfLocalDay,
  weekdayOf,
} from '../foundation/index.js';
import { areaCodeOf, areaCodeZones } from './areaCodes.js';
import { stateOfPostalCode, zonesOfState } from './stateZones.js';

/** Always in the union unless the zone is explicit (Q-ISA-22). VERIFY WITH COUNSEL. */
export const CONTINENTAL_ZONES: readonly IanaZone[] = Object.freeze(
  ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'].map((z) => ianaZone(z) as IanaZone),
);

export type AiIsaZoneSource = 'explicit' | 'union';

export interface RecipientZoneInput {
  /** contacts.timezone and contacts.timezone_source. */
  contactTz: string | null;
  contactTzSource: string | null;
  /** Every phone of the person, removed ones included (E.164 or any format). */
  phones: readonly string[];
  /** Every contact_points.timezone (weak evidence). */
  pointTzs: readonly (string | null)[];
  tenantZone: string;
  /** The inquiry's postal code. */
  inquiryPostalCode: string | null;
  /** The states (two-letter codes) of the contact's addresses. */
  addressStates: readonly (string | null)[];
}

export interface RecipientZones {
  zones: IanaZone[];
  source: AiIsaZoneSource;
  /** What contributed (codes only), for the panel's "zone set and its source". */
  evidence: ('area_code' | 'point' | 'tenant' | 'inquiry_state' | 'address_state' | 'continental' | 'explicit')[];
}

function sortZones(zs: Iterable<IanaZone>): IanaZone[] {
  return [...new Set(zs)].sort();
}

/** The conservative AI ISA zone set (R-ISA-10). Throws on an invalid tenant zone (a configuration error). */
export function aiIsaRecipientZones(i: RecipientZoneInput): RecipientZones {
  const tenant = ianaZone(i.tenantZone);
  if (tenant === null) throw new RangeError(`aiIsaRecipientZones: tenant zone is not a valid IANA zone: ${i.tenantZone}`);
  const explicit = i.contactTzSource === 'explicit' ? ianaZone(i.contactTz) : null;
  if (explicit !== null) return { zones: [explicit], source: 'explicit', evidence: ['explicit'] };
  const out = new Set<IanaZone>();
  const evidence = new Set<RecipientZones['evidence'][number]>();
  const addAll = (zs: readonly string[], ev: RecipientZones['evidence'][number]): void => {
    for (const raw of zs) {
      const z = ianaZone(raw);
      if (z !== null) {
        out.add(z);
        evidence.add(ev);
      }
    }
  };
  for (const p of i.phones) addAll(areaCodeZones(areaCodeOf(p)), 'area_code');
  addAll(i.pointTzs.filter((z): z is string => typeof z === 'string'), 'point');
  out.add(tenant);
  evidence.add('tenant');
  addAll(zonesOfState(stateOfPostalCode(i.inquiryPostalCode)), 'inquiry_state');
  for (const st of i.addressStates) addAll(zonesOfState(st), 'address_state');
  for (const z of CONTINENTAL_ZONES) out.add(z);
  evidence.add('continental');
  return { zones: sortZones(out), source: 'union', evidence: [...evidence].sort() };
}

// ---- holidays -------------------------------------------------------------------------------------------------

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function dow(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = dow(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y: number, m: number, weekday: number): number {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dow(y, m, days);
  return days - ((last - weekday + 7) % 7);
}

/**
 * US federal holidays of `year` as local dates (YYYY-MM-DD): each actual date AND its observed weekday (Saturday →
 * Friday, Sunday → Monday), both refused for initiated messages. VERIFY WITH COUNSEL (C-ISA-3).
 */
export function usFederalHolidays(year: number): string[] {
  const fixed: [number, number][] = [
    [1, 1],
    [6, 19],
    [7, 4],
    [11, 11],
    [12, 25],
  ];
  const out = new Set<string>();
  for (const [m, d] of fixed) {
    out.add(ymd(year, m, d));
    const w = dow(year, m, d);
    if (w === 6) {
      const t = new Date(Date.UTC(year, m - 1, d - 1));
      out.add(ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
    }
    if (w === 7) {
      const t = new Date(Date.UTC(year, m - 1, d + 1));
      out.add(ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
    }
  }
  out.add(ymd(year, 1, nthWeekday(year, 1, 1, 3))); // Martin Luther King Jr. Day
  out.add(ymd(year, 2, nthWeekday(year, 2, 1, 3))); // Washington's Birthday
  out.add(ymd(year, 5, lastWeekday(year, 5, 1))); // Memorial Day
  out.add(ymd(year, 9, nthWeekday(year, 9, 1, 1))); // Labor Day
  out.add(ymd(year, 10, nthWeekday(year, 10, 1, 2))); // Columbus Day
  out.add(ymd(year, 11, nthWeekday(year, 11, 4, 4))); // Thanksgiving
  // New Year's Day of the next year observed on Dec 31 of this one
  if (dow(year + 1, 1, 1) === 6) out.add(ymd(year, 12, 31));
  return [...out].sort();
}

/** Every holiday date of the years around `at` (the zones' local years can differ near New Year). */
export function holidaysAround(at: Instant): string[] {
  const y = new Date(at).getUTCFullYear();
  return [...usFederalHolidays(y - 1), ...usFederalHolidays(y), ...usFederalHolidays(y + 1)];
}

// ---- the window -------------------------------------------------------------------------------------------------

export interface SendWindowInput {
  at: Instant;
  zones: readonly IanaZone[];
  startSec: number;
  endSec: number;
  /** Initiated messages: only these ISO weekdays and never a holiday, in every zone. */
  initiated: boolean;
  initiatedDays: readonly number[];
  noInitiatedOnHolidays: boolean;
}

function dayAllowed(t: Instant, zones: readonly IanaZone[], days: readonly number[], holidays: ReadonlySet<string> | null): IanaZone | null {
  for (const z of zones) {
    if (!days.includes(weekdayOf(t, z))) return z;
    if (holidays !== null && holidays.has(localDateOf(t, z))) return z;
  }
  return null;
}

/**
 * The earliest instant ≥ `at` at which an AI ISA message may go out: inside the window in every zone, and for an
 * initiated message on an allowed day that is not a holiday in every zone. Null when no such instant exists
 * within a year (the zones' windows never overlap, E512): care ends ZONE_WINDOWS_DO_NOT_OVERLAP.
 */
export function aiIsaSendWindow(i: SendWindowInput): Instant | null {
  if (i.zones.length === 0) return null;
  const holidays = i.initiated && i.noInitiatedOnHolidays ? new Set(holidaysAround(i.at)) : null;
  let cursor = i.at;
  for (let k = 0; k < 60; k++) {
    const t = nextWindowStart(cursor, i.zones, i.startSec as LocalTime, i.endSec as LocalTime);
    if (t === null) return null;
    if (!i.initiated) return t;
    const bad = dayAllowed(t, i.zones, i.initiatedDays, holidays);
    if (bad === null) return t;
    // move past the refused local day of that zone and look again
    cursor = instant(startOfLocalDay(t, bad) + DAY_MS + 1);
  }
  return null;
}

/** The UTC offset in minutes of `z` at `t` as Node's ICU sees it (TX1 compares it with Postgres, §5.3). */
export function icuOffsetMinutes(z: IanaZone, t: Instant): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(t / 1000) * 1000) / 60_000);
}

/**
 * §5.3 offset agreement: every zone's offset at `t` per core equals the database's. A mismatch defers the message
 * and alerts (the API records both tzdata versions on the turn).
 */
export function offsetsAgree(zones: readonly IanaZone[], t: Instant, dbOffsetMinutes: Readonly<Record<string, number>>): boolean {
  return zones.every((z) => dbOffsetMinutes[z] === icuOffsetMinutes(z, t));
}
