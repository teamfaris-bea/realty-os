// @realty/core/ownership — public interface of BUILD_PLAN module 3: the deterministic lead
// ownership engine (decide / fold), routing, eligibility, timers, merge and dedup. Other modules
// import only from here, never from the files below.
export * from './types.js';
export { checkShape } from './invariants.js';
export { OwnershipFoldError, applyEvent, fold, foldFrom, startsPeriod, diffProjection, type ProjectionDiff } from './fold.js';
export { ROUTABLE_ROLES, skipReason, isEligible, pondAllows, claimBlock, canReceiveLead } from './eligibility.js';
export {
  routingMatchSchema,
  type RoutingMatchJson,
  parseRoutingMatch,
  normalizeZip,
  ruleMatches,
  matchRule,
  selectCandidate,
  type Selection,
  offeredInCurrentSequence,
} from './routing.js';
export {
  offerExpiresAt,
  firstTouchDeadlines,
  inactivityDeadlines,
  inactivityApplies,
  offerTimerKey,
  breachTimerKey,
  releaseTimerKey,
  inactivityTimerKey,
  periodTimerKeys,
} from './timers.js';
export {
  type MergeOwnerRule,
  type MergeOwnership,
  mergeOwnership,
  preselectMergeOwner,
  mergeLockOrder,
  resolveMergeRedirect,
  MERGE_REDIRECT_MAX_DEPTH,
} from './merge.js';
export {
  FUZZY_NAME_THRESHOLD,
  FINGERPRINT_WINDOW_MS,
  type NormalizedPerson,
  type ExistingMatch,
  type DuplicateReason,
  type DuplicateSuggestion,
  type DedupOutcome,
  addressLockOrder,
  matchContacts,
  duplicatePair,
  inquiryFingerprint,
  type InquiryKey,
  inquiryDuplicate,
} from './dedup.js';
export {
  OwnershipContextError,
  ledgerActor,
  offerFeedKey,
  firstTouchFeedKey,
  decide,
  decideMerge,
  type MergeDecision,
  deactivationCommandId,
  effectPlacement,
  placeEffects,
} from './decide.js';
