// b12 recheck R25: the AI ISA test fixtures pick a fixed-offset zone by the hour of the run. A zone whose canonical
// name differs from its own (core ianaZone: 'Etc/GMT' is 'UTC') is stored on the contact as written while the turn
// stores the canonical name, so the DB guard refuses every AI send ISA_ZONE_UNRESOLVED during the hour the fixture
// picks it. These cases force the fixture's clock to every hour of a week; no database.
import { ianaZone } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { closedZone, openZone } from './testing.js';

const at = (iso: string) => new Date(iso);

describe('b12 recheck R25: the AI ISA zone fixtures pick only canonical zone names (R-ISA-10)', () => {
  it('at 10:00-10:59 UTC on a weekday, openZone picks a zone whose canonical name is its own', () => {
    for (const iso of ['2026-11-13T10:00:00Z', '2026-11-13T10:30:00Z', '2026-11-13T10:59:59Z']) {
      const z = openZone(at(iso));
      expect(ianaZone(z), `${iso} -> ${z}`).toBe(z);
    }
  });

  it('every hour of a week: openZone and closedZone pick a canonical zone that is open (10:00-17:59, Mon-Sat) or closed (01:00-04:59) then', () => {
    const local = (zone: string, d: Date) => {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
      const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
      return { hour: Number(p.hour), dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!) + 1 };
    };
    let open = 0;
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      const d = new Date(Date.UTC(2026, 10, 9, hour, 30)); // Monday 2026-11-09 00:30 UTC onward
      // (on a Sunday morning UTC no zone of the fixture is open Monday to Saturday: it picks nothing, as before)
      const o = openZone(d) as string | undefined;
      const c = closedZone(d);
      if (o !== undefined) {
        open += 1;
        expect(ianaZone(o), `${d.toISOString()} open -> ${o}`).toBe(o);
        const lo = local(o, d);
        expect(lo.hour >= 10 && lo.hour < 18 && lo.dow <= 6, `${d.toISOString()} open -> ${o}`).toBe(true);
      }
      expect(ianaZone(c), `${d.toISOString()} closed -> ${c}`).toBe(c);
      const lc = local(c, d);
      expect(lc.hour >= 1 && lc.hour < 5, `${d.toISOString()} closed -> ${c}`).toBe(true);
    }
    expect(open).toBeGreaterThan(6 * 24 - 12);
  });
});
