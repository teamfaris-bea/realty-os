import { describe, expect, it } from 'vitest';
import { DAY_MS, instant } from '../foundation/index.js';
import { attachPropertyRecord, derivePropertyFeatures, normalizeAddress, normalizeOwnerName, type PostalAddress, type PropertyFacts } from './index.js';

const home: PostalAddress = { line1: '12 North Main Street', line2: 'Apt 4', city: 'Springfield', region: 'IL', postalCode: '62701-1234' };
const contact = { address: home, names: ['Pat Q. Rivera'] };

describe('public records: attach on exact address and owner name only (R-PRED-2, E122)', () => {
  it('R-PRED-2: exact normalized address and an owner-name match ⇒ attach', () => {
    const rec = { address: { line1: '12 N MAIN ST', line2: '#4', city: 'SPRINGFIELD', region: 'il', postalCode: '62701' }, ownerNames: ['RIVERA, PAT Q'] };
    expect(attachPropertyRecord(rec, contact)).toEqual({ attach: true, ownerNameMatch: true });
    expect(attachPropertyRecord({ ...rec, ownerNames: ['RIVERA PAT Q & RIVERA SAM'] }, contact)).toEqual({ attach: true, ownerNameMatch: true });
  });

  it('R-PRED-2 E122: the public record owner name differs from the contact ⇒ not attached, needs review', () => {
    const rec = { address: home, ownerNames: ['Jordan Lee'] };
    expect(attachPropertyRecord(rec, contact)).toEqual({ attach: false, reason: 'needs_review', detail: 'owner_name_mismatch' });
    // a dropped middle initial is a difference too (no guessing)
    expect(attachPropertyRecord({ address: home, ownerNames: ['Pat Rivera'] }, contact)).toMatchObject({ attach: false, reason: 'needs_review' });
    // generational suffix is never dropped
    expect(attachPropertyRecord({ address: home, ownerNames: ['Pat Q Rivera Jr'] }, contact)).toMatchObject({ attach: false, reason: 'needs_review' });
  });

  it('R-PRED-2 E122: an address that is close but not exact ⇒ needs review', () => {
    for (const a of [
      { ...home, line2: 'Apt 5' },
      { ...home, line1: '12 S Main St' },
      { ...home, line1: '120 N Main St' },
      { ...home, postalCode: '62702' },
      { ...home, line2: null },
    ]) {
      expect(attachPropertyRecord({ address: a, ownerNames: ['Pat Q. Rivera'] }, contact)).toEqual({ attach: false, reason: 'needs_review', detail: 'address_mismatch' });
    }
  });

  it('R-PRED-2: missing address parts or names ⇒ needs review', () => {
    expect(attachPropertyRecord({ address: { ...home, postalCode: '' }, ownerNames: ['Pat Q. Rivera'] }, contact)).toMatchObject({ attach: false, detail: 'missing_data' });
    expect(attachPropertyRecord({ address: home, ownerNames: [] }, contact)).toMatchObject({ attach: false, detail: 'missing_data' });
    expect(attachPropertyRecord({ address: home, ownerNames: ['  ,  '] }, contact)).toMatchObject({ attach: false, detail: 'missing_data' });
  });

  it('R-PRED-2: normalizers are order- and case-insensitive but never drop words', () => {
    expect(normalizeOwnerName('RIVERA, Pat Q.')).toBe(normalizeOwnerName('pat q rivera'));
    expect(normalizeOwnerName('José Núñez')).toBe(normalizeOwnerName('JOSE NUNEZ'));
    expect(normalizeAddress(home)).toBe('12 n main st|unit 4|springfield|il|62701');
  });

  it('R-PRED-2: features derive from property facts only, and nothing from an unmatched record', () => {
    const asOf = instant(Date.UTC(2026, 10, 1));
    const facts: PropertyFacts = {
      id: 'pr-1',
      ownerNameMatch: true,
      lastSaleAt: instant(Date.UTC(2014, 5, 1)),
      lastSalePriceCents: 20_000_000,
      assessedValueCents: 32_000_000,
      recentPermit: true,
    };
    const d = derivePropertyFeatures(facts, asOf);
    expect(d.features).toEqual({ yearsInHome: 12, equityBand: 'high', recentPermit: true });
    expect(Object.keys(d.evidence).sort()).toEqual(['equity_band', 'recent_permit', 'years_in_home']);
    expect(d.evidence.years_in_home).toEqual({ sourceType: 'property_record', sourceId: 'pr-1', field: 'last_sale_date' });
    expect(derivePropertyFeatures({ ...facts, ownerNameMatch: false }, asOf)).toEqual({ features: {}, evidence: {} });
    expect(derivePropertyFeatures({ ...facts, assessedValueCents: 21_000_000 }, asOf).features.equityBand).toBe('low');
    expect(derivePropertyFeatures({ ...facts, assessedValueCents: 24_000_000 }, asOf).features.equityBand).toBe('mid');
    // a sale in the future of asOf, or missing facts, yields no feature
    expect(derivePropertyFeatures({ ...facts, lastSaleAt: instant(asOf + DAY_MS), lastSalePriceCents: null, recentPermit: null }, asOf).features).toEqual({});
  });
});
