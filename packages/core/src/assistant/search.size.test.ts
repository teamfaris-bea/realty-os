// R-MLS-7 (saved searches): while the MLS gives no size (Spark: no field is confirmed as finished living area), a size
// criterion can match only team listings, never an MLS listing. The assistant's size criteria are held for the agent's
// check, and the review says why in words, never silently. E611.
import { describe, expect, it } from 'vitest';
import { MLS_SIZE_NONE_SENTENCE, MLS_SIZE_SOME_SENTENCE, type SearchProposal, holdSizeCriteria, sizeCriterionNote } from './search.js';

const proposal = (): SearchProposal => ({
  criteria: { postalCodes: ['29401'], sqftMin: 1_500, sqftMax: 2_500, bedsMin: 3 },
  criterionEvidence: { postalCodes: 'c1', sqftMin: 'c2', sqftMax: 'c3', bedsMin: 'c4' },
  unchecked: ['priceMaxCents'],
  prefill: { priceMaxCents: 90_000_000 },
});

describe('E611 R-MLS-7: a size criterion while the MLS gives no size', () => {
  it('E611 R-MLS-7 R-AST-5: the assistant\'s size criteria are held: prefilled and unchecked (used only if the agent checks them), evidence kept, the rest untouched', () => {
    const p = holdSizeCriteria(proposal());
    expect(p.criteria).toEqual({ postalCodes: ['29401'], bedsMin: 3 });
    expect(p.prefill).toEqual({ priceMaxCents: 90_000_000, sqftMin: 1_500, sqftMax: 2_500 });
    expect(p.unchecked).toEqual(['priceMaxCents', 'sqftMin', 'sqftMax']);
    expect(p.criterionEvidence).toEqual(proposal().criterionEvidence);
    // nothing to hold: the same proposal
    const none: SearchProposal = { criteria: { bedsMin: 3 }, criterionEvidence: {}, unchecked: [], prefill: {} };
    expect(holdSizeCriteria(none)).toEqual(none);
    // an already unchecked size criterion stays once
    const held: SearchProposal = { criteria: { bedsMin: 3 }, criterionEvidence: {}, unchecked: ['sqftMin'], prefill: { sqftMin: 1_200 } };
    expect(holdSizeCriteria(held)).toEqual(held);
  });

  it('E611 R-MLS-7: the review says why a size criterion matches no MLS listing, only when the search has one and the MLS lacks sizes', () => {
    expect(MLS_SIZE_NONE_SENTENCE).toBe('Size not available from the MLS: a size criterion matches only team listings, never an MLS listing.');
    expect(MLS_SIZE_SOME_SENTENCE).toBe('Size not available from the MLS for some listings: a size criterion never matches an MLS listing without one.');
    expect(sizeCriterionNote({ sqftMin: 1_500 }, {}, 'none')).toBe(MLS_SIZE_NONE_SENTENCE);
    expect(sizeCriterionNote({}, { sqftMax: 2_000 }, 'none')).toBe(MLS_SIZE_NONE_SENTENCE); // prefilled (unchecked) counts
    expect(sizeCriterionNote({ sqftMin: 1_500 }, {}, 'some')).toBe(MLS_SIZE_SOME_SENTENCE);
    expect(sizeCriterionNote({ sqftMin: 1_500 }, {}, 'all')).toBeNull();
    expect(sizeCriterionNote({ sqftMin: 1_500 }, {}, null)).toBeNull(); // no MLS listing could match anyway
    expect(sizeCriterionNote({ bedsMin: 3 }, { priceMaxCents: 1 }, 'none')).toBeNull(); // no size criterion
  });
});
