// Shared vocabulary of api/transactions (PHASE2_3_PLAN §5.4 #31; R-TXN-1..6, R-OWN-27).
//
// Module 31 is the only writer of deal dates (the Phase 1 deal-screen routes call it too). It reaches clients
// only through module 26: a confirmed date's stored reminder becomes `deal_date_upcoming` firings of the approved
// team `transaction_updates` playbook, which executeTriggerRun composes and queueOutboundInTx hands to
// comms/dispatch.ts (D1 opt-outs at send time). Nothing in this module sends anything itself.
import type { MilestoneKind } from '@realty/core/transactions';

/** Job kinds of api/transactions (registered in worker/handlers/index.ts, one line). */
export const TRANSACTION_JOBS = {
  /** per tenant, every 5 min: repairs missing instants and turns due reminders into firings (R-OWN-27) */
  reconcile: 'milestones.reconcile',
  /** a person moved, completed or waived a date: skips its stale firings and cancels their queued messages */
  dateChanged: 'milestones.date_changed',
} as const;

export const MILESTONES_RECONCILE_EVERY_MS = 5 * 60_000;
/** Dates repaired and reminders read per reconcile pass (bounded work; the next pass picks up the rest). */
export const RECONCILE_LIMIT = 200;

/** The one playbook that sends deal-date updates (R-TXN-4): built-in template key and scope. */
export const TRANSACTION_UPDATES = { templateKey: 'transaction_updates', scope: 'team' } as const;

/** How a date reads when it has no label (the update's {{document_name}} slot). */
export const KIND_TEXT: Readonly<Record<MilestoneKind, string>> = {
  acceptance: 'The acceptance date',
  inspection: 'The inspection deadline',
  appraisal: 'The appraisal date',
  financing: 'The financing deadline',
  closing: 'The closing date',
  possession: 'The possession date',
  custom: 'A milestone',
};

/**
 * The business-day calendar every plan uses until counsel (C9) and the owner decide on tenant holiday lists
 * (finding 10): Monday to Friday, no holidays, unreviewed. Shown in each proposal's basis.
 * VERIFY WITH COUNSEL (C9): which weekdays count, which holidays exist, day 1 after the anchor.
 */
export const DEFAULT_CALENDAR_NOTE = 'Business days: Monday to Friday; holidays are not counted. Not reviewed by counsel.';
export const DEFAULT_CALENDAR_SOURCE = 'default (Monday to Friday)';
