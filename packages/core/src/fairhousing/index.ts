// @realty/core/fairhousing — public interface of PHASE2_3_PLAN module 20: one lexicon pack used for
// the marketing copy check (R-FH-1), the assistant and voice guard (R-FH-2, R-FH-3) and the
// targeting validator (R-FH-4). The pack is data (R-FH-5) and ships unreviewed; its review state is
// the `platform:fair_housing` clearance pack (R-INT-6). Modules 25, 27, 29, 47 and 51 import only
// from here. Pure: no I/O, no clock, no randomness. VERIFY WITH COUNSEL (C3, C5).
export * from './types.js';
export { check, hasAnyMatch, compilePattern, FRAME_WINDOW } from './check.js';
export { DEFAULT_FAIR_HOUSING_PACK, FAIR_HOUSING_LEXICON_VERSION } from './lexicon.js';
export { fairHousingPackFrom, fairHousingReviewState, FairHousingRulesSchema, type FairHousingPackError } from './pack.js';
export * from './assistant.js';
export * from './targeting.js';
