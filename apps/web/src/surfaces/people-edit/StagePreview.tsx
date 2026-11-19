// What a stage change will do, shown BEFORE it is saved (R-STG-3), from GET /contacts/:id/stage/preview: the server
// decides it with the same facts and the same function as the change itself, so the screen never promises what the
// save would not do.
//
//   Will start: <plan>, first step <channel> <when>     only when the preview's `starts` is set
//   <Plan> will not start: <why>                         the server's own sentence (an opt-out, no approved version, …)
//   No plan starts on this stage.                        nothing names the stage
//   Locked for now: reach them first.                    the stage rule refuses the change (said before any plan words)
//   Keeps running: <plan>   [Stop]                       directly under it: a stage change never stops a plan; Stop only
//                                                        when the server says this viewer's stop request would act
//
// StagePreviewBlock is that ONE line and the running plan (b19 fix pass M4: the sentence is on the screen once, in the
// sheet's body above the follow-up; the sheet's primary button is described by it). NeverNote is the footnote under
// the sheet and the picker: what no stage change ever does (it stops no plan; AI follow-up and tasks are unchanged).
//
// Nothing here is said in the past tense: what actually happened is read after the save (the toast, and the "What
// happens next" panel). While the answer is not in, and when it fails, the block says so and claims nothing.
import { useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { usePersonAction } from './hooks.js';
import { AI_UNCHANGED, NEVER_STOPS, type StagePreview, TASKS_UNCHANGED, effectLine, keepsRunningText, useStagePreview } from './stageFlow.js';

export const PREVIEW_LOADING = 'Checking what this will start…';
export const PREVIEW_FAILED = "We couldn't check what this change would start. The change is still checked when you save it.";

/**
 * Stop for a plan a stage change leaves running. Rendered only for a viewer the server says may stop it. A refusal
 * shows the server's reason; "Stopped" is said only after the stop route answered.
 */
export function StopPlan({ contactId, enrollmentId, plan, onStopped, compact = false }: { contactId: string; enrollmentId: string; plan: string; onStopped?: (plan: string) => void; compact?: boolean }) {
  const act = usePersonAction(contactId);
  const stop = async () => {
    const r = await act.run('POST', `/enrollments/${enrollmentId}/stop`);
    if (r.ok) onStopped?.(plan);
  };
  return (
    <>
      <Button variant="secondary" className={compact ? 'shrink-0' : 'self-start'} pending={act.pending} aria-label={`Stop ${plan}`} onClick={() => void stop()}>
        Stop
      </Button>
      {act.error ? <Notice tone="error">{act.error}</Notice> : null}
    </>
  );
}

/** The plan a stage change leaves running, with Stop when the viewer may stop it. */
export function KeepsRunning({ contactId, k, onStopped }: { contactId: string; k: NonNullable<StagePreview['keepsRunning']>; onStopped: (plan: string) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 [overflow-wrap:anywhere]">{keepsRunningText(k)}</span>
      {k.canStop ? <StopPlan contactId={contactId} enrollmentId={k.enrollmentId} plan={k.plan} onStopped={onStopped} compact /> : null}
    </span>
  );
}

export function StagePreviewBlock({ contactId, to, effectId }: { contactId: string; to: string; /** the id of the effect line (the primary button is described by it) */ effectId?: string }) {
  const q = useStagePreview(contactId, to);
  const [stopped, setStopped] = useState<string | null>(null);
  const p = q.data;
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3 py-2 text-[15px] text-ink" data-testid="stage-preview">
      <p id={effectId} data-testid="stage-step-effect" className={`leading-snug [overflow-wrap:anywhere] ${p?.allowed && p.starts ? 'font-semibold' : ''} ${!p && q.isPending ? 'text-ink-muted' : ''}`}>
        {p ? effectLine(p) : q.isError ? PREVIEW_FAILED : PREVIEW_LOADING}
      </p>
      {p?.keepsRunning ? <KeepsRunning contactId={contactId} k={p.keepsRunning} onStopped={setStopped} /> : null}
      {stopped ? (
        <p role="status" className="font-medium">
          Stopped {stopped}.
        </p>
      ) : null}
    </div>
  );
}

/** Under the stages, in smaller type: what no stage change ever does. */
export function NeverNote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[13px] leading-snug text-ink-muted ${className}`} data-testid="stage-never-note">
      <span>{NEVER_STOPS}</span> <span>{AI_UNCHANGED}</span> · <span>{TASKS_UNCHANGED}</span>
    </p>
  );
}
