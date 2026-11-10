// @realty/core/priority — public interface of BUILD_PLAN module 5: Priority Feed ranking with
// reasons and one-tap actions, Team Lead exception derivation, scoreboard and momentum summaries.
// Pure: no I/O, no clock, no randomness. Other modules import only from here.
export * from './types.js';
export * from './keys.js';
export {
  SCORE_VERSION,
  FEED_REASONS,
  FEED_REASON_CODES,
  type FeedReasonCode,
  isFeedReasonCode,
  reasonFromCode,
  scoreOf,
} from './reasons.js';
export {
  scoreFeed,
  compareFeedItems,
  splitBands,
  isHumanTouch,
  answersClient,
  taskDeadline,
  dealDateWindow,
  awaitsOutcome,
  TASK_LOOKAHEAD_MS,
  DEAL_DATE_LOOKAHEAD_MS,
  POND_NEW_WINDOW_MS,
  OUTCOME_LATE_MS,
} from './feed.js';
export {
  deriveExceptions,
  untouchedLead,
  overduePromise,
  failedSend,
  missingOutcome,
  EXCEPTION_RULE_VERSION,
  DEFAULT_EXCEPTION_SETTINGS,
  exceptionFingerprint,
  type DerivedException,
} from './exceptions.js';
export { speedToLeadSummary, countTouches, momentum, MOMENTUM_FACTOR, MOMENTUM_MIN_SAMPLE } from './scoreboard.js';
export { formatDuration } from './format.js';
export {
  FeedItemSchema,
  FeedReasonSchema,
  OneTapActionSchema,
  ExceptionItemSpecSchema,
  ExceptionEvidenceSchema,
  SpeedToLeadSummarySchema,
} from './schemas.js';

/** Codes core/priority can return as `{ ok: false, code }` (none today: every function is total). */
export type PriorityErrorCode = never;
