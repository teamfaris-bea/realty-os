// b13 Sunday time bomb: the AI ISA guard cases (rls_smoke_ai_isa.test.ts) pick a fixed-offset zone by the clock of the
// run. openZone() used to throw 'no open zone now' on a Sunday from about 06:00 to 22:00 UTC (no zone is on a Monday to
// Saturday at 10:00-17:59 then), failing every case built on leadUnderCare(). These cases force the fixture's clock to
// every Sunday hour and to every hour of a week; no database.
import { describe, expect, it } from 'vitest';
import { closedZone, initiatedZone, openWeekdayZone, openZone } from './rls_smoke_ai_isa.fixture.js';

const local = (zone: string, d: Date) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!) + 1 };
};
const canonical = (z: string) => new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;

describe('the AI ISA guard fixture picks a zone at every hour of the week (b13 Sunday time bomb; R-ISA-10)', () => {
  it('every hour of a week: openZone, openWeekdayZone and closedZone always pick a canonical zone that is open (10:00-17:59) or closed (01:00-04:59)', () => {
    let initiated = 0;
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      for (const minute of [0, 30, 59]) {
        const d = new Date(Date.UTC(2026, 10, 9, hour, minute)); // Monday 2026-11-09 00:00 UTC onward
        for (const [name, z] of [['open', openZone(d)], ['weekday', openWeekdayZone(d)]] as const) {
          expect(canonical(z), `${d.toISOString()} ${name} -> ${z}`).toBe(z);
          const l = local(z, d);
          expect(l.hour >= 10 && l.hour < 18, `${d.toISOString()} ${name} -> ${z}`).toBe(true);
        }
        const i = initiatedZone(d);
        if (i !== undefined) {
          if (minute === 30) initiated += 1;
          expect(openZone(d)).toBe(i);
          expect(local(i, d).dow).toBeLessThanOrEqual(6);
        } else {
          expect(d.getUTCDay(), `${d.toISOString()} no Mon-Sat zone`).toBe(0);
          expect(local(openZone(d), d).dow).toBe(7);
        }
        const c = closedZone(d);
        expect(canonical(c)).toBe(c);
        const lc = local(c, d);
        expect(lc.hour >= 1 && lc.hour < 5, `${d.toISOString()} closed -> ${c}`).toBe(true);
      }
    }
    expect(initiated).toBe(7 * 24 - 16);
  });

  it('from 06:00 to 21:59 UTC on a Sunday no zone is on a permitted initiated day; openZone falls back to a zone open on the Sunday instead of throwing', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 15, 30, 45, 59]) {
        const d = new Date(Date.UTC(2026, 10, 15, hour, minute)); // Sunday 2026-11-15
        const gap = hour >= 6 && hour < 22;
        expect(initiatedZone(d) === undefined, d.toISOString()).toBe(gap);
        const o = openZone(d);
        const l = local(o, d);
        expect(l.hour >= 10 && l.hour < 18, `${d.toISOString()} -> ${o}`).toBe(true);
        expect(l.dow, `${d.toISOString()} -> ${o}`).toBe(gap ? 7 : hour < 6 ? 6 : 1);
      }
    }
  });
});
