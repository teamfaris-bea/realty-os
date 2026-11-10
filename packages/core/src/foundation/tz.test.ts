import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, HOUR_MS, MINUTE_MS, at, instant } from './time.js';
import {
  type IanaZone,
  type LocalDate,
  zoneOffsetMs,
  addLocalDays,
  ianaZone,
  localDate,
  localDateOf,
  localSecondsOf,
  localTime,
  localWindowContains,
  nextWindowStart,
  resolveLocal,
  resolveRecipientZones,
  startOfLocalDay,
  weekdayOf,
  zone,
  formatLocalTime,
  localTimeFromSeconds,
} from './tz.js';

// ---- independent oracle: UTC instants computed from known offsets, without luxon ----------------
// US rules: DST starts the 2nd Sunday of March and ends the 1st Sunday of November, both at 02:00.
// 2026: Mar 8 / Nov 1. 2027: Mar 14 / Nov 7.
interface ZoneSpec {
  name: string;
  std: number; // offset in hours
  dst: number | null; // null = no DST
}
const ZONES: ZoneSpec[] = [
  { name: 'America/New_York', std: -5, dst: -4 },
  { name: 'America/Chicago', std: -6, dst: -5 },
  { name: 'America/Denver', std: -7, dst: -6 },
  { name: 'America/Phoenix', std: -7, dst: null },
  { name: 'America/Los_Angeles', std: -8, dst: -7 },
  { name: 'Pacific/Honolulu', std: -10, dst: null },
];
const YEARS = [
  { year: 2026, springEve: '2026-03-07', spring: '2026-03-08', fallEve: '2026-10-31', fall: '2026-11-01' },
  { year: 2027, springEve: '2027-03-13', spring: '2027-03-14', fallEve: '2027-11-06', fall: '2027-11-07' },
];

/** The instant of local `date hh:mm[:ss]` given the offset (hours) in force at that local time. */
function u(date: string, hm: string, offsetH: number): Instant {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s = 0] = hm.split(':').map(Number) as [number, number, number?];
  return instant(Date.UTC(y, mo - 1, d, h, mi, s) - offsetH * HOUR_MS);
}

const T = localTime;

