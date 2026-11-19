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
  type ScoreFeedOptions,
  renderFeedItem,
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
  withdrawnUntouched,
  overduePromise,
  failedSend,
  missingOutcome,
  milestoneAtRisk,
  statusReasonWords,
  EXCEPTION_RULE_VERSION,
  MILESTONE_UNASSIGNED_WINDOW_MS,
  MILESTONE_DATE_NAME,
  DEFAULT_EXCEPTION_SETTINGS,
  exceptionFingerprint,
  type DerivedException,
} from './exceptions.js';
export { speedToLeadSummary, countTouches, momentum, MOMENTUM_FACTOR, MOMENTUM_MIN_SAMPLE } from './scoreboard.js';
export { formatDuration, FOREIGN_CARD_LABEL, renderFeedLabel } from './format.js';
export { feedGroupOfItem, contactGroup, taskGroup, appointmentGroup, dealDateGroup, splitFeedInputs, nextFeedChange } from './incremental.js';
export {
  FOLLOW_UP_ITEM_TYPES,
  ALSO_DUE_NAMED,
  FOLLOW_UP_TODAY_CAP,
  WARM_FOLLOW_UP_DAYS,
  followUpActions,
  followUpTodayReasons,
  optedOutOfEveryChannel,
  planFollowUpToday,
  startOfTomorrow,
  type FollowUpPersonFacts,
  type FollowUpTodayEntry,
  isFollowUpItemType,
  LOGGED_AHEAD_MS,
  NO_CONVERSATION_YET,
  SNIPPET_MAX,
  classifyCandidate,
  isContactCandidate,
  quietStory,
  selectLastAttempt,
  warmReason,
  TOUCH_SLACK_MS,
  type LastAttempt,
  type QuietBasis,
  type QuietStory,
  selectLastContact,
  selectNextPromise,
  promiseDeadline,
  snippetOf,
  type CandidateClass,
  type ContactCandidate,
  type LastAutomatic,
  type LastContact,
  type LastTouch,
  type LastTouchKind,
  type NextPromise,
  type PromiseTask,
} from './followUp.js';
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
