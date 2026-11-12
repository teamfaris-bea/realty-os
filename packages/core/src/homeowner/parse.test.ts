import { describe, expect, it } from 'vitest';
import { parseHomeownerRecord } from './parse.js';
import type { HomeownerField } from './types.js';

const TODAY = '2026-11-12';
const ADDRESS = { line1: '10 Sample Lane', city: 'Exampleton', region: 'SC', postalCode: '29902' };
const base = (homeowner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  address: ADDRESS,
  ownerNames: ['SAMPLE OWNER A'],
  source: 'Beaufort County GIS parcel layer',
  providerRef: 'TEST-0001',
  homeowner,
  ...extra,
});
const found = (raw: unknown) => {
  const r = parseHomeownerRecord(raw, { today: TODAY });
  if (r.status !== 'found') throw new Error('expected found');
  return r.record;
};

describe('parseHomeownerRecord (R-HOME-3, R-HOME-4)', () => {
  it('R-HOME-4: keeps each listed value with its source and as-of date, bare or wrapped', () => {
    const r = found(base({
      last_transfer_date: { value: '2015-06-01', source: 'Beaufort County Register of Deeds', asOf: '2026-10-01' },
      last_transfer_price_cents: 25_000_000,
      owner_mailing_address: 'PO BOX 1, EXAMPLETON SC 29902',
      tax_year: 2025,
      exemption_legal_residence: true,
    }, { asOf: '2026-09-30' }));
    expect(r.facts.last_transfer_date).toEqual({ value: '2015-06-01', source: 'Beaufort County Register of Deeds', asOf: '2026-10-01' });
    expect(r.facts.last_transfer_price_cents).toEqual({ value: 25_000_000, source: 'Beaufort County GIS parcel layer', asOf: '2026-09-30' });
    expect(r.facts.tax_year?.value).toBe(2025);
    expect(r.facts.exemption_legal_residence?.value).toBe(true);
    expect(r.providerRef).toBe('TEST-0001');
    expect(r.recordAsOf).toBe('2026-09-30');
  });

  it('R-HOME-3 E580: every other key is dropped: age, phone, email, lender, instruments, co-owner addresses, a balance or an estimate', () => {
    const r = found(base(
      { owner_age: 61, phone: '+15555550100', email: 'x@example.test', lender: 'SAMPLE BANK', instruments: [{ book: 1 }], co_owner_addresses: ['x'],
        loan_balance_cents: 100, equity_cents: 1, estimated_value_cents: 2, last_transfer_price_cents: 5 },
      { age: 61, maritalStatus: 'x', phone: '+15555550100', instruments: [] },
    ));
    expect(Object.keys(r.facts)).toEqual(['last_transfer_price_cents']);
    expect(Object.keys(r).sort()).toEqual(['address', 'facts', 'ownerNames', 'providerRef', 'recordAsOf', 'source']);
    expect(JSON.stringify(r)).not.toMatch(/61|5555550100|example\.test|SAMPLE BANK|book/);
  });

  it('R-HOME-4: a value with no valid source (its own or the record\'s) is dropped', () => {
    const r = found({ address: ADDRESS, ownerNames: [], homeowner: { tax_year: 2025, last_transfer_date: { value: '2015-06-01', source: 'bad<source>' }, assessed_value_cents: { value: 1, source: 'County Assessor' } } });
    expect(Object.keys(r.facts)).toEqual(['assessed_value_cents']);
  });

  it('R-HOME-4 E581: malformed values are dropped: future or pre-1800 dates, impossible dates, negative or fractional cents, a tax year out of range, a non-boolean exemption', () => {
    const r = found(base({
      last_transfer_date: '2026-11-14',
      last_transfer_price_cents: -1,
      county_market_value_cents: 1.5,
      assessed_value_cents: Number.MAX_SAFE_INTEGER + 2,
      annual_tax_cents: '100',
      tax_year: 1899,
      exemption_homestead: 'yes',
    }));
    expect(r.facts).toEqual({});
    expect(found(base({ last_transfer_date: '1799-12-31' })).facts).toEqual({});
    expect(found(base({ last_transfer_date: '2023-02-29' })).facts).toEqual({});
    expect(found(base({ last_transfer_date: '2026-11-13' })).facts.last_transfer_date?.value).toBe('2026-11-13'); // today + 1 is allowed
    expect(found(base({ last_transfer_date: '2024-02-29' })).facts.last_transfer_date?.value).toBe('2024-02-29');
  });

  it('R-HOME-4 E581: strings are capped and refuse control and bidi characters', () => {
    for (const bad of ['PO BOX 1\nEXAMPLETON', 'PO BOX 1‮EXAMPLETON', 'PO BOX\u0000 1', 'A'.repeat(301), '   ']) {
      expect(found(base({ owner_mailing_address: bad })).facts.owner_mailing_address, JSON.stringify(bad)).toBeUndefined();
    }
    expect(found(base({ owner_mailing_address: 'A'.repeat(300) })).facts.owner_mailing_address?.value).toHaveLength(300);
    const owners = found(base({}, { ownerNames: ['SAMPLE OWNER A', 'X⁦Y', 1, 'Z'.repeat(201)] })).ownerNames;
    expect(owners).toEqual(['SAMPLE OWNER A']);
  });

  it('R-HOME-3: at most ten owner names are read', () => {
    const names = Array.from({ length: 14 }, (_, i) => `SAMPLE OWNER ${i}`);
    expect(found(base({}, { ownerNames: names })).ownerNames).toHaveLength(10);
  });

  it('R-HOME-3: no usable address or available:false is not available; the ambiguous detail passes through', () => {
    expect(parseHomeownerRecord(null, { today: TODAY })).toEqual({ status: 'not_available', detail: 'no_record' });
    expect(parseHomeownerRecord({ available: false }, { today: TODAY })).toEqual({ status: 'not_available', detail: 'no_record' });
    expect(parseHomeownerRecord({ available: false, detail: 'ambiguous' }, { today: TODAY })).toEqual({ status: 'not_available', detail: 'ambiguous' });
    expect(parseHomeownerRecord({ address: { line1: '1 Sample Way', city: 'X' } }, { today: TODAY }).status).toBe('not_available');
    expect(parseHomeownerRecord({ address: { ...ADDRESS, line1: 'A‮B' } }, { today: TODAY }).status).toBe('not_available');
  });

  it('R-HOME-4: a malformed providerRef is dropped', () => {
    expect(found(base({}, { providerRef: 'TEST 0001; DROP' })).providerRef).toBeNull();
  });

  it('R-HOME-4: the field type cannot express a loan balance, equity or an estimate (compile-time)', () => {
    type Forbidden = 'loanBalance' | 'equity' | 'estimatedValue' | 'loan_balance_cents' | 'equity_cents' | 'estimated_value_cents' | 'score' | 'confidence';
    // @ts-expect-error none of the forbidden names is a HomeownerField
    const f: HomeownerField = 'loanBalance' as Forbidden;
    expect(f).toBe('loanBalance');
    const none: Extract<HomeownerField, Forbidden> extends never ? true : false = true;
    expect(none).toBe(true);
  });
});
