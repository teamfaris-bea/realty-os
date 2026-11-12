// @realty/core/compliance — public interface of BUILD_PLAN module 2: the canContact gate, policy
// layering, the consent fold, inbound keywords/opt-out language, recording consent, sender
// identity and content rules. Other modules import only from here.
export * from './types.js';
export * from './policy.js';
export * from './consent.js';
export * from './inbound.js';
export * from './reactions.js';
export * from './recording.js';
export * from './sender.js';
export * from './content.js';
export * from './reasons.js';
export { canonicalize, canonicalJson, sha256Hex } from './digest.js';
export {
  RULES_VERSION,
  KEYWORD_REPLY_CHANNELS,
  type GateConnectionStatus,
  type GateInput,
  type GateDecision,
  type GateOutcome,
  canContact,
  gateInputsRecord,
  optedOut,
} from './gate.js';
export * from './fanout.js';

/** Codes core/compliance can return as `{ ok: false, code }` (CONVENTIONS §7). */
export type ComplianceErrorCode =
  | 'PACK_INVALID'
  | 'CONSENT_EVENT_NOT_FOUND'
  | 'NOT_AN_OPT_OUT_LANGUAGE_REVOKE'
  | 'ALREADY_REVIEWED';
export * from './reachability.js';
