import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type BusinessCalendar, addBusinessDuration, businessCalendar, businessMsBetween, isBusinessOpen, nextOpening } from './calendar.js';
import { type Instant, HOUR_MS, MINUTE_MS, at, instant } from './time.js';
import { type IanaZone, type Weekday, localTime, localWindowContains, zone } from './tz.js';

function u(date: string, hm: string, offsetH: number): Instant {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s = 0] = hm.split(':').map(Number) as [number, number, number?];
  return instant(Date.UTC(y, mo - 1, d, h, mi, s) - offsetH * HOUR_MS);
}

const ZONES = [
  { name: 'America/New_York', std: -5, dst: -4 },
  { name: 'America/Chicago', std: -6, dst: -5 },
  { name: 'America/Denver', std: -7, dst: -6 },
  { name: 'America/Phoenix', std: -7, dst: null },
  { name: 'America/Los_Angeles', std: -8, dst: -7 },
  { name: 'Pacific/Honolulu', std: -10, dst: null },
] as const;
const YEARS = [
  { year: 2026, springEve: '2026-03-07', spring: '2026-03-08', springNext: '2026-03-09', fallEve: '2026-10-31', fall: '2026-11-01', fallNext: '2026-11-02' },
  { year: 2027, springEve: '2027-03-13', spring: '2027-03-14', springNext: '2027-03-15', fallEve: '2027-11-06', fall: '2027-11-07', fallNext: '2027-11-08' },
];

const routing = (z: string): BusinessCalendar => businessCalendar({ zone: z, open: '08:00', close: '21:00' });

describe('E9 R-OWN-15 business time across DST: six US zones, 2026 and 2027', () => {
  for (const zs of ZONES) {
    const std = zs.std;
    const dst = zs.dst ?? zs.std;
    const hasDst = zs.dst !== null;
    for (const y of YEARS) {
      const label = `${zs.name} ${y.year}`;

      // R-OWN-9 (offer window in business time; the rest of R-OWN-9 is core/ownership's)
      it(`${label}: a 300 s offer window started 2 min before close finishes 3 min after the next 08:00`, () => {
        const cal = routing(zs.name);
        expect(addBusinessDuration(u(y.springEve, '20:58', std), 300, cal)).toBe(u(y.spring, '08:03', dst));
        expect(addBusinessDuration(u(y.fallEve, '20:58', dst), 300, cal)).toBe(u(y.fall, '08:03', std));
      });

      // E8 (time basis only; the offer/assistant behaviour is tested by ownership/compliance)
      it(`${label}: an offer made at 02:00 counts from 08:00 (nextOpening), even on transition nights`, () => {
        const cal = routing(zs.name);
        expect(nextOpening(u(y.spring, '01:00', std), cal)).toBe(u(y.spring, '08:00', dst));
        expect(addBusinessDuration(u(y.spring, '01:00', std), 300, cal)).toBe(u(y.spring, '08:05', dst));
        expect(nextOpening(u(y.fall, '01:30', dst), cal)).toBe(u(y.fall, '08:00', std));
        expect(isBusinessOpen(u(y.fall, '08:00', std), cal)).toBe(true);
        expect(isBusinessOpen(instant(u(y.fall, '08:00', std) - 1), cal)).toBe(false);
        expect(isBusinessOpen(u(y.fall, '21:00', std), cal)).toBe(false);
      });

      it(`${label}: a calendar spanning the transition counts real elapsed time (${hasDst ? '3 h on spring day, 5 h on fall day' : '4 h both days'})`, () => {
        const night = businessCalendar({ zone: zs.name, open: '00:00', close: '04:00' });
        const springLen = hasDst ? 3 * HOUR_MS : 4 * HOUR_MS;
        const fallLen = hasDst ? 5 * HOUR_MS : 4 * HOUR_MS;
        expect(businessMsBetween(u(y.springEve, '12:00', std), u(y.spring, '12:00', dst), night)).toBe(springLen);
        expect(businessMsBetween(u(y.fallEve, '12:00', dst), u(y.fall, '12:00', std), night)).toBe(fallLen);
        // Exactly the day's business time ends at the close; one more second rolls to the next day.
        const springStart = u(y.spring, '00:00', std);
        expect(addBusinessDuration(springStart, springLen / 1000, night)).toBe(u(y.spring, '04:00', dst));
        expect(addBusinessDuration(springStart, springLen / 1000 + 1, night)).toBe(u(y.springNext, '00:00:01', dst));
        const fallStart = u(y.fall, '00:00', dst);
        expect(addBusinessDuration(fallStart, 4 * 3600, night)).toBe(hasDst ? u(y.fall, '03:00', std) : u(y.fall, '04:00', std));
        expect(addBusinessDuration(fallStart, fallLen / 1000, night)).toBe(u(y.fall, '04:00', std));
      });

      it(`${label}: business hours opening inside the skipped hour open at the transition`, () => {
        const cal = businessCalendar({ zone: zs.name, open: '02:30', close: '05:00' });
        const opens = hasDst ? u(y.spring, '03:00', dst) : u(y.spring, '02:30', std);
        expect(nextOpening(u(y.spring, '00:00', std), cal)).toBe(opens);
        expect(businessMsBetween(u(y.spring, '00:00', std), u(y.spring, '06:00', dst), cal)).toBe(hasDst ? 2 * HOUR_MS : 2.5 * HOUR_MS);
      });

      it(`${label}: an ambiguous boundary uses the earlier offset for elapsed time`, () => {
        const opensAmbiguous = businessCalendar({ zone: zs.name, open: '01:30', close: '03:00' });
        expect(nextOpening(u(y.fall, '00:00', dst), opensAmbiguous)).toBe(u(y.fall, '01:30', dst));
        expect(businessMsBetween(u(y.fall, '00:00', dst), u(y.fall, '06:00', std), opensAmbiguous)).toBe(hasDst ? 2.5 * HOUR_MS : 1.5 * HOUR_MS);
        const closesAmbiguous = businessCalendar({ zone: zs.name, open: '00:00', close: '01:30' });
        expect(businessMsBetween(u(y.fall, '00:00', dst), u(y.fall, '06:00', std), closesAmbiguous)).toBe(1.5 * HOUR_MS);
        expect(isBusinessOpen(u(y.fall, '01:15', std), closesAmbiguous)).toBe(!hasDst);
      });

      // R-OWN-13 (SLA due-time arithmetic only)
      it(`${label}: a 15-minute first-touch SLA from an evening acceptance lands in the next morning`, () => {
        const cal = routing(zs.name);
        expect(addBusinessDuration(u(y.fallEve, '20:50', dst), 15 * 60, cal)).toBe(u(y.fall, '08:05', std));
        expect(addBusinessDuration(u(y.springEve, '20:50', std), 15 * 60, cal)).toBe(u(y.spring, '08:05', dst));
        expect(addBusinessDuration(u(y.springNext, '10:00', dst), 15 * 60, cal)).toBe(u(y.springNext, '10:15', dst));
      });
    }
  }
});

