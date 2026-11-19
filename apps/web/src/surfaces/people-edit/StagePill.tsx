// Stage pill (PARITY_PLAN §5 "Change stage": pill → stage = 2 taps, toast with Undo). The eight stages show
// with the team's labels. Stages an agent cannot pick yet (R-PAR-14: a routed lead nobody has reached) are
// shown locked BEFORE the tap, with why and what to do instead ("Reach them first: Call · Text · Close", with Reply
// in chat first while the lead's website chat is open: owner decision D8 made a chat reply first contact, R-OWN-14),
// never failing after it. Each stage shows what it means and what it does not (R-STG-1; StageChoices.tsx), and what
// picking it will do to the person's automated plan, before the tap (R-STG-3; StagePreview.tsx).
import { useId, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { useReachability } from '../../reasons/index.js';
import { type Details, type StageGuideRow, guideOf, labelIn } from './api.js';
import { StageRow } from './StageChoices.js';
import { KeepsRunning, NeverNote, PREVIEW_LOADING } from './StagePreview.js';
import { effectLine, useStagePreview } from './stageFlow.js';
import { useStageChange } from './useStageChange.js';

// Parity module 67 (flagged edit): what the stage entry started, or why it did not (stageFlow.ts has the words).
export { type StageAutomation, automationText } from './stageFlow.js';

/**
 * One stage in the pill's picker. Tapping it changes the stage at once (PARITY_PLAN §5: pill → stage = 2 taps), so
 * what the change will do is on the row BEFORE the tap (R-STG-3): the row asks the server's preview for its stage
 * and cannot be picked until the answer is in. The person's own stage and a locked stage are not asked about.
 */
function PickerRow({ contactId, stage, current, locked, lockedBy, busy, onPick }: { contactId: string; stage: StageGuideRow; current: boolean; locked: boolean; lockedBy: string; busy: boolean; onPick: () => void }) {
  const q = useStagePreview(contactId, current || locked ? null : stage.key);
  const asked = !current && !locked;
  const effect = !asked ? undefined : q.data ? effectLine(q.data) : q.isError ? PICK_PREVIEW_FAILED : PREVIEW_LOADING;
  return <StageRow mode="pick" stage={stage} current={current} locked={locked} lockedBy={lockedBy} effect={effect} disabled={busy || (asked && q.isPending)} onPick={onPick} />;
}

const PICK_PREVIEW_FAILED = "We couldn't check what this would start. The change is still checked when you pick it.";

/** Above the stages, once, when the person is in a plan: it keeps running whatever stage is picked (Stop when allowed). */
function RunningPlan({ contactId, anyStage }: { contactId: string; anyStage: string | null }) {
  // every stage's preview reports the same running plan: read it from one the rows already ask for
  const k = useStagePreview(contactId, anyStage).data?.keepsRunning ?? null;
  const [stopped, setStopped] = useState<string | null>(null);
  if (!k && !stopped) return null;
  return (
    <div className="mb-3 flex flex-col gap-1 rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink">
      {k ? <KeepsRunning contactId={contactId} k={k} onStopped={setStopped} /> : null}
      {stopped ? (
        <p role="status" className="font-medium">
          Stopped {stopped}.
        </p>
      ) : null}
    </div>
  );
}

export function StagePill({ contactId, name, details, onCall, onText, onReplyChat }: { contactId: string; name: string; details: Details; onCall: () => void; onText: () => void; onReplyChat: () => void }) {
  const [open, setOpen] = useState(false);
  const lockedId = useId();
  // R-STG-1: the eight stages as the API describes them for this team
  const guide = guideOf(details.stageGuide);
  const current = details.stage.stage;
  const locked = new Set(details.stage.locked);
  // a reply in the open website chat is first contact (owner decision D8) and opens the stages; a chat that ended, was
  // turned off or is blocked takes no reply (E312), so it is not offered. Asked only for a lead with locked stages.
  const chat = useReachability(locked.size > 0 ? contactId : null)?.channels.web_chat;
  const chatOpen = chat?.session?.open === true && !chat.blocked;

  // R-STG-5: the toast's Undo names the stage event (undoOf), so an undo never starts a plan, and it says plainly
  // that a plan the change started keeps running (useStageChange.ts)
  const act = useStageChange(contactId, (k) => labelIn(guide, k));
  const move = async (to: string) => {
    const r = await act.change(to, { from: current });
    if (r.ok) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!details.canEdit}
        aria-label={`Stage: ${details.stage.label}. Change stage`}
        className="inline-flex min-h-tap max-w-full items-center gap-1 self-start rounded-3xl border border-line bg-surface-2 px-4 py-1.5 text-left text-[15px] font-semibold text-ink [overflow-wrap:anywhere] disabled:opacity-60"
      >
        {details.stage.label} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <Dialog title={`Stage for ${name}`} onClose={() => setOpen(false)} footer={<Button variant="secondary" block onClick={() => setOpen(false)}>Cancel</Button>}>
          {locked.size > 0 ? (
            <div id={lockedId} className="mb-3 flex flex-col gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-ink">
              <p>
                <span className="font-semibold">Reach them first.</span> {name} is a new lead nobody has reached yet, so the locked stages open once you reach them: a call, text, email or reply in their website chat (or close the lead if it is not a real lead).
              </p>
              <div className="flex flex-wrap gap-2">
                {chatOpen ? <Button variant="secondary" icon="message" onClick={() => { setOpen(false); onReplyChat(); }}>Reply in chat</Button> : null}
                <Button variant="secondary" icon="phone" onClick={() => { setOpen(false); onCall(); }}>Call</Button>
                <Button variant="secondary" icon="message" onClick={() => { setOpen(false); onText(); }}>Text</Button>
              </div>
            </div>
          ) : null}
          <RunningPlan contactId={contactId} anyStage={guide.find((g) => g.key !== current && !locked.has(g.key))?.key ?? null} />
          <ul className="flex flex-col gap-1" aria-label="Stages">
            {guide.map((g) => (
              <li key={g.key}>
                <PickerRow contactId={contactId} stage={g} current={g.key === current} locked={locked.has(g.key)} lockedBy={lockedId} busy={act.pending} onPick={() => void move(g.key)} />
              </li>
            ))}
          </ul>
          <NeverNote className="mt-3 rounded-xl bg-surface-2 px-3 py-2" />
          {act.error ? <Notice tone="error">{act.error}</Notice> : null}
        </Dialog>
      ) : null}
    </>
  );
}
