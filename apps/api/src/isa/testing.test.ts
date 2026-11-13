// b12 recheck R25: the AI ISA test fixtures pick a fixed-offset zone by the hour of the run. A zone whose canonical
// name differs from its own (core ianaZone: 'Etc/GMT' is 'UTC') is stored on the contact as written while the turn
// stores the canonical name, so the DB guard refuses every AI send ISA_ZONE_UNRESOLVED during the hour the fixture
// picks it. These cases force the fixture's clock to every hour of a week; no database.
import { ianaZone } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { closedZone, initiatedZone, openZone } from './testing.js';

const at = (iso: string) => new Date(iso);
const local = (zone: string, d: Date) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!) + 1 };
};

describe('b12 recheck R25: the AI ISA zone fixtures pick only canonical zone names (R-ISA-10)', () => {
  it('at 10:00-10:59 UTC on a weekday, openZone picks a zone whose canonical name is its own', () => {
    for (const iso of ['2026-11-13T10:00:00Z', '2026-11-13T10:30:00Z', '2026-11-13T10:59:59Z']) {
      const z = openZone(at(iso));
      expect(ianaZone(z), `${iso} -> ${z}`).toBe(z);
    }
  });

  it('every hour of a week: openZone and closedZone always pick a canonical zone that is open (10:00-17:59; Mon-Sat whenever any zone is) or closed (01:00-04:59) then', () => {
    let initiated = 0;
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      for (const minute of [0, 30, 59]) {
        const d = new Date(Date.UTC(2026, 10, 9, hour, minute)); // Monday 2026-11-09 00:00 UTC onward
        const o = openZone(d);
        const c = closedZone(d);
        const i = initiatedZone(d);
        expect(typeof o, `${d.toISOString()} open`).toBe('string');
        expect(ianaZone(o), `${d.toISOString()} open -> ${o}`).toBe(o);
        const lo = local(o, d);
        expect(lo.hour >= 10 && lo.hour < 18, `${d.toISOString()} open -> ${o}`).toBe(true);
        if (i !== undefined) {
          if (minute === 30) initiated += 1;
          expect(o, `${d.toISOString()}: openZone prefers a Mon-Sat zone`).toBe(i);
          expect(lo.dow <= 6, `${d.toISOString()} initiated -> ${i}`).toBe(true);
        } else {
          // only on a Sunday (UTC), and then the fallback zone is on the Sunday too
          expect(d.getUTCDay(), `${d.toISOString()} no Mon-Sat zone`).toBe(0);
          expect(lo.dow, `${d.toISOString()} fallback -> ${o}`).toBe(7);
        }
        expect(ianaZone(c), `${d.toISOString()} closed -> ${c}`).toBe(c);
        const lc = local(c, d);
        expect(lc.hour >= 1 && lc.hour < 5, `${d.toISOString()} closed -> ${c}`).toBe(true);
      }
    }
    expect(initiated).toBe(7 * 24 - 16);
  });

  it('b13 time bomb: from 06:00 to 21:59 UTC on a Sunday there is no Mon-Sat zone, and openZone (so isaLead) still writes a zone open on the Sunday', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 15, 30, 45, 59]) {
        const d = new Date(Date.UTC(2026, 10, 15, hour, minute)); // Sunday 2026-11-15
        const gap = hour >= 6 && hour < 22;
        expect(initiatedZone(d) === undefined, `${d.toISOString()}`).toBe(gap);
        const o = openZone(d);
        expect(o, `${d.toISOString()}`).toMatch(/^(UTC|Etc\/GMT[+-]\d{1,2})$/);
        const lo = local(o, d);
        expect(lo.hour >= 10 && lo.hour < 18, `${d.toISOString()} -> ${o}`).toBe(true);
        expect(lo.dow, `${d.toISOString()} -> ${o}`).toBe(gap ? 7 : hour < 6 ? 6 : 1);
      }
    }
  });
});
