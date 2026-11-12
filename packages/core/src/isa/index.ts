// @realty/core/isa — public interface of module 74 (the AI ISA core policy; D12 proposed, docs/AI_ISA.md §4–§7).
// Pure: no I/O, no clock, no randomness; instants and ids are injected. Core never sends, books or changes
// ownership: module 75 (apps/api/src/isa) carries out the machine's actions through dispatchOutbound, the booking
// job and the assignment transactions, where canContact (checks 0, 8, 12) and the DB guard decide again.
// No import from apps/**, mailSync or core/predict (architecture test). VERIFY WITH COUNSEL every default.
export * from './constants.js';
export * from './types.js';
export * from './lines.js';
export * from './ownText.js';
export * from './signals.js';
export * from './readiness.js';
export * from './slots.js';
export * from './consent.js';
export * from './areaCodes.js';
export * from './stateZones.js';
export * from './zones.js';
export * from './sendPolicy.js';
export * from './guard.js';
export * from './output.js';
export * from './content.js';
export * from './facts.js';
export * from './market.js';
export * from './prompt.js';
export * from './machine.js';
