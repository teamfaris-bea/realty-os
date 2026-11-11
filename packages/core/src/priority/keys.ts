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
  ListingId,
  MessageId,
  SavedSearchId,
  TaskId,
  UserId,
} from '../foundation/index.js';
import { firstTouchFeedKey, offerFeedKey } from '../ownership/index.js';
import type { ForeignFeedItemType } from './types.js';

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

// ---- foreign key families (Phase 2/3 cards; PHASE2_3_PLAN §5.3, module 18a) ---------------------------
//
// The extension point: a module adds a card by writing ONE priority_feed_items row under its own key
// family (below), with its item_type, reasons (≥ 1) and band. The scorer never produces these keys, so a
// refresh never updates or closes them (api/workspace feed.ts `isManagedKey`); the owning module closes
// its card (resolved_at) when its subject is handled. The feed API reads the ids back from the key to
// build the card's one-tap action (`parseForeignFeedKey`).
//
// A key part is an id (uuid) or a short code with no `:` (a period, an ISO week, a local date, a model
// version such as `predict/1.0`).

const PART = /^[^:\s]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function part(p: string, what: string): string {
  if (!PART.test(p)) throw new RangeError(`feed key part ${what} must be 1..80 characters with no ':' or space`);
  return p;
}

/** `seller_update:{listing}:{period}` (module 28: the weekly seller update of one listing). */
export function sellerUpdateFeedKey(listingId: ListingId, period: string): string {
  return `seller_update:${listingId}:${part(period, 'period')}`;
}

/** `marketing:{piece}` (module 29: a marketing piece version waiting for the agent's review). */
export function marketingFeedKey(pieceId: string): string {
  return `marketing:${pieceId}`;
}

/** `weekly_plan:{user}:{week}` (module 33: the user's plan for one local week). */
export function weeklyPlanFeedKey(userId: UserId, week: string): string {
  return `weekly_plan:${userId}:${part(week, 'week')}`;
}

/** `coaching_fix:{user}:{date}` (module 36: the user's one fix for one local date). */
export function coachingFixFeedKey(userId: UserId, localDate: string): string {
  return `coaching_fix:${userId}:${part(localDate, 'date')}`;
}

/** `likely:{contact}:{model}` (module 50: a likely-to-move band of one contact under one model version). */
export function likelyFeedKey(contactId: ContactId, modelVersion: string): string {
  return `likely:${contactId}:${part(modelVersion, 'model')}`;
}

/** A foreign key read back into its ids (null: not one of the five families, or malformed). */
export type ForeignFeedKey =
  | { itemType: 'seller_update'; listingId: ListingId; period: string }
  | { itemType: 'marketing_review'; pieceId: string }
  | { itemType: 'weekly_plan'; userId: UserId; week: string }
  | { itemType: 'coaching_fix'; userId: UserId; date: string }
  | { itemType: 'likely_to_move'; contactId: ContactId; modelVersion: string };

/** The key prefix of each foreign card type. */
export const FOREIGN_KEY_PREFIX: Readonly<Record<ForeignFeedItemType, string>> = {
  seller_update: 'seller_update',
  marketing_review: 'marketing',
  weekly_plan: 'weekly_plan',
  coaching_fix: 'coaching_fix',
  likely_to_move: 'likely',
};

export function parseForeignFeedKey(key: string): ForeignFeedKey | null {
  const parts = key.split(':');
  const [prefix, a, b] = parts;
  if (a === undefined || !UUID.test(a)) return null;
  if (parts.length === 2 && prefix === 'marketing') return { itemType: 'marketing_review', pieceId: a };
  if (parts.length !== 3 || b === undefined || !PART.test(b)) return null;
  switch (prefix) {
    case 'seller_update':
      return { itemType: 'seller_update', listingId: a as ListingId, period: b };
    case 'weekly_plan':
      return { itemType: 'weekly_plan', userId: a as UserId, week: b };
    case 'coaching_fix':
      return { itemType: 'coaching_fix', userId: a as UserId, date: b };
    case 'likely':
      return { itemType: 'likely_to_move', contactId: a as ContactId, modelVersion: b };
    default:
      return null;
  }
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

/** R-ACC-6: per occurrence of a confirmed date; moving the date bumps due_version, so it is a new key. */
export function milestoneKey(dealDateId: DealDateId, dueVersion: number): string {
  return `milestone:${dealDateId}:${dueVersion}`;
}
