// One way to change a person's stage, for the stage pill and the stage step (R-STG-5). The change's toast offers
// Undo; the Undo names the stage event it undoes (`undoOf`), so the server moves the stage back and never starts a
// plan for it. What the toast says after each request comes from that request's own answer:
//   "Stage: Active client. Buyer plan started"   [Undo] [See what happens next]   the change, and what its entry started
//                                                 or why not, in the SERVER's sentence (E784: one vocabulary);
//                                                 the second button scrolls to the page's panel (b19 fix pass M5)
//   "Stage back to Trying to reach. Buyer plan is still running; undo does not stop it."   + Stop when canStop
//   "Stage back to Trying to reach. Buyer plan is still paused; undo does not resume or stop it."   (E782)
//   "Stopped Buyer plan."                                                    only after the stop route answered
// A refusal says nothing was undone, or that the plan was not stopped, with the server's reason.
import { useCallback } from 'react';
import { type ActionResult, usePersonAction, useToast } from './hooks.js';
import { hasNextPanel, showNextPanel } from './NextPanel.js';
import { type StageResponse, UNDO_REFUSED, automationWords, joinWords, undoneText } from './stageFlow.js';

/** The stage toast's way to the page's "What happens next" panel. */
export const SEE_NEXT = 'See what happens next';

export function useStageChange(contactId: string, labelOf: (key: string) => string) {
  const act = usePersonAction<StageResponse>(contactId);
  const stopper = usePersonAction(contactId);
  const toast = useToast();

  const stop = useCallback(
    async (enrollmentId: string, plan: string) => {
      const r = await stopper.run('POST', `/enrollments/${enrollmentId}/stop`);
      toast({ text: r.ok ? `Stopped ${plan}.` : `${plan} was not stopped. ${r.message}` });
    },
    [stopper, toast],
  );

  const undo = useCallback(
    async (to: string, eventId: string) => {
      const r = await act.run('POST', `/contacts/${contactId}/stage`, { stage: to, undoOf: eventId });
      if (!r.ok) {
        toast({ text: r.code === 'STAGE_UNDO_INVALID' ? UNDO_REFUSED : `Not undone. ${r.message}` });
        return;
      }
      const still = r.data.stillRunning ?? null;
      toast({
        text: undoneText(r.data, labelOf),
        // Stop only for a viewer the server says may stop it; the "What happens next" panel keeps Stop after the toast
        ...(still?.canStop ? { action: { label: 'Stop', name: `Stop ${still.plan}`, run: () => void stop(still.enrollmentId, still.plan) } } : {}),
      });
    },
    [act, contactId, labelOf, stop, toast],
  );

  /**
   * Changes the stage; on success shows the toast (with Undo when the server named the event).
   *
   * `from`: the stage the caller knew the person was in. It matters for one answer only (E780): "the same stage
   * again". That is what a retry gets when the first request DID change the stage and its answer was lost; the server
   * then writes nothing and answers the stored event and its stored decision. The toast says exactly that (it used to
   * say nothing at all), and offers Undo back to `from` when the server named the event. The server alone decides
   * whether that undo is one (the caller's own change, not an undo itself, at most 15 minutes old: E779).
   */
  const change = useCallback(
    async (
      to: string,
      o: { /** words before "Stage: …" (what the same tap saved first) */ lead?: string; /** words after it (the follow-up the server stored) */ also?: string; /** the stage the person was in when the caller asked */ from?: string } = {},
    ): Promise<ActionResult<StageResponse>> => {
      const r = await act.run('POST', `/contacts/${contactId}/stage`, { stage: to });
      if (!r.ok) return r;
      // "the same stage again": the server reports the stage itself as the previous one
      const repeated = r.data.previousStage === to;
      const prev = repeated ? o.from : r.data.previousStage;
      // E784: what the entry started, or why it did not, in the server's own sentence
      const plan = automationWords(r.data);
      const eventId = r.data.eventId ?? null;
      toast({
        text: joinWords([o.lead, `Stage: ${r.data.stage.label}`, plan, o.also]),
        // without the event's id an undo could not be told from a new change (which may start a plan): not offered
        ...(eventId && prev !== undefined && prev !== to ? { undo: () => void undo(prev, eventId) } : {}),
        // M5 (E778): what the change did stays on the page's panel; one tap brings it into view (on a page that has it)
        ...(hasNextPanel() ? { action: { label: SEE_NEXT, run: () => void showNextPanel() } } : {}),
      });
      return r;
    },
    [act, contactId, toast, undo],
  );

  return { change, pending: act.pending, error: act.error, clearError: act.clearError };
}
