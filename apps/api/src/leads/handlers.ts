// Job handlers of api/leads (BUILD_PLAN module 11), registered through worker/handlers/index.ts.
//
// timerHandlers: the ownership timers of the timer catalog (ARCHITECTURE §6). Each one re-reads the
// projection under the contact lock (inside applyOwnershipCommandInTx) and applies the `timer`
// command with the job's fence, as the system actor via 'timer':
//   ownership.offer_expiry        fence offer_id                         offer_expired, next offer / pond
//   ownership.first_touch_breach  fence ownership_period_seq + due        first_touch_breached (+ notify owner, TL)
//   ownership.auto_release        fence ownership_period_seq + due        auto_released → default pond
//   ownership.inactivity          fence ownership_period_seq + stored at  inactivity_warned / inactivity_released
// and leads.backup_alert (leads/backupAlert.ts): the minute-three backup alert of a covered source's inquiry.
// and leads.release_recheck (leads/releaseRecheck.ts): a waived auto-release is re-evaluated when coverage or a member's status changes.
// The command id is derived from the fence, so a duplicate delivery (or the sweeper's re-issue)
// replays the stored outcome (R-OWN-7, E6); a stale fence is a no-op; an early wake makes core
// enqueue the same timer again at the stored deadline under an `:early:` key (R-OWN-15). Payload schemas, kinds, queues and dedupe keys are
// the sweeper contract's (worker/contracts.ts), so a sweeper re-issue of a live job is a no-op.
import type { ContactId, Instant } from '@realty/core/foundation';
import type { OwnershipCommand, TimerFence } from '@realty/core/ownership';
import { applyOwnershipCommandInTx, derivedCommandId } from '@realty/db';
import { TIMER_KIND_OF, TimerPayload } from '../worker/contracts.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { backupAlertHandler } from './backupAlert.js';
import { deactivationHandler } from './deactivation.js';
import { releaseRecheckHandler } from './releaseRecheck.js';

export type { TimerPayload };

export function timerCommandId(p: TimerPayload): string {
  return derivedCommandId('ownership.timer', p.contactId, p.deadline, 'offerId' in p ? p.offerId : `${p.periodSeq}:${p.dueAt}`);
}

function timerHandler(kind: TxJobHandler<TimerPayload>['kind']): TxJobHandler<TimerPayload> {
  return {
    kind,
    queue: 'realtime',
    via: 'timer',
    priority: 10,
    schema: TimerPayload,
    async run(ctx, p) {
      const fence: TimerFence = 'offerId' in p ? { offerId: p.offerId } : { periodSeq: p.periodSeq, dueAt: p.dueAt as Instant };
      const cmd: OwnershipCommand = { kind: 'timer', deadline: p.deadline, fence };
      await applyOwnershipCommandInTx(ctx.tx, ctx.actor, p.contactId as ContactId, cmd, { commandId: timerCommandId(p) });
    },
  };
}

/** BUILD_PLAN interface: offer_expiry, first_touch_breach, auto_release, inactivity. */
export const timerHandlers: TxJobHandler<TimerPayload>[] = [...new Set(Object.values(TIMER_KIND_OF))].map((k) => timerHandler(k));

/** Everything api/leads registers with the worker (CONVENTIONS §3). */
export const leadsHandlers: JobHandler<unknown>[] = [
  ...(timerHandlers as JobHandler<unknown>[]),
  deactivationHandler() as unknown as JobHandler<unknown>,
  // b19 R-TEAMQ-14: the minute-three backup alert of a covered source's inquiry (alerts only)
  backupAlertHandler() as unknown as JobHandler<unknown>,
  // b19 R-TEAMQ-20: a waived auto-release comes back when its source stops being covered or its owner stops being active
  releaseRecheckHandler() as unknown as JobHandler<unknown>,
];
