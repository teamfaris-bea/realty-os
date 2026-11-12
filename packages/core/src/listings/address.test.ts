// addressKey (F2) and geoCell (S0 parity is in apps/api/src/mls/comps.test.ts). R-CMA-1, E365 (the key part).
import { describe, expect, it } from 'vitest';
// test-only import for the parity check: R-PRED-4 keeps prediction code out of the pricing paths, not out of tests
import { normalizeAddress } from '../predict/index.js';
import { type AddressInput, addressKey, cellsWithin, geoCell, streetOfKey, uspsCode } from './address.js';

/** predict's fixture table (core/predict/property.test.ts), as its tests feed normalizeAddress. */
const home = { line1: '12 North Main Street', line2: 'Apt 4', city: 'Springfield', region: 'IL', postalCode: '62701-1234' };
const PREDICT_TABLE: AddressInput[] = [
  home,
  { line1: '12 N MAIN ST', line2: '#4', city: 'SPRINGFIELD', region: 'il', postalCode: '62701' },
  { ...home, line2: 'Apt 5' },
  { ...home, line1: '12 S Main St' },
  { ...home, line1: '120 N Main St' },
  { ...home, postalCode: '62702' },
  { ...home, line2: null },
  { ...home, postalCode: '' },
];

describe('addressKey (F2)', () => {
  it('R-CMA-1: equals predict normalizeAddress on predict\'s fixture table', () => {
    for (const a of PREDICT_TABLE) expect(addressKey(a), JSON.stringify(a)).toBe(normalizeAddress({ ...a, line2: a.line2 ?? null }));
    expect(addressKey(home)).toBe('12 n main st|unit 4|springfield|il|62701');
  });

  it('E365 R-CMA-1: "123 Main St Unit 4" + UnitNumber 4 matches "123 Main St" / "Apt 4"', () => {
    const contact = addressKey({ line1: '123 Main St', line2: 'Apt 4', city: 'Charleston', region: 'SC', postalCode: '29401' });
    expect(contact).toBe('123 main st|unit 4|charleston|sc|29401');
    expect(addressKey({ line1: '123 Main St Unit 4', line2: 'Unit 4', city: 'Charleston', region: 'SC', postalCode: '29401', parts: { unitNumber: '4' } })).toBe(contact);
    expect(addressKey({ line1: '123 Main Street #4', city: 'Charleston', region: 'SC', postalCode: '29401' })).toBe(contact);
    expect(addressKey({ line1: '123 Main St, Suite 4', city: 'Charleston', region: 'SC', postalCode: '29401' })).toBe(contact);
    expect(addressKey({ line1: 'x', city: 'Charleston', region: 'SC', postalCode: '29401-0001', parts: { streetNumber: '123', streetName: 'Main', streetSuffix: 'Street', unitNumber: '#4' } })).toBe(contact);
  });

  it('E365 R-CMA-1: an UnparsedAddress carrying ", City, SC 29900" matches the parts; "South Carolina" matches "SC"', () => {
    const parts = addressKey({ line1: '', city: 'Exampleville', region: 'SC', postalCode: '29900', parts: { streetNumber: '40', streetDirPrefix: 'W', streetName: 'Marsh', streetSuffix: 'Ln' } });
    expect(parts).toBe('40 w marsh ln||exampleville|sc|29900');
    expect(addressKey({ line1: '40 West Marsh Lane, Exampleville, SC 29900', city: 'Exampleville', region: 'SC', postalCode: '29900' })).toBe(parts);
    expect(addressKey({ line1: '40 W Marsh Ln Exampleville SC 29900', city: 'Exampleville', region: 'SC', postalCode: '29900' })).toBe(parts);
    expect(addressKey({ line1: '40 W Marsh Ln', city: 'Exampleville', region: 'South Carolina', postalCode: '29900' })).toBe(parts);
    expect(addressKey({ line1: '40 W Marsh Ln', city: 'EXAMPLEVILLE', region: ' south  carolina ', postalCode: '29900-1234' })).toBe(parts);
  });

  it('R-CMA-1: different homes keep different keys; a missing part is null', () => {
    const k = (line1: string, line2: string | null = null) => addressKey({ line1, line2, city: 'Exampleville', region: 'SC', postalCode: '29900' });
    expect(new Set([k('40 W Marsh Ln'), k('40 E Marsh Ln'), k('41 W Marsh Ln'), k('40 W Marsh Ln', 'Unit 2'), k('40 W Marsh Ct')]).size).toBe(5);
    expect(k('100 Exampleville Rd')).toBe('100 exampleville rd||exampleville|sc|29900'); // a street named like the city keeps its name
    expect(addressKey({ line1: '1 A St', city: '', region: 'SC', postalCode: '29900' })).toBeNull();
    expect(addressKey({ line1: '  ', city: 'X', region: 'SC', postalCode: '29900' })).toBeNull();
    expect(addressKey({ line1: '1 A St', city: 'X', region: 'SC', postalCode: '2990' })).toBeNull();
    expect(addressKey({ line1: '1 A St', city: 'X', region: 'Ontario', postalCode: '29900' })).toBe('1 a st||x|ontario|29900');
  });

  it('streetOfKey: the street number and street-name tokens for near matches', () => {
    expect(streetOfKey('40 w marsh ln|unit 2|exampleville|sc|29900')).toEqual({ streetNumber: '40', streetNameTokens: ['w', 'marsh', 'ln'], postalCode: '29900' });
    expect(streetOfKey('marsh ln||x|sc|29900')).toBeNull();
    expect(streetOfKey('40 marsh||x|sc|2990')).toBeNull();
  });

  it('uspsCode folds codes and names; unknown regions are null', () => {
    expect(['SC', 'sc', 'South Carolina', 'district of columbia', 'Washington DC', 'Puerto Rico', 'Ontario', ''].map(uspsCode)).toEqual(['SC', 'SC', 'SC', 'DC', 'DC', 'PR', null, null]);
  });
});

describe('geoCell (S0 listings.geo_cell)', () => {
  it('R-CMA-1: mirrors the generated column\'s formula, including negatives, 0 and the poles', () => {
    expect(geoCell(null, 1)).toBeNull();
    expect(geoCell(1, null)).toBeNull();
    expect(geoCell(0, 0)).toBe(6300 * 25000 + 12500);
    expect(geoCell(-1, -1)).toBe(6299 * 25000 + 12499); // floor, not truncation toward zero
    expect(geoCell(14_493, 14_493)).toBe(6301 * 25000 + 12501);
    expect(geoCell(-90_000_000, -180_000_000)).toBe(2_250_080);
    expect(geoCell(90_000_000, 180_000_000)).toBe(312_749_919);
  });

  it('cellsWithin covers every point within the radius (property over a grid of offsets)', () => {
    const lat = 32_776_512;
    const lon = -79_931_046;
    const cells = new Set(cellsWithin(lat, lon, 3));
    for (let i = 0; i < 400; i++) {
      const bearing = (i / 400) * 2 * Math.PI;
      const miles = 3 * ((i % 7) / 6);
      const dLat = (miles / 69.09) * Math.cos(bearing);
      const dLon = (miles / (69.09 * Math.cos((lat / 1e6) * (Math.PI / 180)))) * Math.sin(bearing);
      expect(cells.has(geoCell(Math.round(lat + dLat * 1e6), Math.round(lon + dLon * 1e6))!)).toBe(true);
    }
    expect(cellsWithin(lat, lon, 0)).toEqual([geoCell(lat, lon)]);
  });
});
