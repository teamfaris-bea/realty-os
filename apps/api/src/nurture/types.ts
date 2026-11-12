// Shared vocabulary of api/nurture (PHASE2_3_PLAN §5.4 #26).
//
// The module reaches the outside world ONLY through api/comms: a trigger message is queued with
// queueOutboundInTx and sent by comms/dispatch.ts (dispatchOutbound), which runs the send-time gate (D1
// opt-outs, R-PAR-12, suppressions, the pause) and whose DB dispatch guard refuses an autonomous send while
// the conversation is paused or the version is not approved. Nothing in this module sends on its own path.
import type { AssistantDeps } from '../assistant/types.js';

export type NurtureDeps = AssistantDeps;

/** Job kinds of api/nurture (registered in worker/handlers/index.ts, one line). */
export const NURTURE_JOBS = {
  /** per tenant, every 60 s: wakes due trigger firings and settles digest members (R-OWN-27, §21.4) */
  reconcile: 'triggers.reconcile',
  /** one firing (and its digest batch): executeTriggerRun(stepRunId) */
  step: 'trigger.step',
  /** per tenant, hourly (a no-op after the first run of a local day): yearly home anniversaries */
  anniversaryScan: 'nurture.anniversary_scan',
  /** a team listing's price or status changed (workspace/listings.ts) */
  listingChanged: 'nurture.listing_changed',
  /** per tenant, daily, standalone: monthly home values (wave 2C; R-AVM-3, P15) */
  avmRefresh: 'avm.refresh',
} as const;

export const TRIGGER_RECONCILE_EVERY_MS = 60_000;
export const ANNIVERSARY_SCAN_EVERY_MS = 60 * 60_000;
export const AVM_REFRESH_EVERY_MS = 24 * 60 * 60_000;
/** Due firings woken per reconcile pass (bounded work per job; the next pass picks up the rest). */
export const RECONCILE_BATCH = 500;
