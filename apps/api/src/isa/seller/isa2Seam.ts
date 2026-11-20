// The seller part's seam to the rest of module 75 (lane ISA-2: apps/api/src/isa/**). Every import of ISA-2's code by
// isa/seller goes through this file. ISA-2 is merged on this branch's base, so the re-exports are real.
//
// STUB(ISA-2): two functions that stay unbuilt. Each refuses and records "not delivered". Batch 19 step 2 read both
// against the existing AI send path (effects.ts queueIsaMessageInTx, the turn's TX-A/TX-B, dispatch TX1 and the DB
// guards) and left them, because each needs a rule that does not exist yet (docs/AI_ISA.md §6.5 "The two seller stubs"):
//
//   queueFactsMessageInTx   a model-free facts message (the E537 re-render), queued under ISA-2's checks.
//     1. A message canceled FACT_CHANGED already gets a `replan` turn one second later (handlers.ts onSendResult; core
//        sendPolicy FACT_CHANGED: 'replan'). A re-render would be a second answer to the same cancellation, and
//        "one open AI message per person" makes each supersede the other. Which one answers is not decided.
//     2. With nothing left to render the design says DATA_UNAVAILABLE "becomes a data_unavailable escalation" (VERIFY):
//        that sends the lead the team's holding line about a question they did not ask. Not decided.
//     3. It would queue outside a machine step, so the machine's own conditions (live, not paused, not booking, the held
//        topics) would have to be written a second time here: a parallel gate, which this work does not add.
//
//   enqueueListingEventInTx a listing_event turn for a competition change. Core has the event (machine.ts
//     `listing_event` → one initiated facts message) and the DB allows the trigger kind, so it can be wired. It is not,
//     because the limits an Owner approves in the team policy would not hold for these messages:
//     1. `unansweredInitiated` counts only the follow-up timer's messages (machine.ts onTimer). A seller who never
//        answers would keep getting competition updates (up to the initiated caps each week) until the 40-message
//        limit, although the policy says the assistant slows after 3 unanswered follow-ups and stops after 6. Counting
//        them is a change to core's decision rules (AI_ISA_RULES_VERSION) and a product decision.
//     2. A new message supersedes the person's pending AI message (queueIsaMessageInTx): an update would cancel a reply
//        to their own question that is waiting for its send window. Whether an update waits, and how long, is not decided.
//     3. How often a seller may be sent competition updates at all (per event, a daily digest, per week) has no rule
//        beyond the general initiated caps.
//   Until the owner decides these, the watch keeps recording each event with `delivered: false` and nothing is sent.
import type { Tx } from '@realty/db';
import type { PendingAny } from './index.js';

export { type AssignmentRow, type LinkResult, assignmentById, liveAssignmentOf, lockForTurn } from '../repo.js';
export { type ApplyEnv, type IsaContext, type IsaDeps, contextFor, queueIsaMessageInTx, sha256 } from '../effects.js';
export { capabilitySet, systemEndInTx, systemPauseInTx } from '../controls.js';

export type StubOutcome = { delivered: false; code: 'NOT_BUILT'; sentence: string };

/**
 * STUB(ISA-2), kept (see the header): refuses; the re-render is reported to the agent as not delivered. The real function queues `body` under
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

/** STUB(ISA-2), kept (see the header): refuses; the watch records the event as not delivered and the panel says "not built yet". */
export async function enqueueListingEventInTx(_tx: Tx, _i: { assignmentId: string; event: string; listingId: string; dedupeKey: string }): Promise<StubOutcome> {
  return { delivered: false, code: 'NOT_BUILT', sentence: 'Competition updates are not sent yet (not built yet).' };
}
