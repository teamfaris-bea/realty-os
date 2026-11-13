// R-MLS-7 (ISA part): the ISA's listing facts, buyer listing lines, competitor lines and the comps email never state
// a size they do not have: an unknown size (null, or omitted for the audience) is left out, never "0 sq ft", never a
// guess, and the subject line never ends in an empty list. E603.
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import type { DisplayListing } from '../listings/index.js';
import { type IsaCompResult, type IsaCompView, renderBuyerListing, renderCompetitor, renderCompsEmail, subjectLine } from './facts.js';

const AS_OF = at('2026-11-12T08:00:00Z');
const src = { mlsName: 'Sample MLS', teamName: 'Maple Team', asOf: AS_OF, fresh: true };
const listing = (o: Partial<DisplayListing> = {}): DisplayListing => ({
  audience: 'client',
  id: null,
  source: 'mls',
  sourceLabel: 'MLS',
  isTeamListing: false,
  listingBrokerageName: 'Other Brokerage Inc',
  attribution: 'Listing data courtesy of Sample MLS.',
  disclaimer: 'Information deemed reliable but not guaranteed.',
  addressHidden: true,
  omittedFields: ['address', 'description', 'photos'],
  status: 'active',
  listPriceCents: 45_000_000,
  beds: 3,
  bathsX10: 25,
  sqft: null,
  locality: { city: 'Springfield', region: 'IL', postalCode: '62701' },
  ...o,
});
const SIZE = /sq\s*ft|square/i;

describe('E603 R-MLS-7: ISA facts never state a size they do not have', () => {
  it('E603 R-MLS-7: a buyer listing line with an unknown size (null, or omitted for the audience) has no size and keeps every other fact', () => {
    for (const d of [listing(), listing({ sqft: undefined, omittedFields: ['address', 'description', 'photos', 'sqft'] })]) {
      const r = renderBuyerListing(d, src);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.line).not.toMatch(SIZE);
      expect(r.line.startsWith('3 bd · 2.5 ba · Springfield — listed at $450,000 (asking price)')).toBe(true);
    }
  });

  it('E603 R-MLS-7: competitor lines (new, price change, back on market, pending) with an unknown size have no size', () => {
    for (const event of ['new_competitor', 'competitor_price_change', 'competitor_back_on_market'] as const) {
      const r = renderCompetitor(listing(), src, event);
      expect(r.ok && r.line).not.toMatch(SIZE);
    }
    const pending = renderCompetitor(listing({ status: 'pending' }), src, 'competitor_pending');
    expect(pending.ok).toBe(true);
    expect(pending.ok && pending.line).not.toMatch(SIZE);
  });

  it('E603 R-MLS-7: the subject line names only the facts the record has, and never ends in an empty list', () => {
    expect(subjectLine({ recordDate: '2020-01-02', beds: 3, sqft: null })).toBe("Compared using your home's MLS record from Jan 2, 2020: 3 bd. Tell me if that's changed.");
    expect(subjectLine({ recordDate: '2020-01-02', beds: null, sqft: null })).toBe("Compared using your home's MLS record from Jan 2, 2020. Tell me if that's changed.");
  });

  it('E603 R-MLS-7: in the comps email, an unknown subject size is not stated and a comp line states only the sizes it has', () => {
    const comp = (k: number, o: Partial<IsaCompView> = {}): IsaCompView => ({ identity: `id${k}`, closePriceCents: 40_000_000 + k * 1_000_000, closeDate: '2026-08-0' + ((k % 9) + 1), beds: 3, sqft: 1800, tier: 'within_1mi', locationLabel: null, listingBrokerageName: 'Other Brokerage Inc', why: 'Same type, within a mile', ...o });
    const result: IsaCompResult = { methodVersion: 'cma/1', comps: [comp(0), comp(1, { sqft: null }), comp(2), comp(3)], areaLookbackMonths: 12, sizeFilterApplied: true, bedsFilterApplied: true, sentences: [] };
    const r = renderCompsEmail({ result, gates: { blockers: [], packsCleared: true, subjectConfirmed: true }, subject: { recordDate: '2020-01-02', beds: 3, sqft: null }, mlsName: 'Sample MLS', teamName: 'Maple Team', asOf: AS_OF, stateStatement: null, attribution: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.body.split('\n\n');
    expect(lines[1]).toBe("Compared using your home's MLS record from Jan 2, 2020: 3 bd. Tell me if that's changed.");
    expect(lines.filter((l) => /^\d+\. Sold for/.test(l)).map((l) => SIZE.test(l))).toEqual([true, false, true, true]);
    expect(r.body).not.toMatch(/\b0 sq ft/);
  });

  it('E609 R-MLS-7: a size of 0 is no size: a buyer or competitor line, the subject line and a comp line never say "0 sq ft"', () => {
    const zero = listing({ sqft: 0 });
    const r = renderBuyerListing(zero, src);
    expect(r.ok && r.line).not.toMatch(SIZE);
    const c = renderCompetitor(zero, src, 'new_competitor');
    expect(c.ok && c.line).not.toMatch(SIZE);
    expect(subjectLine({ recordDate: '2020-01-02', beds: 3, sqft: 0 })).toBe("Compared using your home's MLS record from Jan 2, 2020: 3 bd. Tell me if that's changed.");
    const comp = (k: number, sqft: number | null): IsaCompView => ({ identity: `id${k}`, closePriceCents: 40_000_000 + k * 1_000_000, closeDate: '2026-08-0' + ((k % 9) + 1), beds: 3, sqft, tier: 'within_1mi', locationLabel: null, listingBrokerageName: 'Other Brokerage Inc', why: 'Same type, within a mile' });
    const result: IsaCompResult = { methodVersion: 'cma/1', comps: [comp(0, 0), comp(1, 1800), comp(2, 1750)], areaLookbackMonths: 12, sizeFilterApplied: true, bedsFilterApplied: true, sentences: [] };
    const e = renderCompsEmail({ result, gates: { blockers: [], packsCleared: true, subjectConfirmed: true }, subject: { recordDate: '2020-01-02', beds: 3, sqft: 0 }, mlsName: 'Sample MLS', teamName: 'Maple Team', asOf: AS_OF, stateStatement: null, attribution: null });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.body).not.toMatch(/\b0 sq ft/);
    expect(e.body.split('\n\n').filter((l) => /^\d+\. Sold for/.test(l)).map((l) => SIZE.test(l))).toEqual([false, true, true]);
  });
});