describe('R-OWN-15 deadlines are computed once from the calendar passed in', () => {
  // E10 (core half: no hidden state; the stored-deadline half is db/ownership's)
  it('R-OWN-15: a stored deadline is a plain instant; a later calendar change only affects new computations', () => {
    const before = routing('America/New_York');
    const start = at('2026-04-01T00:58:00Z'); // 20:58 EDT
    const stored = addBusinessDuration(start, 300, before); // 08:00 + 3 min next day
    expect(stored).toBe(at('2026-04-01T12:03:00Z'));
    // The tenant moves to Los Angeles with 09:00–17:00 hours: the same inputs give a new answer…
    const after = businessCalendar({ zone: 'America/Los_Angeles', open: '09:00', close: '17:00' });
    expect(addBusinessDuration(start, 300, after)).toBe(at('2026-04-01T16:05:00Z'));
    // …while the stored instant is untouched (no hidden state, nothing re-derived).
    expect(stored).toBe(at('2026-04-01T12:03:00Z'));
    expect(addBusinessDuration(start, 300, before)).toBe(stored);
  });
});

describe('business calendar edge cases', () => {
  it('zero seconds returns the start unchanged, open or closed', () => {
    const cal = routing('America/New_York');
    const closed = at('2026-04-01T05:00:00Z');
    expect(addBusinessDuration(closed, 0, cal)).toBe(closed);
  });

  it('a business day whose hours fall entirely inside the skipped hour has no business time', () => {
    const cal = businessCalendar({ zone: 'America/New_York', open: '02:15', close: '02:45' });
    expect(businessMsBetween(u('2026-03-08', '00:00', -5), u('2026-03-08', '23:00', -4), cal)).toBe(0);
    expect(nextOpening(u('2026-03-08', '00:00', -5), cal)).toBe(u('2026-03-09', '02:15', -4));
  });

  it('weekday calendars skip non-business days (Mon–Fri 09:00–17:00)', () => {
    const cal = businessCalendar({ zone: 'America/Chicago', open: '09:00', close: '17:00', days: [1, 2, 3, 4, 5] });
    // Friday 2026-04-03 16:55 CDT + 10 min → Monday 2026-04-06 09:05 CDT.
    expect(addBusinessDuration(at('2026-04-03T21:55:00Z'), 600, cal)).toBe(at('2026-04-06T14:05:00Z'));
    expect(nextOpening(at('2026-04-04T15:00:00Z'), cal)).toBe(at('2026-04-06T14:00:00Z'));
  });

  it('long durations span many days', () => {
    const cal = routing('America/Denver');
    // 13 business hours per day: 10 days of business time from an opening lands on the 11th opening.
    const start = at('2026-03-01T15:00:00Z'); // 08:00 MST
    expect(addBusinessDuration(start, 10 * 13 * 3600, cal)).toBe(at('2026-03-11T03:00:00Z')); // 21:00 MDT on 03-10
  });

  it('rejects invalid calendars and durations', () => {
    expect(() => businessCalendar({ zone: 'Nope/Nope', open: '08:00', close: '21:00' })).toThrow(RangeError);
    expect(() => businessCalendar({ zone: 'UTC', open: '21:00', close: '08:00' })).toThrow(RangeError);
    expect(() => businessCalendar({ zone: 'UTC', open: '08:00', close: '21:00', days: [] })).toThrow(RangeError);
    expect(() => businessCalendar({ zone: 'UTC', open: '08:00', close: '21:00', days: [8 as Weekday] })).toThrow(RangeError);
    const cal = routing('UTC');
    expect(() => addBusinessDuration(at('2026-01-01T00:00:00Z'), -1, cal)).toThrow(RangeError);
    expect(() => addBusinessDuration(at('2026-01-01T00:00:00Z'), Number.NaN, cal)).toThrow(RangeError);
    expect(businessMsBetween(at('2026-01-02T00:00:00Z'), at('2026-01-01T00:00:00Z'), cal)).toBe(0);
  });

  it('accepts LocalTime values and Postgres time strings', () => {
    const a = businessCalendar({ zone: 'UTC', open: localTime('08:00'), close: '21:00:00' });
    expect(a.open).toBe(8 * 3600);
    expect(a.close).toBe(21 * 3600);
    expect(a.days.size).toBe(7);
    expect(businessCalendar({ zone: 'UTC', open: '08:00', close: localTime('21:00') }).close).toBe(21 * 3600);
  });

  it('rejects hand-built calendar objects that bypass businessCalendar()', () => {
    const forged = { zone: 'Bad/Zone' as IanaZone, open: localTime('08:00'), close: localTime('21:00'), days: new Set<Weekday>([1]) };
    expect(() => nextOpening(at('2026-01-01T00:00:00Z'), forged)).toThrow(RangeError);
  });
});

