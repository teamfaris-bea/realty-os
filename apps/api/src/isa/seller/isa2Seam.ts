// The seller part's seam to the rest of module 75 (lane ISA-2: apps/api/src/isa/**). Every import of ISA-2's code by
// isa/seller goes through this file. ISA-2 is merged on this branch's base, so the re-exports are real.
//
// STUB(ISA-2): two functions ISA-2 has not built. Each refuses and records "not delivered"; switching one is a one-file
// change here once ISA-2 exports it:
//   queueFactsMessageInTx   a model-free facts message (the E537 re-render), queued under ISA-2's checks
//   enqueueListingEventInTx a listing_event turn for a competition change (ISA-2's TurnPayload has no listing_event)
import type { Tx } from '@realty/db';
import type { PendingAny } from './index.js';

export { type AssignmentRow, type LinkResult, assignmentById, liveAssignmentOf, lockForTurn } from '../repo.js';
export { type ApplyEnv, type IsaContext, type IsaDeps, contextFor, queueIsaMessageInTx, sha256 } from '../effects.js';
export { capabilitySet, systemEndInTx, systemPauseInTx } from '../controls.js';

export type StubOutcome = { delivered: false; code: 'NOT_BUILT'; sentence: string };

/**
 * STUB(ISA-2): refuses; the re-render is reported to the agent as not delivered. The real function queues `body` under
 * ISA-2's checks with `pendingFacts` written against its message (writeSellerFactsInTx), binds it to `turnId`, and marks
 * its assistant action `rerenderOf` (the original message), so a change of the re-render is refused without another
 * one (E537: it never loops).
 */
export async function queueFactsMessageInTx(
  _tx: Tx,
  _i: { assignmentId: string; rerenderOf: string; turnId: string | null; channel: 'email' | 'sms'; body: string; pendingFacts: readonly PendingAny[] },
): Promise<StubOutcome> {
  return { delivered: false, code: 'NOT_BUILT', sentence: 'Not delivered: the assistant cannot re-send updated facts yet (not built yet).' };
}

/** STUB(ISA-2): refuses; the watch keeps the event in its snapshot and the panel says "not built yet". */
export async function enqueueListingEventInTx(_tx: Tx, _i: { assignmentId: string; event: string; listingId: string; dedupeKey: string }): Promise<StubOutcome> {
  return { delivered: false, code: 'NOT_BUILT', sentence: 'Competition updates are not sent yet (not built yet).' };
}
