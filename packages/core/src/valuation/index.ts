// @realty/core/valuation — public interface of PHASE2_3_PLAN module 70 (D9): the in-house comparable-
// sales valuation engine. Values come from the team's own MLS sold data, never a third-party AVM; an
// estimate, never an appraisal. Inputs are strict property, transaction, time and location facts only
// (R-CMA-2); the comps, adjustments, tier reads and an out-of-sample back-test are the evidence (R-CMA-4).
// Pure: no I/O, no clock, no randomness. Other modules import only from here.
export * from './types.js';
export { prepareCma } from './prepare.js';
export { addMonths, distanceM, monthIndex, postalKey, subdivisionKey } from './select.js';
export { money, percent, miles } from './text.js';
