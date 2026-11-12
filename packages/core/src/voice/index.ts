// @realty/core/voice — public interface of PHASE2_3_PLAN module 47: whether the assistant answers a
// call (shouldAnswer), its tool decisions against the DB's closed set (decideToolCall), the hot-lead
// rule (isHot), the transfer target (transferTarget), the turn guard (voiceTurnGuard) and the policy
// state machine (startSession / step). Pure: no I/O, no clock, no randomness; instants are injected.
// Inbound answering only, dark until platform:voice is cleared and the Owner turns it on (D7); AI
// outbound never (R-GATE-9). Module 48 (api/voice) imports only from here.
export * from './types.js';
export * from './lines.js';
export * from './lexicon.js';
export * from './guard.js';
export * from './answer.js';
export * from './hot.js';
export * from './transfer.js';
export * from './tools.js';
export * from './optouts.js';
export type { HeardOptOut, LedgerEntry, NeedsReviewItem, VoicePhase, VoiceState, Waiting } from './state.js';
export * from './machine.js';
