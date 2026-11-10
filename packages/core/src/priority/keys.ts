// Dedupe keys for priority_feed_items (one open item per (user, dedupe_key)) and exception_items
// (per occurrence, R-ACC-1). Feed keys of the ownership-driven items are the ones core/ownership
// writes in its upsertFeed / resolveFeed effects, so a refresh re-scores the same row instead of
// opening a duplicate.
import type {
  AppointmentId,
  AssistantActionId,
  ContactId,
  DealDateId,
  Instant,
  LeadInquiryId,
  MessageId,
  SavedSearchId,
  TaskId,
} from '../foundation/index.js';
import { firstTouchFeedKey, offerFeedKey } from '../ownership/index.js';

export { firstTouchFeedKey, offerFeedKey };

// ---- feed --------------------------------------------------------------------------------------

/** Same key core/ownership uses for the `reinquiry` feed effect. */
export function reinquiryFeedKey(contactId: ContactId, inquiryId: LeadInquiryId | string): string {
  return `reinquiry:${contactId}:${inquiryId}`;
}

/** Same key core/ownership uses for the `inactivity_warning` feed effect (fence = warn instant). */
export function inactivityFeedKey(contactId: ContactId, periodSeq: number, warnAt: Instant): string {
  return `inactivity:${contactId}:${periodSeq}:${warnAt}`;
}

/** One card per contact waiting on a reply, keyed by the latest unanswered message or missed call. */
export function inboundFeedKey(contactId: ContactId, latestId: string): string {
  return `inbound:${contactId}:${latestId}`;
}

export function handbackFeedKey(actionId: AssistantActionId): string {
  return `handback:${actionId}`;
}

export function draftFeedKey(actionId: AssistantActionId): string {
  return `draft:${actionId}`;
}

export function taskFeedKey(taskId: TaskId): string {
  return `task:${taskId}`;
}

export function dealDateFeedKey(dealDateId: DealDateId): string {
  return `deal_date:${dealDateId}`;
}

export function apptOutcomeFeedKey(appointmentId: AppointmentId): string {
  return `appt_outcome:${appointmentId}`;
}

export function pondFeedKey(contactId: ContactId, enteredSeq: number): string {
  return `pond_new:${contactId}:${enteredSeq}`;
}

export function searchFeedKey(savedSearchId: SavedSearchId): string {
  return `saved_search:${savedSearchId}`;
}

// ---- exceptions (R-ACC-1: per occurrence) --------------------------------------------------------

export function untouchedKey(contactId: ContactId, periodSeq: number): string {
  return `untouched:${contactId}:${periodSeq}`;
}

export function promiseKey(taskId: TaskId): string {
  return `promise:${taskId}`;
}

export function sendKey(messageId: MessageId): string {
  return `send:${messageId}`;
}

export function apptKey(appointmentId: AppointmentId): string {
  return `appt:${appointmentId}`;
}