// ---- property tests -----------------------------------------------------------------------------

const ZONE_POOL = ZONES.map((z) => z.name);
const arbCalendar = fc
  .record({
    zone: fc.constantFrom(...ZONE_POOL),
    openMin: fc.integer({ min: 0, max: 22 * 60 }),
    lenMin: fc.integer({ min: 15, max: 16 * 60 }),
    days: fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
  })
  .map(({ zone: z, openMin, lenMin, days }) => {
    const close = Math.min(24 * 60, openMin + lenMin);
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return businessCalendar({ zone: z, open: hm(openMin), close: hm(close), days: days as Weekday[] });
  });
// 2026-01-01 .. 2027-12-31: covers all four transitions of both years.
const arbStart = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }).map(instant);
const arbSeconds = fc.integer({ min: 0, max: 5 * 24 * 3600 });

describe('addBusinessDuration properties (fast-check)', () => {
  it('monotonic in the start instant', () => {
    fc.assert(
      fc.property(arbCalendar, arbStart, fc.integer({ min: 0, max: 3 * 24 * 3600 * 1000 }), arbSeconds, (cal, s1, gap, secs) => {
        const s2 = instant(s1 + gap);
        return addBusinessDuration(s1, secs, cal) <= addBusinessDuration(s2, secs, cal);
      }),
      { numRuns: 300 },
    );
  });

  it('monotonic in the duration, and never earlier than the start', () => {
    fc.assert(
      fc.property(arbCalendar, arbStart, arbSeconds, arbSeconds, (cal, s, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const rLo = addBusinessDuration(s, lo, cal);
        return rLo >= s && rLo <= addBusinessDuration(s, hi, cal);
      }),
      { numRuns: 300 },
    );
  });

  it('additive: add(add(s, a), b) == add(s, a + b)', () => {
    fc.assert(
      fc.property(arbCalendar, arbStart, arbSeconds, arbSeconds, (cal, s, a, b) => {
        return addBusinessDuration(addBusinessDuration(s, a, cal), b, cal) === addBusinessDuration(s, a + b, cal);
      }),
      { numRuns: 300 },
    );
  });

  it('exact: the business time between start and result equals the duration', () => {
    fc.assert(
      fc.property(arbCalendar, arbStart, arbSeconds, (cal, s, secs) => {
        return businessMsBetween(s, addBusinessDuration(s, secs, cal), cal) === secs * 1000;
      }),
      { numRuns: 300 },
    );
  });

  it('nextOpening is open (or is the start of business) and nothing between is open', () => {
    fc.assert(
      fc.property(arbCalendar, arbStart, (cal, s) => {
        const o = nextOpening(s, cal);
        if (o < s || !isBusinessOpen(o, cal)) return false;
        return o === s || businessMsBetween(s, o, cal) === 0;
      }),
      { numRuns: 300 },
    );
  });

  it('routing hours agree with the window primitive on ordinary days', () => {
    const z = zone('America/New_York');
    const cal = routing(z);
    for (let m = 0; m < 24 * 60; m += 7) {
      const t = instant(at('2026-05-05T04:00:00Z') + m * MINUTE_MS);
      expect(isBusinessOpen(t, cal)).toBe(localWindowContains(t, z, localTime('08:00'), localTime('21:00')));
    }
  });
});