describe('E9 R-CONSENT-13 R-OWN-15 DST vectors: six US zones, 2026 and 2027 transitions', () => {
  for (const zs of ZONES) {
    const z = zone(zs.name);
    for (const y of YEARS) {
      const std = zs.std;
      const dst = zs.dst ?? zs.std;
      const hasDst = zs.dst !== null;
      const label = `${zs.name} ${y.year}`;

      it(`${label}: spring-forward 02:30 ${hasDst ? 'is skipped and resolves to the transition (03:00 DST) for both rules' : 'exists (no DST)'}`, () => {
        const expected = hasDst ? u(y.spring, '03:00', dst) : u(y.spring, '02:30', std);
        expect(resolveLocal(localDate(y.spring), T('02:30'), z, 'later')).toBe(expected);
        expect(resolveLocal(localDate(y.spring), T('02:30'), z, 'earlier')).toBe(expected);
        if (hasDst) {
          expect(expected).toBe(u(y.spring, '02:00', std)); // the transition instant itself
          expect(resolveLocal(localDate(y.spring), T('02:00'), z, 'later')).toBe(expected);
          expect(resolveLocal(localDate(y.spring), T('02:59:59'), z, 'later')).toBe(expected);
        }
        expect(resolveLocal(localDate(y.spring), T('01:59'), z, 'later')).toBe(u(y.spring, '01:59', std));
        expect(resolveLocal(localDate(y.spring), T('03:00'), z, 'later')).toBe(u(y.spring, '03:00', dst));
      });

      it(`${label}: fall-back 01:30 ${hasDst ? 'is ambiguous: windows take the later instant, elapsed time the earlier offset' : 'is unambiguous'}`, () => {
        expect(resolveLocal(localDate(y.fall), T('01:30'), z, 'later')).toBe(u(y.fall, '01:30', std));
        expect(resolveLocal(localDate(y.fall), T('01:30'), z, 'earlier')).toBe(u(y.fall, '01:30', dst));
        if (hasDst) expect(u(y.fall, '01:30', std) - u(y.fall, '01:30', dst)).toBe(HOUR_MS);
        expect(resolveLocal(localDate(y.fall), T('00:59'), z, 'later')).toBe(u(y.fall, '00:59', dst));
        expect(resolveLocal(localDate(y.fall), T('02:00'), z, 'earlier')).toBe(u(y.fall, '02:00', std));
      });

      it(`${label}: the 09:00–20:00 contact window has exact boundaries on both transition days`, () => {
        for (const [date, off] of [
          [y.spring, dst],
          [y.fall, std],
          [y.springEve, std],
          [y.fallEve, dst],
        ] as const) {
          const open = u(date, '09:00', off);
          const close = u(date, '20:00', off);
          expect(localWindowContains(instant(open - 1), z, T('09:00'), T('20:00'))).toBe(false);
          expect(localWindowContains(open, z, T('09:00'), T('20:00'))).toBe(true);
          expect(localWindowContains(instant(close - 1), z, T('09:00'), T('20:00'))).toBe(true);
          expect(localWindowContains(close, z, T('09:00'), T('20:00'))).toBe(false);
        }
      });

      it(`${label}: a window opening inside the spring-forward gap opens at the transition`, () => {
        const opens = hasDst ? u(y.spring, '03:00', dst) : u(y.spring, '02:30', std);
        expect(localWindowContains(instant(opens - 1), z, T('02:30'), T('05:00'))).toBe(false);
        expect(localWindowContains(opens, z, T('02:30'), T('05:00'))).toBe(true);
        expect(nextWindowStart(u(y.spring, '00:00', std), [z], T('02:30'), T('05:00'))).toBe(opens);
      });

      it(`${label}: a window opening at an ambiguous 01:30 opens at the later instant`, () => {
        const firstOccurrence = u(y.fall, '01:45', dst); // 01:45 daylight time
        const secondOpen = u(y.fall, '01:30', std); // 01:30 standard time
        expect(localWindowContains(firstOccurrence, z, T('01:30'), T('05:00'))).toBe(!hasDst);
        expect(localWindowContains(secondOpen, z, T('01:30'), T('05:00'))).toBe(true);
        expect(localWindowContains(instant(secondOpen - 1), z, T('01:30'), T('05:00'))).toBe(false);
        expect(nextWindowStart(u(y.fall, '00:00', dst), [z], T('01:30'), T('05:00'))).toBe(hasDst ? secondOpen : u(y.fall, '01:30', std));
        // An ambiguous END also takes the later instant: 01:45 daylight time is still inside [00:00, 01:30).
        expect(localWindowContains(firstOccurrence, z, T('00:00'), T('01:30'))).toBe(hasDst);
        expect(localWindowContains(secondOpen, z, T('00:00'), T('01:30'))).toBe(false);
      });

      it(`${label}: after the evening close, the next contact window opens at 09:00 local the next day`, () => {
        expect(nextWindowStart(u(y.springEve, '20:30', std), [z], T('09:00'), T('20:00'))).toBe(u(y.spring, '09:00', dst));
        expect(nextWindowStart(u(y.fallEve, '20:30', dst), [z], T('09:00'), T('20:00'))).toBe(u(y.fall, '09:00', std));
        // Inside the window: now.
        const inside = u(y.spring, '12:00', dst);
        expect(nextWindowStart(inside, [z], T('09:00'), T('20:00'))).toBe(inside);
      });

      it(`${label}: local dates, weekdays and seconds-of-day across the transitions`, () => {
        expect(localDateOf(u(y.spring, '03:00', dst), z)).toBe(y.spring);
        expect(localDateOf(instant(u(y.spring, '00:00', std) - 1), z)).toBe(y.springEve);
        expect(weekdayOf(u(y.spring, '12:00', dst), z)).toBe(7); // both transitions are Sundays
        expect(weekdayOf(u(y.fall, '12:00', std), z)).toBe(7);
        expect(localSecondsOf(u(y.fall, '01:30', std), z)).toBe(5400); // 01:30 wall clock either way
        expect(localSecondsOf(u(y.fall, '01:30', dst), z)).toBe(5400);
        expect(startOfLocalDay(u(y.fall, '23:00', std), z)).toBe(u(y.fall, '00:00', dst));
        expect(startOfLocalDay(u(y.spring, '23:00', dst), z)).toBe(u(y.spring, '00:00', std));
      });

      it(`${label}: calendar-day arithmetic keeps the wall time (gap → transition, overlap → earlier offset)`, () => {
        expect(addLocalDays(u(y.springEve, '10:00', std), 1, z)).toBe(u(y.spring, '10:00', dst));
        expect(addLocalDays(u(y.springEve, '02:30', std), 1, z)).toBe(hasDst ? u(y.spring, '03:00', dst) : u(y.spring, '02:30', std));
        expect(addLocalDays(u(y.fallEve, '01:30', dst), 1, z)).toBe(u(y.fall, '01:30', dst));
        expect(addLocalDays(u(y.spring, '10:00', dst), -1, z)).toBe(u(y.springEve, '10:00', std));
        // A 30-day inactivity deadline (R-OWN-23) spanning the transition: same wall clock, not +720 h.
        const start = u(y.springEve, '15:00', std);
        const deadline = addLocalDays(start, 30, z);
        expect(localSecondsOf(deadline, z)).toBe(15 * 3600);
        expect(deadline - start).toBe(30 * 24 * HOUR_MS - (hasDst ? HOUR_MS : 0));
      });
    }
  }
});

