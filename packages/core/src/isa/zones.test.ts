import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type IanaZone, at, instant, localWindowContains, nextWindowStart, resolveRecipientZones, weekdayOf, zone, localDateOf, type LocalTime } from '../foundation/index.js';
import { AREA_CODE_STATES, areaCodeOf, areaCodeZones } from './areaCodes.js';
import { STATE_ZONES, ZIP3_RANGES, stateOfPostalCode, zonesOfState } from './stateZones.js';
import { CONTINENTAL_ZONES, aiIsaRecipientZones, aiIsaSendWindow, holidaysAround, icuOffsetMinutes, offsetsAgree, usFederalHolidays, type RecipientZoneInput } from './zones.js';
import { runs } from './testing/runs.js';

const base = (o: Partial<RecipientZoneInput> = {}): RecipientZoneInput => ({ contactTz: null, contactTzSource: null, phones: [], pointTzs: [], tenantZone: 'America/New_York', inquiryPostalCode: null, addressStates: [], ...o });
const H = 3600;

describe('R-ISA-10 aiIsaRecipientZones: explicit only when a person set it, otherwise the conservative union', () => {
  it('explicit zone alone', () => {
    expect(aiIsaRecipientZones(base({ contactTz: 'America/Chicago', contactTzSource: 'explicit' }))).toEqual({ zones: ['America/Chicago'], source: 'explicit', evidence: ['explicit'] });
  });
  it('a contact zone with any other source is NOT explicit', () => {
    const r = aiIsaRecipientZones(base({ contactTz: 'America/Chicago', contactTzSource: 'address' }));
    expect(r.source).toBe('union');
    expect(r.zones).toEqual(expect.arrayContaining([...CONTINENTAL_ZONES]));
  });
  it('E512 a New York tenant, an 843 number, a California address: the union is the continental set', () => {
    const r = aiIsaRecipientZones(base({ phones: ['+1 (843) 555-0100'], addressStates: ['CA'] }));
    expect(r.zones).toEqual(['America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York', 'America/Phoenix']);
    expect(r.evidence).toEqual(['address_state', 'area_code', 'continental', 'tenant']);
    // the 09:00–20:00 default in every zone: 12:00–20:00 Eastern in winter
    const t = nextWindowStart(at('2026-11-17T13:00:00Z'), r.zones, (9 * H) as LocalTime, (20 * H) as LocalTime);
    expect(t).toBe(at('2026-11-17T17:00:00Z'));
  });
  it('an email-only lead still gets the continental set plus the tenant zone', () => {
    expect(aiIsaRecipientZones(base({ tenantZone: 'America/Anchorage' })).zones).toEqual([...CONTINENTAL_ZONES, 'America/Anchorage'].sort());
  });
  it('907, 808 and AK/HI evidence add Alaska and Hawaii; removed phones count', () => {
    expect(aiIsaRecipientZones(base({ phones: ['9075550100'] })).zones).toContain('America/Anchorage');
    expect(aiIsaRecipientZones(base({ addressStates: ['hi'] })).zones).toContain('Pacific/Honolulu');
    expect(aiIsaRecipientZones(base({ inquiryPostalCode: '99501' })).zones).toContain('America/Anchorage');
  });
  it('point zones are weak evidence: added, invalid ones ignored', () => {
    const r = aiIsaRecipientZones(base({ pointTzs: ['Europe/London', 'Not/AZone', null] }));
    expect(r.zones).toContain('Europe/London');
    expect(r.zones).not.toContain('Not/AZone');
    expect(r.evidence).toContain('point');
  });
  it('an invalid tenant zone is a configuration error', () => {
    expect(() => aiIsaRecipientZones(base({ tenantZone: 'Mars/Base' }))).toThrow(RangeError);
  });
  it('PINS THE DIFFERENCE with resolveRecipientZones: a point zone of unknown source wins there, never here', () => {
    const point = 'America/Chicago';
    const legacy = resolveRecipientZones({ pointTz: point, areaCodeZones: [zone('America/Los_Angeles')], tenantZone: zone('America/New_York') });
    expect(legacy).toEqual({ zones: ['America/Chicago'], source: 'explicit' });
    const isa = aiIsaRecipientZones(base({ pointTzs: [point], phones: ['3105550100'] }));
    expect(isa.source).toBe('union');
    expect(isa.zones.length).toBeGreaterThan(1);
    expect(isa.zones).toContain('America/Los_Angeles');
    // and the address tier: resolveRecipientZones stops at the address zone; the ISA union does not
    expect(resolveRecipientZones({ addressTz: 'America/New_York', areaCodeZones: [], tenantZone: zone('America/New_York') }).zones).toEqual(['America/New_York']);
  });
});

