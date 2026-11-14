import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../foundation/normalize.js';
import { BULK_FICTIONAL_PHONES, BULK_UNSHARED, NON_GEOGRAPHIC_AREAS, OTHER_NANP_FICTIONAL_AREAS, RESERVED_AREAS, UK_DRAMA_BLOCKS, US_FICTIONAL_AREAS, bulkFictionalPhone, fictionalNanp, written } from './index.js';

const FICTIONAL_NANP = /^\+1[2-9]\d{2}55501\d{2}$/;
const UK_DRAMA = /^\+44(?:2079460|1(?:1[3-8]|21|31|41|51|61)4960|1914980|2896496|3069990|8081570|9098790)\d{3}$/;

describe('b17 (B17R-2): fictional phone numbers for tests', () => {
  it('every bulk number is distinct, fictional and valid (libphonenumber, full metadata), and the first BULK_UNSHARED avoid the reserved area codes', () => {
    expect(BULK_FICTIONAL_PHONES).toBe(58_900);
    const all = Array.from({ length: BULK_FICTIONAL_PHONES }, (_, i) => bulkFictionalPhone(i));
    expect(new Set(all).size).toBe(BULK_FICTIONAL_PHONES);
    expect(all.filter((n) => !FICTIONAL_NANP.test(n) && !UK_DRAMA.test(n))).toEqual([]);
    expect(all.filter((n) => { const r = normalizePhone(n, 'US'); return !r.ok || r.e164 !== n; })).toEqual([]);
    const reserved = new Set(RESERVED_AREAS);
    expect(all.slice(0, BULK_UNSHARED).filter((n) => n.startsWith('+1') && reserved.has(n.slice(2, 5)))).toEqual([]);
    expect(all.slice(BULK_UNSHARED).every((n) => reserved.has(n.slice(2, 5)))).toBe(true);
    expect(() => bulkFictionalPhone(BULK_FICTIONAL_PHONES)).toThrow();
    expect(() => bulkFictionalPhone(-1)).toThrow();
  }, 60_000);

  it('the area code lists are what libphonenumber accepts: every line 555-0100 to 555-0199 of each is valid, the reserved and non-geographic codes are among them', () => {
    for (const a of [...US_FICTIONAL_AREAS, ...OTHER_NANP_FICTIONAL_AREAS]) {
      for (const nn of [0, 50, 99]) expect(normalizePhone(fictionalNanp(a, nn), 'US').ok, `${a} ${nn}`).toBe(true);
    }
    expect(RESERVED_AREAS.filter((a) => !US_FICTIONAL_AREAS.includes(a))).toEqual([]);
    expect(NON_GEOGRAPHIC_AREAS.filter((a) => !US_FICTIONAL_AREAS.includes(a))).toEqual([]);
    expect(UK_DRAMA_BLOCKS.every((b) => UK_DRAMA.test(`+44${b}000`))).toBe(true);
  });

  it('fictionalNanp and written', () => {
    expect(fictionalNanp('617', 1)).toBe('+16175550101');
    expect(() => fictionalNanp('617', 100)).toThrow();
    expect(() => fictionalNanp('117', 1)).toThrow();
    expect(written('+16175550101')).toBe('(617) 555-0101');
    expect(written('+442079460123')).toBe('+442079460123');
  });
});
