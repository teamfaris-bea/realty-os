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
export {
  TEAM_QUEUE_GROUPS,
  type TeamQueueGroupKey,
  TEAM_QUEUE_NEW_LEAD_WINDOW_MS,
  TEAM_QUEUE_REPLY_WINDOW_MS,
  TEAM_QUEUE_TASK_WINDOW_MS,
  TEAM_QUEUE_APPOINTMENT_WINDOW_MS,
  TEAM_QUEUE_GROUP_CAP,
  TEAM_QUEUE_GROUP_WORDS,
  type QueueHolder,
  type QueueMember,
  type ArrivalMeasure,
  type QueueInquiryFacts,
  type QueueInboundFacts,
  type QueueTaskFacts,
  type QueueApptFacts,
  type TeamQueueInputs,
  type TeamQueueRow,
  type TeamQueueGroup,
  type TeamQueue,
  queueHolder,
  holderLabel,
  measureFromArrival,
  buildTeamQueue,
} from './teamQueue.js';
export {
  RESPONSE_WITHIN_SECONDS,
  RESPONSE_MEDIAN_MIN_SAMPLE,
  RESPONSE_P90_MIN_SAMPLE,
  RESPONSE_NOT_WITHIN_CAP,
  type AttemptRole,
  type AttemptKind,
  type ResponseInquiryFacts,
  type MeasuredInquiry,
  type ResponseRollup,
  type SourceResponseRollup,
  measureInquiry,
  rollUpResponses,
} from './leadResponse.js';
export { arrivalInstant } from './arrival.js';
export {
  BACKUP_ALERT_AFTER_SECONDS,
  BACKUP_GRANT_MS,
  ALERT_TITLE_MAX,
  ALERT_BODY_MAX,
  type AlertHolder,
  type AlertRecipient,
  type AlertFallbackReason,
  type BackupAlertFacts,
  backupAlertDueAt,
  backupAlertRecipients,
  backupAlertText,
  shortMemberName,
} from './backupAlert.js';
export { feedGroupOfItem, contactGroup, taskGroup, appointmentGroup, dealDateGroup, splitFeedInputs, nextFeedChange } from './incremental.js';
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