describe('static zone data (every row VERIFY)', () => {
  it('every state and area-code zone is a valid IANA zone, and every area code is three NANP digits', () => {
    for (const zs of Object.values(STATE_ZONES)) for (const z of zs) expect(() => zone(z)).not.toThrow();
    for (const [code, states] of Object.entries(AREA_CODE_STATES)) {
      expect(code).toMatch(/^[2-9]\d{2}$/);
      expect(states.length).toBeGreaterThan(0);
      for (const st of states) expect(STATE_ZONES[st]).toBeDefined();
    }
    expect(Object.keys(AREA_CODE_STATES).length).toBeGreaterThan(380);
  });
  it('multi-zone codes list each zone (915 El Paso is in TX: Central and Mountain)', () => {
    expect(areaCodeZones('915')).toEqual(['America/Chicago', 'America/Denver']);
    expect(areaCodeZones('867')).toEqual(expect.arrayContaining(['America/Whitehorse', 'America/Yellowknife', 'America/Iqaluit']));
    expect(areaCodeZones('999')).toEqual([]);
    expect(areaCodeZones(null)).toEqual([]);
  });
  it('area codes and states are read leniently and refused when malformed', () => {
    expect(areaCodeOf('+1 (843) 555-0100')).toBe('843');
    expect(areaCodeOf('18435550100')).toBe('843');
    expect(areaCodeOf('555-0100')).toBeNull();
    expect(areaCodeOf('1235550100')).toBeNull();
    expect(areaCodeOf(undefined)).toBeNull();
    expect(stateOfPostalCode('94110-1234')).toBe('CA');
    expect(stateOfPostalCode('00601')).toBe('PR');
    expect(stateOfPostalCode('96910')).toBe('GU');
    expect(stateOfPostalCode('96201')).toBeNull();
    expect(stateOfPostalCode('abc')).toBeNull();
    expect(zonesOfState(undefined)).toEqual([]);
    expect(zonesOfState(' tx ')).toEqual(['America/Chicago', 'America/Denver']);
    for (const [a, b] of ZIP3_RANGES) expect(a <= b).toBe(true);
  });
});

