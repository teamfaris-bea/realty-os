// Job kinds the SWEEPER issues (app.due_work branches → jobs), with their payload schemas, queues and
// dedupe keys. This is the contract between the sweeper (module 9) and the modules whose handlers run
// these kinds (api/leads: ownership timers; api/comms: dispatch and reconciliation; api/assistant:
// playbook steps; api/workspace: notification delivery). Domain code that enqueues the same kind for
// the same entity MUST use the same dedupe key, so a sweeper re-issue of a live job is a no-op.
//
// Ownership timer kinds, fences and dedupe keys are core's (core/ownership timers.ts): the sweeper
// rebuilds exactly the job the transition enqueued, from the STORED deadline (R-OWN-15).
import type { ContactId, Instant } from '@realty/core/foundation';
import { type TimerDeadline, breachTimerKey, inactivityTimerKey, offerTimerKey, releaseTimerKey } from '@realty/core/ownership';
import type { Queue } from '@realty/db';
import { z } from 'zod';
import { jobPayload, zId, zInstant, zSeq } from './payload.js';
import type { JobKind } from './types.js';

// ---- ownership timers (handlers: api/leads `timerHandlers`) -----------------------------------------

export const OfferTimerPayload = jobPayload({ contactId: zId, deadline: z.literal('offer_expiry'), offerId: zId });
export const PeriodTimerPayload = jobPayload({
  contactId: zId,
  deadline: z.enum(['first_touch_breach', 'auto_release', 'inactivity_warn', 'inactivity_release']),
  periodSeq: zSeq,
  dueAt: zInstant,
});
/** The payload of every ownership timer job (= core TimerJobFence). */
export const TimerPayload = z.union([OfferTimerPayload, PeriodTimerPayload]);
export type TimerPayload = z.infer<typeof TimerPayload>;

export const TIMER_KIND_OF: Record<TimerDeadline, 'ownership.offer_expiry' | 'ownership.first_touch_breach' | 'ownership.auto_release' | 'ownership.inactivity'> = {
  offer_expiry: 'ownership.offer_expiry',
  first_touch_breach: 'ownership.first_touch_breach',
  auto_release: 'ownership.auto_release',
  inactivity_warn: 'ownership.inactivity',
  inactivity_release: 'ownership.inactivity',
};

export function timerDedupeKey(p: TimerPayload): string {
  const c = p.contactId as ContactId;
  switch (p.deadline) {
    case 'offer_expiry':
      return offerTimerKey(c, p.offerId);
    case 'first_touch_breach':
      return breachTimerKey(c, p.periodSeq);
    case 'auto_release':
      return releaseTimerKey(c, p.periodSeq);
    case 'inactivity_warn':
      return inactivityTimerKey(c, 'warn', p.periodSeq, p.dueAt as Instant);
    case 'inactivity_release':
      return inactivityTimerKey(c, 'release', p.periodSeq, p.dueAt as Instant);
  }
}

// ---- entity jobs the sweeper re-issues (handlers: comms / assistant / workspace) -------------------

export const MessagePayload = jobPayload({ messageId: zId });
export type MessagePayload = z.infer<typeof MessagePayload>;
export const PlaybookStepPayload = jobPayload({ enrollmentId: zId, dueAt: zInstant });
export type PlaybookStepPayload = z.infer<typeof PlaybookStepPayload>;
export const DeliveryPayload = jobPayload({ deliveryId: zId });
export type DeliveryPayload = z.infer<typeof DeliveryPayload>;

export interface EntityJobContract<P> {
  kind: JobKind;
  queue: Queue;
  priority: number;
  schema: z.ZodType<P>;
  dedupeKey(p: P): string;
}

/** comms.dispatch: send a scheduled/queued message (dispatchOutbound, api/comms). */
export const COMMS_DISPATCH: EntityJobContract<MessagePayload> = {
  kind: 'comms.dispatch',
  queue: 'realtime',
  priority: 50,
  schema: MessagePayload,
  dedupeKey: (p) => `comms.dispatch:${p.messageId}`,
};

/** comms.dispatch_stale: sweeper only; `dispatching` past max lease + margin → dispatch_unknown (worker handler). */
export const COMMS_DISPATCH_STALE: EntityJobContract<MessagePayload> = {
  kind: 'comms.dispatch_stale',
  queue: 'realtime',
  priority: 60,
  schema: MessagePayload,
  dedupeKey: (p) => `comms.dispatch_stale:${p.messageId}`,
};

/** comms.reconcile: provider lookup by idempotency key of a dispatch_unknown message (R-GATE-8, api/comms). */
export const COMMS_RECONCILE: EntityJobContract<MessagePayload> = {
  kind: 'comms.reconcile',
  queue: 'realtime',
  priority: 60,
  schema: MessagePayload,
  dedupeKey: (p) => `comms.reconcile:${p.messageId}`,
};

/** playbook.step: build, authorize and gate one due enrollment step at send time (api/assistant). */
export const PLAYBOOK_STEP: EntityJobContract<PlaybookStepPayload> = {
  kind: 'playbook.step',
  queue: 'default',
  priority: 80,
  schema: PlaybookStepPayload,
  dedupeKey: (p) => `playbook.step:${p.enrollmentId}:${p.dueAt}`,
};

/** notify.deliver: one channel delivery attempt of a notification (api/workspace). */
export const NOTIFY_DELIVER: EntityJobContract<DeliveryPayload> = {
  kind: 'notify.deliver',
  queue: 'realtime',
  priority: 40,
  schema: DeliveryPayload,
  dedupeKey: (p) => `notify.deliver:${p.deliveryId}`,
};

/** Every kind the sweeper may enqueue, with its queue (a handler registering one must use this queue). */
export const SWEEPER_KIND_QUEUES: Readonly<Record<string, Queue>> = {
  'ownership.offer_expiry': 'realtime',
  'ownership.first_touch_breach': 'realtime',
  'ownership.auto_release': 'realtime',
  'ownership.inactivity': 'realtime',
  'ownership.followup': 'realtime',
  [COMMS_DISPATCH.kind]: COMMS_DISPATCH.queue,
  [COMMS_DISPATCH_STALE.kind]: COMMS_DISPATCH_STALE.queue,
  [COMMS_RECONCILE.kind]: COMMS_RECONCILE.queue,
  [PLAYBOOK_STEP.kind]: PLAYBOOK_STEP.queue,
  [NOTIFY_DELIVER.kind]: NOTIFY_DELIVER.queue,
};
