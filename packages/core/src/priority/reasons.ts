// The Priority Feed reason catalog (SCORE_VERSION 1). Each reason has a fixed share of the score
// (`points`; null = informational) and a default label. scoreFeed renders a more specific label
// with relative times ("First contact due in 12 min"); the default label is what the API shows
// for reason codes written by other modules (core/ownership feed effects carry bare codes).
//
// Changing any points value or adding a scored code requires bumping SCORE_VERSION.
import type { FeedReason } from './types.js';

export const SCORE_VERSION = 1;

export const FEED_REASONS = {
  // pinned: ownership deadlines
  LEAD_OFFER: { points: 90, label: 'New lead offered to you' },
  OFFER_ENDS: { points: null, label: 'The offer ends soon' },
  LEAD_SOURCE: { points: null, label: 'Lead source' },
  FIRST_TOUCH_DUE: { points: 85, label: 'First contact is due' },
  FIRST_TOUCH_OVERDUE: { points: 95, label: 'First contact is overdue' },
  RELEASE_SOON: { points: null, label: 'Goes back to the pond if not contacted' },
  REINQUIRY: { points: 70, label: 'Asked again' },
  ASKED_AGAIN: { points: null, label: 'Asked again' },
  INACTIVITY_WARNING: { points: 60, label: 'No contact in a while' },
  // clients waiting on a person
  HANDBACK: { points: 60, label: 'Replied to the assistant; follow-ups paused' },
  MISSED_CALL: { points: 55, label: 'Missed call' },
  CLIENT_WAITING: { points: 50, label: 'Waiting for your reply' },
  MORE_WAITING: { points: null, label: 'Several messages waiting' },
  WAITING_OVER_1H: { points: 10, label: 'Waiting over 1 h' },
  WAITING_OVER_4H: { points: 20, label: 'Waiting over 4 h' },
  // assistant work for review
  DRAFT_READY: { points: 35, label: 'Draft ready for you' },
  ASSISTANT_NOTE: { points: null, label: "The assistant's note" },
  REPLY_DRAFTED: { points: null, label: 'Reply drafted for you' },
  CHECK_THIS: { points: null, label: 'Check this' },
  SEARCH_PROPOSED: { points: 25, label: 'Saved search ready to review' },
  CRITERIA_UNCHECKED: { points: null, label: 'Some criteria need your check' },
  // tasks, promises, deals, appointments
  PROMISE_OVERDUE: { points: 55, label: 'You promised this; overdue' },
  PROMISE_DUE: { points: 40, label: 'You promised this' },
  PROMISE_NEEDS_DATE: { points: 25, label: "Promise needs a date: the assistant wasn't sure when" },
  PROMISE_SOURCE: { points: null, label: 'Where it was promised' },
  TASK_OVERDUE: { points: 40, label: 'Overdue' },
  TASK_DUE: { points: 30, label: 'Due soon' },
  DUE_WITHIN_HOUR: { points: 10, label: 'Due within the hour' },
  OVERDUE_OVER_DAY: { points: 10, label: 'Overdue more than a day' },
  DEAL_DATE_PASSED: { points: 50, label: 'Contract date passed' },
  DEAL_DATE_TODAY: { points: 40, label: 'Contract date is today' },
  DEAL_DATE_SOON: { points: 30, label: 'Contract date coming up' },
  OUTCOME_MISSING: { points: 35, label: 'Log how the appointment went' },
  OUTCOME_OVER_2H: { points: 10, label: 'Ended over 2 h ago' },
  POND_NEW: { points: 20, label: 'New in the pond; first to claim gets it' },
  // gate demotion (never hides the item, R-GATE-1 still re-checks at send time)
  TEXT_BLOCKED: { points: -15, label: "Can't text right now" },
  CALL_BLOCKED: { points: -15, label: "Can't call right now" },
  EMAIL_BLOCKED: { points: -15, label: "Can't email right now" },
  CANT_CONTACT: { points: -30, label: "Can't reach them right now" },
} as const satisfies Record<string, { points: number | null; label: string }>;

export type FeedReasonCode = keyof typeof FEED_REASONS;
export const FEED_REASON_CODES = Object.keys(FEED_REASONS) as FeedReasonCode[];

export function isFeedReasonCode(code: string): code is FeedReasonCode {
  return Object.prototype.hasOwnProperty.call(FEED_REASONS, code);
}

/** A reason with the catalog's points and either a specific or the default label. */
export function reason(code: FeedReasonCode, label?: string): FeedReason {
  const def = FEED_REASONS[code];
  return def.points === null ? { code, label: label ?? def.label } : { code, label: label ?? def.label, points: def.points };
}

/**
 * Renders a bare reason code written by another module (e.g. core/ownership `['LEAD_OFFER']`).
 * Unknown codes get an honest generic label rather than the raw code.
 */
export function reasonFromCode(code: string): FeedReason {
  return isFeedReasonCode(code) ? reason(code) : { code, label: 'Needs your attention' };
}

/** The score of a reason list: the sum of its points, clamped to 0..100 (DB CHECK). */
export function scoreOf(reasons: readonly FeedReason[]): number {
  let s = 0;
  for (const r of reasons) s += r.points ?? 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
