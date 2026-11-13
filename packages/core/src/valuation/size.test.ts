// R-MLS-7 (the engine part) and R-CMA-2/3: a sale or subject whose size is unknown (the MLS has not confirmed a
// finished-living-area field, so the sync stores none) gets no size similarity, no size adjustment and no price per
// sq ft: the sale is not a comp and says why, the subject is not valued without a size, and the result says how many
// sales were left out for it. Never a crash, never a size taken from somewhere else. E601.
import { describe, expect, it } from 'vitest';
import { type CmaCandidate, type CmaResult, type PrepareCmaInput, prepareCma } from './index.js';
import { SUBJECT_LAT, VALUATION_DATE, cand, linearMarket, monthsBefore, subject } from './testing/fixtures.js';

function run(over: Partial<PrepareCmaInput> & { candidates: readonly CmaCandidate[] }): CmaResult {
  return prepareCma({ subject: subject(), tierReads: [], valuationDate: VALUATION_DATE, ...over });
}

/** `n` ordinary nearby sales within the last year; `sized` false: the MLS gave no size (sqft and its source null). */
function sales(prefix: string, n: number, sized: boolean): CmaCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    cand(`${prefix}${i + 1}`, {
      closePriceCents: 40_000_000 + i * 500_000,
      closeDate: monthsBefore(i + 1),
      contractDate: monthsBefore(i + 2),
      sqft: sized ? 1_950 + i * 25 : null,
      sizeSource: sized ? 'LivingArea' : null,
      latE6: SUBJECT_LAT + (i + 1) * 1_000,
    }),
  );
}

const NOT_USED_NO_SIZE = 'Not used: size not available from the MLS.';

describe('E601 R-MLS-7: unknown sizes are skipped, never invented, and said', () => {
  it('E601 R-MLS-7 R-CMA-2: when no sale of this kind has a size there is no value, and the result says the sales were found but have no size from the MLS', () => {
    const r = run({ candidates: sales('n', 6, false) });
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe('NO_SALES');
    expect(r.comps).toEqual([]);
    expect(r.sentences).toEqual([
      'No value: no closed sales of this kind of home with a size from the MLS were found.',
      '6 closed sales of this kind of home were not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for them.',
    ]);
    expect(r.sentences.join(' ')).not.toMatch(/no closed sales of this kind of home were found/);
    expect(r.notUsed.map((n) => [n.reason, n.sentence, n.includable])).toEqual(Array.from({ length: 6 }, () => ['no_size', NOT_USED_NO_SIZE, false]));
    // no price per sq ft or size rate is fitted on sales without a size
    expect(r.market.poolSales).toBe(0);
    expect(r.market.rates.filter((x) => x.applied)).toEqual([]);
  });

  it('E601 R-MLS-7 R-CMA-3: with sized and unsized sales, only the sized ones are comps; every size adjustment has both sizes; the unsized ones are listed and counted', () => {
    const r = run({ candidates: [...sales('s', 5, true), ...sales('u', 3, false)] });
    expect(r.available).toBe(true);
    expect(r.comps.map((c) => c.ref.identity).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    for (const c of r.comps) {
      expect(c.sale.sqft).not.toBeNull();
      for (const a of c.adjustments.filter((x) => x.feature === 'size')) {
        expect(a.subjectValue).not.toBeNull();
        expect(a.compValue).not.toBeNull();
      }
    }
    expect(r.notUsed.filter((n) => n.reason === 'no_size').map((n) => [n.ref.identity, n.sentence]).sort()).toEqual([
      ['u1', NOT_USED_NO_SIZE],
      ['u2', NOT_USED_NO_SIZE],
      ['u3', NOT_USED_NO_SIZE],
    ]);
    expect(r.sentences).toContain('3 closed sales of this kind of home were not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for them.');
  });

  it('E601 R-MLS-7: one unsized sale is worded in the singular; a size of 0 is no size (never "0 sq ft")', () => {
    const r = run({ candidates: [...sales('s', 5, true), cand('zero', { sqft: 0, sizeSource: 'LivingArea', closeDate: monthsBefore(1), latE6: SUBJECT_LAT + 500 })] });
    expect(r.notUsed.find((n) => n.ref.identity === 'zero')).toMatchObject({ reason: 'no_size', sentence: NOT_USED_NO_SIZE });
    expect(r.sentences).toContain('1 closed sale of this kind of home was not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for it.');
    expect(JSON.stringify(r)).not.toMatch(/\b0 sq ft/);
  });

  it('E601 R-MLS-7: fewer than 3 sized sales beside unsized ones: INSUFFICIENT_COMPS, and the unsized ones are said', () => {
    const r = run({ candidates: [...sales('s', 2, true), ...sales('u', 4, false)] });
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe('INSUFFICIENT_COMPS');
    expect(r.sentences).toEqual([
      'No value: 2 comparable sales were found, and at least 3 are needed.',
      '4 closed sales of this kind of home were not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for them.',
    ]);
  });

  it('E601 R-MLS-7: a subject without a size is not valued (no comps, no rates), and nothing throws', () => {
    for (const sqft of [null, 0]) {
      const r = run({ subject: subject({ sqft, sizeSource: null }), candidates: sales('s', 6, true) });
      expect(r.available).toBe(false);
      if (r.available) continue;
      expect(r.reason).toBe('SUBJECT_INCOMPLETE');
      expect(r.comps).toEqual([]);
      expect(r.market.rates).toEqual([]);
      expect(r.sentences).toEqual(['No value: the home needs a property type and a size.']);
    }
  });

  it('E601 R-MLS-7: in a large market where half the sales have no size, price per sq ft and the size rate are fitted on sized sales only', () => {
    const all = linearMarket({ n: 400, seed: 21, trendCentsPerMonth: 30, noise: 0.02 });
    const candidates = all.map((c, i) => (i % 2 === 0 ? c : { ref: c.ref, sale: { ...c.sale, sqft: null, sizeSource: null } }));
    const r = run({ candidates });
    expect(r.available).toBe(true);
    const sized = candidates.filter((c) => c.sale.sqft !== null).length;
    expect(r.market.poolSales).toBeGreaterThan(0);
    expect(r.market.poolSales).toBeLessThanOrEqual(sized);
    for (const c of r.comps) expect(c.sale.sqft).not.toBeNull();
    expect(r.sentences.some((s) => /closed sales of this kind of home were not used: size not available from the MLS/.test(s))).toBe(true);
  });
});