describe('R-CONSENT-13 window intersection over candidate zones', () => {
  const ny = zone('America/New_York');
  const la = zone('America/Los_Angeles');
  const hi = zone('Pacific/Honolulu');

  it('R-CONSENT-13 the intersection applies: New York + Los Angeles opens at 09:00 Pacific', () => {
    // 2026-06-10 07:00 EDT = 04:00 PDT. NY opens at 09:00 EDT, LA at 09:00 PDT (12:00 EDT).
    const from = at('2026-06-10T11:00:00Z');
    expect(nextWindowStart(from, [ny, la], T('09:00'), T('20:00'))).toBe(at('2026-06-10T16:00:00Z'));
    // The intersection closes when New York closes (20:00 EDT = 00:00Z).
    expect(localWindowContains(at('2026-06-10T23:59:59Z'), ny, T('09:00'), T('20:00'))).toBe(true);
    expect(nextWindowStart(at('2026-06-11T00:00:00Z'), [ny, la], T('09:00'), T('20:00'))).toBe(at('2026-06-11T16:00:00Z'));
  });

  it('R-CONSENT-13 zone order does not matter, and a single-zone list equals that zone', () => {
    const from = at('2026-01-15T05:00:00Z');
    const a = nextWindowStart(from, [ny, la, hi], T('09:00'), T('20:00'));
    const b = nextWindowStart(from, [hi, ny, la], T('09:00'), T('20:00'));
    expect(a).toBe(b);
    // NY 09–20 EST = 14:00–01:00Z; HI 09–20 HST = 19:00–06:00Z; LA 09-20 PST = 17:00–04:00Z → 19:00Z..01:00Z.
    expect(a).toBe(at('2026-01-15T19:00:00Z'));
  });

  it('R-CONSENT-13 windows that never overlap give null, never "now"', () => {
    const guam = zone('Pacific/Guam'); // UTC+10
    const samoa = zone('Pacific/Pago_Pago'); // UTC-11
    // 09–12 local: Guam 23:00–02:00Z, Samoa 20:00–23:00Z. No overlap.
    expect(nextWindowStart(at('2026-05-01T00:00:00Z'), [guam, samoa], T('09:00'), T('12:00'))).toBeNull();
  });

  // E29 (time basis only; the deferral itself is the gate's)
  it('R-CONSENT-13: a send that slips past 20:00 recipient-local is outside; the next opening is 09:00', () => {
    const late = at('2026-03-18T00:05:00Z'); // 20:05 EDT
    expect(localWindowContains(late, ny, T('09:00'), T('20:00'))).toBe(false);
    expect(nextWindowStart(late, [ny], T('09:00'), T('20:00'))).toBe(at('2026-03-18T13:00:00Z'));
  });

  // E8 (time basis only)
  it('R-CONSENT-13: a lead at 02:00 recipient-local first becomes contactable at 09:00', () => {
    expect(nextWindowStart(at('2026-07-04T06:00:00Z'), [ny], T('09:00'), T('20:00'))).toBe(at('2026-07-04T13:00:00Z'));
  });

  it('property: nextWindowStart is the EARLIEST instant >= at inside every zone window', () => {
    const zonePool = ZONES.map((s) => zone(s.name));
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        fc.uniqueArray(fc.constantFrom(...zonePool), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 0, max: 20 * 60 }),
        fc.integer({ min: 30, max: 12 * 60 }),
        (ms, zones, startMin, lenMin) => {
          const start = localTimeFromSeconds(startMin * 60);
          const end = localTimeFromSeconds(Math.min(24 * 3600, (startMin + lenMin) * 60));
          const from = instant(ms);
          const r = nextWindowStart(from, zones, start, end);
          if (r === null) return true; // proven disjoint elsewhere; nothing more to check here
          expect(r).toBeGreaterThanOrEqual(from);
          for (const z of zones) expect(localWindowContains(r, z, start, end)).toBe(true);
          if (r > from) {
            const before = instant(r - 1);
            expect(zones.every((z) => localWindowContains(before, z, start, end))).toBe(false);
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects malformed windows and empty zone lists (programming errors)', () => {
    expect(() => localWindowContains(at('2026-01-01T00:00:00Z'), ny, T('20:00'), T('09:00'))).toThrow(RangeError);
    expect(() => nextWindowStart(at('2026-01-01T00:00:00Z'), [], T('09:00'), T('20:00'))).toThrow(RangeError);
  });
});

describe('R-CONSENT-13 recipient zone resolution: explicit → contact point → address → area code (+ tenant) → tenant', () => {
  const tenantZone = zone('America/Chicago');
  const areaCodeZones: IanaZone[] = [zone('America/Denver'), zone('America/Phoenix')];

  it('R-CONSENT-13 an explicit contact zone wins over everything', () => {
    expect(resolveRecipientZones({ contactTz: 'America/New_York', pointTz: 'America/Denver', addressTz: 'America/Chicago', areaCodeZones, tenantZone })).toEqual({
      zones: ['America/New_York'],
      source: 'explicit',
    });
  });

  it('R-CONSENT-13 the contact point zone is next (also explicit evidence)', () => {
    expect(resolveRecipientZones({ pointTz: 'America/Denver', addressTz: 'America/Chicago', areaCodeZones, tenantZone })).toEqual({
      zones: ['America/Denver'],
      source: 'explicit',
    });
  });

  it('R-CONSENT-13 an address zone is used alone (as strong as it gets without explicit evidence)', () => {
    expect(resolveRecipientZones({ addressTz: 'Pacific/Honolulu', areaCodeZones, tenantZone })).toEqual({ zones: ['Pacific/Honolulu'], source: 'address' });
  });

  it('R-CONSENT-13 area-code evidence is weaker than an address, so the tenant zone is added', () => {
    expect(resolveRecipientZones({ areaCodeZones, tenantZone })).toEqual({
      zones: ['America/Denver', 'America/Phoenix', 'America/Chicago'],
      source: 'area_code',
    });
    // No duplicate when the area code is already in the tenant zone.
    expect(resolveRecipientZones({ areaCodeZones: [tenantZone], tenantZone })).toEqual({ zones: ['America/Chicago'], source: 'area_code' });
  });

  it('R-CONSENT-13 with no usable evidence the tenant zone applies', () => {
    expect(resolveRecipientZones({ areaCodeZones: [], tenantZone })).toEqual({ zones: ['America/Chicago'], source: 'tenant_default' });
  });

  it('invalid or empty zone strings are ignored, never trusted', () => {
    expect(
      resolveRecipientZones({ contactTz: 'Mars/Olympus', pointTz: '', addressTz: '   ', areaCodeZones: ['Nope/Nope' as IanaZone], tenantZone }),
    ).toEqual({ zones: ['America/Chicago'], source: 'tenant_default' });
    expect(resolveRecipientZones({ contactTz: null, pointTz: 'america/new_york', areaCodeZones: [], tenantZone })).toEqual({
      zones: ['America/New_York'],
      source: 'explicit',
    });
    expect(() => resolveRecipientZones({ areaCodeZones: [], tenantZone: 'Bad/Zone' as IanaZone })).toThrow(RangeError);
  });
});

describe('zone and local-time parsing', () => {
  it('canonicalises valid IANA names and rejects junk', () => {
    expect(ianaZone('america/new_york')).toBe('America/New_York');
    expect(ianaZone(' Pacific/Honolulu ')).toBe('Pacific/Honolulu');
    expect(ianaZone('UTC')).not.toBeNull();
    expect(ianaZone('Foo/Bar')).toBeNull();
    expect(ianaZone('')).toBeNull();
    expect(ianaZone(undefined)).toBeNull();
    expect(() => zone('Foo/Bar')).toThrow(RangeError);
  });

  it('parses HH:MM and HH:MM:SS (Postgres time) and 24:00 as end of day', () => {
    expect(localTime('09:00')).toBe(9 * 3600);
    expect(localTime('09:00:00')).toBe(9 * 3600);
    expect(localTime('20:59:30')).toBe(20 * 3600 + 59 * 60 + 30);
    expect(localTime('24:00')).toBe(86_400);
    expect(formatLocalTime(localTime('08:05'))).toBe('08:05');
    expect(formatLocalTime(localTime('08:05:09'))).toBe('08:05:09');
    for (const bad of ['9:00', '24:01', '12:60', '12:00:60', 'noon', '']) expect(() => localTime(bad)).toThrow(RangeError);
    expect(() => localTimeFromSeconds(86_401)).toThrow(RangeError);
  });

  it('rejects unvalidated branded zones and dates (programming errors)', () => {
    expect(() => zoneOffsetMs('Bad/Zone' as IanaZone, 0)).toThrow(RangeError);
    expect(() => resolveLocal('2026/01/01' as LocalDate, T('09:00'), zone('UTC'), 'later')).toThrow(RangeError);
    expect(zoneOffsetMs(zone('America/New_York'), Date.UTC(2026, 6, 1))).toBe(-4 * HOUR_MS);
  });

  it('validates calendar dates', () => {
    expect(localDate('2028-02-29')).toBe('2028-02-29');
    expect(() => localDate('2027-02-29')).toThrow(RangeError);
    expect(() => localDate('2027-2-1')).toThrow(RangeError);
  });

  it('addLocalDays requires whole days', () => {
    expect(() => addLocalDays(at('2026-01-01T00:00:00Z'), 1.5, zone('UTC'))).toThrow(RangeError);
    expect(addLocalDays(at('2026-01-01T00:00:00Z'), 0, zone('UTC'))).toBe(at('2026-01-01T00:00:00Z'));
    expect(MINUTE_MS).toBe(60_000);
  });
});
