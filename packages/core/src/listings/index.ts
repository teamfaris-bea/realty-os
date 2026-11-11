// @realty/core/listings — public interface of PHASE2_3_PLAN module 23: MLS normalization (RESO →
// listing facts), the licence pack (strictest defaults), display rules per audience (R-MLS-2,
// R-MLS-4), competing sets and mirror de-duplication (R-MLS-5), and feed staleness (R-MLS-3).
// Pure: no I/O, no clock, no randomness; time comes in as `Instant`. Other modules import only from
// here. VERIFY WITH COUNSEL / MLS: every licence-pack value and display branch.
export * from './types.js';
export * from './licence.js';
export * from './normalize.js';
export * from './display.js';
export * from './competing.js';
export * from './staleness.js';
