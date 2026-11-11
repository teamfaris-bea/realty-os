// @realty/core/parity/tags: PARITY_PLAN module 59 (tags). Tag name normalizer, opt-out look-alike
// detection (R-PAR-7) and the fair-housing protected-proxy classification (R-PAR-8). Pure.
export * from './normalize.js';
export { classifyProtected, protectedMatch, DEFAULT_PROTECTED_LEXICON, PARITY_PROXY_LEXICON_VERSION, type ProtectedLexicon, type ProtectedMatch } from './protected.js';
export { foldText, foldWords } from './fold.js';
