// R-MLS-7 (the engine part) and R-CMA-2/3: a sale or subject whose size is unknown (the MLS has not confirmed a
// finished-living-area field, so the sync stores none) gets no size similarity, no size adjustment and no price per
// sq ft: the sale is not a comp and says why, the subject is not valued without a size, and the result says how many
// sales were left out for it. Never a crash, never a size taken from somewhere else. E641.
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

describe('E641 R-MLS-7: unknown sizes are skipped, never invented, and said', () => {
  it('E641 R-MLS-7 R-CMA-2: when no sale of this kind has a size there is no value, and the result says the sales were found but have no size from the MLS', () => {
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

  it('E641 R-MLS-7 R-CMA-3: with sized and unsized sales, only the sized ones are comps; every size adjustment has both sizes; the unsized ones are listed and counted', () => {
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

  it('E641 R-MLS-7: one unsized sale is worded in the singular; a size of 0 is no size (never "0 sq ft")', () => {
    const r = run({ candidates: [...sales('s', 5, true), cand('zero', { sqft: 0, sizeSource: 'LivingArea', closeDate: monthsBefore(1), latE6: SUBJECT_LAT + 500 })] });
    expect(r.notUsed.find((n) => n.ref.identity === 'zero')).toMatchObject({ reason: 'no_size', sentence: NOT_USED_NO_SIZE });
    expect(r.sentences).toContain('1 closed sale of this kind of home was not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for it.');
    expect(JSON.stringify(r)).not.toMatch(/\b0 sq ft/);
  });

  it('E641 R-MLS-7: fewer than 3 sized sales beside unsized ones: INSUFFICIENT_COMPS, and the unsized ones are said', () => {
    const r = run({ candidates: [...sales('s', 2, true), ...sales('u', 4, false)] });
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe('INSUFFICIENT_COMPS');
    expect(r.sentences).toEqual([
      'No value: 2 comparable sales were found, and at least 3 are needed.',
      '4 closed sales of this kind of home were not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for them.',
    ]);
  });

  it('E641 R-MLS-7: a subject without a size is not valued (no comps, no rates), and nothing throws', () => {
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

  it('E641 R-MLS-7: in a large market where half the sales have no size, price per sq ft and the size rate are fitted on sized sales only', () => {
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

describe('E647 R-MLS-7: "no sales with a size" is said only when no sale of this kind has a size', () => {
  const NO_SALES = 'No value: no closed sales of this kind of home were found.';
  const ONE_UNSIZED = '1 closed sale of this kind of home was not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for it.';
  const unsized = cand('u1', { sqft: null, sizeSource: null, closeDate: monthsBefore(1), contractDate: monthsBefore(2), latE6: SUBJECT_LAT + 500 });

  it('E647 R-MLS-7 R-CMA-2: sized sales that fail another rule (sale condition, another size measure, too old) beside an unsized one: the size is not blamed, each keeps its own reason, the unsized one is counted', () => {
    const shortSales = sales('s', 6, true).map((c) => ({ ...c, sale: { ...c.sale, saleConditions: ['short_sale' as const] } }));
    const otherMeasure = sales('o', 6, true).map((c) => ({ ...c, sale: { ...c.sale, sizeSource: 'AboveGradeFinishedArea' } }));
    const tooOld = sales('t', 6, true).map((c, i) => ({ ...c, sale: { ...c.sale, closeDate: monthsBefore(26 + i), contractDate: monthsBefore(27 + i) } }));
    for (const [label, sized, reason] of [['short sales', shortSales, 'sale_condition'], ['another measure', otherMeasure, 'other_size_source'], ['too old', tooOld, 'too_old']] as const) {
      const r = run({ candidates: [...sized, unsized] });
      expect([label, r.available, r.available ? null : r.reason]).toEqual([label, false, 'NO_SALES']);
      expect([label, r.sentences]).toEqual([label, [NO_SALES, ONE_UNSIZED]]);
      expect(r.notUsed.filter((n) => n.ref.identity !== 'u1').map((n) => n.reason)).toEqual(Array.from({ length: 6 }, () => reason));
    }
    // the short sales stay the agent's to add (the fix that is actually available), never hidden behind the size
    expect(run({ candidates: [...shortSales, unsized] }).notUsed.filter((n) => n.reason === 'sale_condition').every((n) => n.includable)).toBe(true);
  });

  it('E647 E641 R-MLS-7: only when every sale of this kind that got past the type check has no size is it worded "with a size from the MLS"', () => {
    expect(run({ candidates: [unsized, ...sales('n', 3, false)] }).sentences[0]).toBe('No value: no closed sales of this kind of home with a size from the MLS were found.');
    // a condo with a size is not a sale of this kind: the single-family sales still have none
    const condo = cand('condo', { propertyType: 'condo', closeDate: monthsBefore(1) });
    expect(run({ candidates: [unsized, condo] }).sentences[0]).toBe('No value: no closed sales of this kind of home with a size from the MLS were found.');
  });
});

describe('E648 R-MLS-7: the unsized-sales count names only sales the size kept out, each once', () => {
  const COUNT = /^(\d+) closed sales? of this kind of home (?:was|were) not used: size not available from the MLS/;
  const counted = (r: CmaResult): number => Number(r.sentences.map((s) => COUNT.exec(s)?.[1]).find((x) => x !== undefined) ?? 0);

  it('E648 R-MLS-7: an unsized sale closed before the extended look-back is too old whatever its size: listed, never counted', () => {
    const oldUnsized = cand('old-u', { sqft: null, sizeSource: null, closeDate: monthsBefore(28), contractDate: monthsBefore(29) });
    const oldSized = cand('old-s', { closeDate: monthsBefore(28), contractDate: monthsBefore(29) });
    const r = run({ candidates: [...sales('s', 5, true), oldUnsized, oldSized] });
    expect(r.available).toBe(true);
    expect(counted(r)).toBe(0);
    expect(r.sentences.some((s) => COUNT.test(s))).toBe(false);
    expect(r.notUsed.find((n) => n.ref.identity === 'old-s')?.reason).toBe('too_old');
    expect(r.notUsed.find((n) => n.ref.identity === 'old-u')?.reason).toBe('no_size');
    // with only old unsized sales of this kind, nothing is blamed on the size
    const only = run({ candidates: [oldUnsized] });
    expect(only.sentences).toEqual(['No value: no closed sales of this kind of home were found.']);
  });

  it('E648 R-MLS-7 R-MLS-5: one sale reaching the engine twice (the same address and close date) is counted once, and not at all when another copy has a size', () => {
    const key = '9 dup st|fairview|zz|99001';
    const d1 = cand('d1', { sqft: null, sizeSource: null, closeDate: monthsBefore(2), contractDate: monthsBefore(3), addressKey: key });
    const d2 = cand('d2', { sqft: null, sizeSource: null, closeDate: monthsBefore(2), contractDate: monthsBefore(3), addressKey: key });
    expect(counted(run({ candidates: [...sales('s', 5, true), d1, d2] }))).toBe(1);
    // the same sale as a sized team listing: that copy is the sale (a comp or listed with its own reason), so no unsized sale is counted
    const team = cand('team-copy', { closeDate: monthsBefore(2), contractDate: monthsBefore(3), addressKey: key }, { source: 'team', teamListingId: 'team-copy' });
    const r = run({ candidates: [...sales('s', 5, true), d1, team] });
    expect(counted(r)).toBe(0);
    // two different unsized sales are two
    const other = cand('d3', { sqft: null, sizeSource: null, closeDate: monthsBefore(4), contractDate: monthsBefore(5), addressKey: '11 other st|fairview|zz|99001' });
    expect(counted(run({ candidates: [...sales('s', 5, true), d1, d2, other] }))).toBe(2);
  });
});