describe('R-ISA-10 the send window', () => {
  const W = { startSec: 9 * H, endSec: 20 * H, initiated: false, initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true };
  it('E511 a reply at 23:10 recipient time is scheduled for 09:00 local', () => {
    const t = aiIsaSendWindow({ ...W, at: at('2026-11-18T04:10:00Z'), zones: [zone('America/New_York')] });
    expect(t).toBe(at('2026-11-18T14:00:00Z'));
  });
  it('E512 windows that never overlap give null (care ends ZONE_WINDOWS_DO_NOT_OVERLAP)', () => {
    // Guam (+10) and Pago Pago (−11) are 21 h apart: a 09:00–20:00 window overlaps 12:00–20:00 Pago Pago time, a
    // 09:00–12:00 window never does; New York and Shanghai (13 h apart) never overlap at 09:00–20:00
    expect(aiIsaSendWindow({ ...W, at: at('2026-11-18T04:10:00Z'), zones: [zone('Pacific/Guam'), zone('Pacific/Pago_Pago')] })).not.toBeNull();
    expect(aiIsaSendWindow({ ...W, endSec: 12 * H, at: at('2026-11-18T04:10:00Z'), zones: [zone('Pacific/Guam'), zone('Pacific/Pago_Pago')] })).toBeNull();
    expect(aiIsaSendWindow({ ...W, at: at('2026-11-18T04:10:00Z'), zones: [zone('America/New_York'), zone('Asia/Shanghai')] })).toBeNull();
    expect(aiIsaSendWindow({ ...W, at: at('2026-11-18T04:10:00Z'), zones: [] })).toBeNull();
  });
  it('initiated messages skip Sundays and US federal holidays in every zone', () => {
    // Sun 2026-11-22 15:00 UTC → Mon 09:00 ET
    expect(aiIsaSendWindow({ ...W, initiated: true, at: at('2026-11-22T15:00:00Z'), zones: [zone('America/New_York')] })).toBe(at('2026-11-23T14:00:00Z'));
    // Thanksgiving Thu 2026-11-26 → Fri 09:00 ET
    expect(aiIsaSendWindow({ ...W, initiated: true, at: at('2026-11-26T15:00:00Z'), zones: [zone('America/New_York')] })).toBe(at('2026-11-27T14:00:00Z'));
    // a reply is not held for the holiday
    expect(aiIsaSendWindow({ ...W, at: at('2026-11-26T15:00:00Z'), zones: [zone('America/New_York')] })).toBe(at('2026-11-26T15:00:00Z'));
    // without the holiday rule the holiday is allowed
    expect(aiIsaSendWindow({ ...W, initiated: true, noInitiatedOnHolidays: false, at: at('2026-11-26T15:00:00Z'), zones: [zone('America/New_York')] })).toBe(at('2026-11-26T15:00:00Z'));
  });
  it('the caller can pass the holiday calendar (the API passes its own, b13 integration); without one it is holidaysAround', () => {
    const ny = [zone('America/New_York')];
    // Thanksgiving excepted by the caller's calendar: the holiday is allowed; any other calendar date is refused instead
    expect(aiIsaSendWindow({ ...W, initiated: true, holidays: holidaysAround(at('2026-11-26T15:00:00Z')).filter((d) => d !== '2026-11-26'), at: at('2026-11-26T15:00:00Z'), zones: ny })).toBe(at('2026-11-26T15:00:00Z'));
    expect(aiIsaSendWindow({ ...W, initiated: true, holidays: ['2026-11-18'], at: at('2026-11-18T15:00:00Z'), zones: ny })).toBe(at('2026-11-19T14:00:00Z'));
    expect(aiIsaSendWindow({ ...W, initiated: true, holidays: [], at: at('2026-11-26T15:00:00Z'), zones: ny })).toBe(at('2026-11-26T15:00:00Z'));
    // a reply never reads it, and noInitiatedOnHolidays false ignores it
    expect(aiIsaSendWindow({ ...W, holidays: ['2026-11-18'], at: at('2026-11-18T15:00:00Z'), zones: ny })).toBe(at('2026-11-18T15:00:00Z'));
    expect(aiIsaSendWindow({ ...W, initiated: true, noInitiatedOnHolidays: false, holidays: ['2026-11-18'], at: at('2026-11-18T15:00:00Z'), zones: ny })).toBe(at('2026-11-18T15:00:00Z'));
  });
  it('US federal holidays with observed days', () => {
    const h = usFederalHolidays(2026);
    expect(h).toEqual(expect.arrayContaining(['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']));
    expect(usFederalHolidays(2027)).toEqual(expect.arrayContaining(['2027-12-24', '2027-12-25', '2027-12-31', '2027-06-18']));
    expect(usFederalHolidays(2028)).toContain('2028-01-01');
    expect(usFederalHolidays(2022)).toContain('2022-01-01');
    expect(usFederalHolidays(2023)).toContain('2023-01-02');
    expect(holidaysAround(at('2026-06-01T00:00:00Z'))).toContain('2027-01-01');
  });
  it('E514 property: the result lies inside every zone\'s window, 2026–2030, across DST, and initiated results are on allowed non-holiday days', () => {
    const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'America/St_Johns'].map(zone);
    fc.assert(
      fc.property(fc.integer({ min: at('2026-01-01T00:00:00Z'), max: at('2030-12-31T00:00:00Z') }), fc.subarray(ZONES, { minLength: 1, maxLength: 4 }), fc.boolean(), (t, zs, initiated) => {
        const r = aiIsaSendWindow({ ...W, initiated, at: instant(t), zones: zs as IanaZone[] });
        if (r === null) return;
        expect(r >= t).toBe(true);
        for (const z of zs) {
          expect(localWindowContains(r, z, (9 * H) as LocalTime, (20 * H) as LocalTime)).toBe(true);
          if (initiated) {
            expect(W.initiatedDays).toContain(weekdayOf(r, z));
            expect(holidaysAround(r)).not.toContain(localDateOf(r, z));
          }
        }
      }),
      { numRuns: runs(400) },
    );
  });
  it('E514 offsets agree with a DB reading; a mismatch is reported', () => {
    const t = at('2026-03-08T07:30:00Z'); // just after the US DST start
    const ny = zone('America/New_York');
    expect(icuOffsetMinutes(ny, t)).toBe(-240);
    expect(icuOffsetMinutes(ny, at('2026-03-08T06:30:00Z'))).toBe(-300);
    expect(offsetsAgree([ny], t, { 'America/New_York': -240 })).toBe(true);
    expect(offsetsAgree([ny], t, { 'America/New_York': -300 })).toBe(false);
    expect(icuOffsetMinutes(zone('America/St_Johns'), at('2026-01-10T12:00:00Z'))).toBe(-210);
  });
});
