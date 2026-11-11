// @realty/core/nurture — public interface of PHASE2_3_PLAN module 25: trigger detection (facts
// only), digest, send-time fact recheck and run plan, home anniversaries and AVM sendability. The
// playbook content union (`PlaybookContent`, `TriggerStepSchema`, `inbound_channel`) and the
// fair-housing downgrade in the content guard live in core/assistant, which module 25 owns in Phase 2.
// Pure: no I/O, no clock, no randomness.
export * from './types.js';
export * from './detect.js';
export * from './anniversary.js';
export * from './avm.js';
