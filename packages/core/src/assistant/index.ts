// @realty/core/assistant — public interface of BUILD_PLAN module 4: evidence refs and verbatim
// quote checks, claims normalization (with relative-date resolution), the autonomy policy, the
// content guard, playbook steps (schema, validation, hash, step logic, first response), rendering,
// saved-search criteria and matching, and prompt building. Pure: no I/O, no clock, no randomness.
// Other modules import only from here.
export * from './types.js';
export * from './evidence.js';
export * from './dates.js';
export * from './claims.js';
export * from './guard.js';
export * from './autonomy.js';
export * from './playbook.js';
export * from './content.js';
export * from './render.js';
export * from './search.js';
export * from './prompt.js';
export * from './output.js';
