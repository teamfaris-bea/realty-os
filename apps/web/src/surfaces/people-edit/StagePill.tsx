// Stage pill (PARITY_PLAN §5 "Change stage": pill → stage = 2 taps, toast with Undo). The eight stages show
// with the team's labels. Stages an agent cannot pick yet (R-PAR-14: a routed lead nobody has reached) are
// shown locked BEFORE the tap, with why and what to do instead ("Reach them first: Call · Text · Close"),
// never failing after it.
import { useId, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type Details, STAGE_KEYS, stageLabelOf } from './api.js';
import { usePersonAction, useToast } from './hooks.js';

// Parity module 67 (flagged edit): what the stage entry started, or why it did not, in plain words.
export type StageAutomation = { started: string } | { skipped: string; plan: string } | null | undefined;
const SKIP_WORDS: Record<string, string> = {
  already_in_a_plan: "they're already in a plan",
  plan_not_approved: "it isn't approved yet",
  cannot_be_reached: "they can't be messaged",
  not_visible: 'you can no longer see this person',
  stage_changed_again: 'the stage changed again',
  person_removed: 'this person was removed',
  not_a_person_change: 'only a stage change made by a person starts it',
  // R-PAR-8: a bulk stage change of a list built on a protected tag never starts a plan
  protected_audience: 'they were picked by a protected tag, and a plan never starts for such a list',
};

/** The sentence after "Stage: Active." on the toast; '' when no plan is set for that stage. */
export function automationText(a: StageAutomation): string {
  if (!a) return '';
  if ('started' in a) return `Started ${a.started}`;
  return `${a.plan} didn't start: ${SKIP_WORDS[a.skipped] ?? 'it could not start'}`;
}

export function StagePill({ contactId, name, details, onCall, onText }: { contactId: string; name: string; details: Details; onCall: () => void; onText: () => void }) {
  const [open, setOpen] = useState(false);
  const act = usePersonAction<{ stage: { stage: string; label: string }; previousStage: string; automation?: StageAutomation }>(contactId);
  const toast = useToast();
  const lockedId = useId();
  const labels = details.stageLabels;
  const current = details.stage.stage;
  const locked = new Set(details.stage.locked);

  const move = async (to: string) => {
    const r = await act.run('POST', `/contacts/${contactId}/stage`, { stage: to });
    if (!r.ok) return;
    setOpen(false);
    const prev = r.data.previousStage;
    if (prev === to) return;
    const plan = automationText(r.data.automation);
    const a = r.data.automation;
    // Undo moves the stage back; a plan that started keeps running (stop it from the plan itself), and says so
    const still = a && 'started' in a ? `. ${a.started} is still running` : '';
    toast({
      text: plan ? `Stage: ${r.data.stage.label}. ${plan}` : `Stage: ${r.data.stage.label}`,
      undo: () => void act.run('POST', `/contacts/${contactId}/stage`, { stage: prev }).then((u) => u.ok && toast({ text: `Stage back to ${stageLabelOf(prev, labels)}${still}` })),
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!details.canEdit}
        aria-label={`Stage: ${details.stage.label}. Change stage`}
        className="inline-flex min-h-tap items-center gap-1 self-start rounded-full border border-line bg-surface-2 px-4 text-[15px] font-semibold text-ink disabled:opacity-60"
      >
        {details.stage.label} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <Dialog title={`Stage for ${name}`} onClose={() => setOpen(false)} footer={<Button variant="secondary" block onClick={() => setOpen(false)}>Cancel</Button>}>
          {locked.size > 0 ? (
            <div id={lockedId} className="mb-3 flex flex-col gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-ink">
              <p>
                <span className="font-semibold">Reach them first.</span> {name} is a new lead nobody has reached yet, so the locked stages open once you call or text (or close the lead if it is not a real lead).
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" icon="phone" onClick={() => { setOpen(false); onCall(); }}>Call</Button>
                <Button variant="secondary" icon="message" onClick={() => { setOpen(false); onText(); }}>Text</Button>
              </div>
            </div>
          ) : null}
          <ul className="flex flex-col gap-1" aria-label="Stages">
            {STAGE_KEYS.map((s) => {
              const isLocked = locked.has(s);
              return (
                <li key={s}>
                  <button
                    type="button"
                    disabled={isLocked || act.pending}
                    aria-current={s === current ? 'true' : undefined}
                    aria-describedby={isLocked ? lockedId : undefined}
                    onClick={() => void move(s)}
                    className={`flex min-h-tap w-full items-center justify-between rounded-xl px-3 text-left text-[17px] ${s === current ? 'bg-accent-soft font-semibold text-ink' : 'text-ink'} disabled:text-ink-muted`}
                  >
                    <span>{stageLabelOf(s, labels)}</span>
                    <span className="text-[14px] text-ink-muted">{s === current ? 'Current' : isLocked ? 'Locked' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {act.error ? <Notice tone="error">{act.error}</Notice> : null}
        </Dialog>
      ) : null}
    </>
  );
}
