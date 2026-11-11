// What a bulk send item becomes after dispatchOutbound (PARITY_PLAN module 62; R-PAR-34, R-PAR-36,
// R-PAR-41, E184, E188).
//
// A processed item is final (DB). So the mapping must never mark an item done before the message has
// left our hands, and never leave a sent message's item pending (a retry would then look for a second
// send; the message idempotency key prevents it, but the counts would lie).
import { type ItemStatus } from './summary.js';
import { type SkipReason, skipForGateReasons } from './preflight.js';

/** The outcome kinds of dispatchOutbound (apps/api/src/comms/types.ts DispatchResult), by name only. */
export type DispatchOutcome =
  | { kind: 'sent' }
  | { kind: 'dispatch_unknown' }
  | { kind: 'failed'; reason: string }
  | { kind: 'blocked'; reasons: readonly string[] }
  | { kind: 'needs_retap' }
  | { kind: 'not_due' }
  | { kind: 'noop'; status: string };

export type ItemOutcome =
  | { status: Exclude<ItemStatus, 'pending'>; reasonCode: string | null; cancelMessage?: true }
  | { status: 'pending'; reasonCode: null };

const FAILED_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * - sent / dispatch_unknown: done (dispatch_unknown is reconciled by comms, never re-sent)
 * - blocked: blocked, with the opt-out reason first (E184)
 * - failed: failed with the provider reason
 * - needs_retap: the person replied between queue and dispatch: canceled CLIENT_REPLIED, and the waiting
 *   message is canceled too (a bulk message is never sent later on its own)
 * - noop: the message already moved on in an earlier attempt (a replay after a crash, E188): its status
 *   decides; 'dispatching' stays pending so the stale-dispatch sweeper resolves the message first
 */
export function itemOutcomeForDispatch(r: DispatchOutcome): ItemOutcome {
  switch (r.kind) {
    case 'sent':
    case 'dispatch_unknown':
      return { status: 'done', reasonCode: null };
    case 'blocked':
      return { status: 'blocked', reasonCode: skipForGateReasons(r.reasons) satisfies SkipReason };
    case 'failed':
      return { status: 'failed', reasonCode: FAILED_CODE_RE.test(r.reason) ? r.reason : 'SEND_FAILED' };
    case 'needs_retap':
    case 'not_due':
      return { status: 'canceled', reasonCode: 'CLIENT_REPLIED', cancelMessage: true };
    case 'noop':
      return itemOutcomeForMessageStatus(r.status);
  }
}

/** The item outcome for a bulk message already past TX1 (replay): by the message's own status. */
export function itemOutcomeForMessageStatus(status: string): ItemOutcome {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'dispatch_unknown':
    case 'undelivered':
      return { status: 'done', reasonCode: null };
    case 'blocked':
      return { status: 'blocked', reasonCode: 'SEND_BLOCKED' };
    case 'failed':
      return { status: 'failed', reasonCode: 'SEND_FAILED' };
    case 'canceled':
      return { status: 'canceled', reasonCode: 'CANCELED' };
    case 'awaiting_tap':
      return { status: 'canceled', reasonCode: 'CLIENT_REPLIED', cancelMessage: true };
    default:
      // dispatching (the sweeper owns it), queued/scheduled (dispatch will run again), missing
      return { status: 'pending', reasonCode: null };
  }
}
