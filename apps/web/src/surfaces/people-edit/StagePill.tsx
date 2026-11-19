// Stage pill (PARITY_PLAN §5 "Change stage": pill → stage = 2 taps, toast with Undo). The eight stages show
// with the team's labels. Stages an agent cannot pick yet (R-PAR-14: a routed lead nobody has reached) are
// shown locked BEFORE the tap, with why and what to do instead ("Reach them first: Call · Text · Close", with Reply
// in chat first while the lead's website chat is open: owner decision D8 made a chat reply first contact, R-OWN-14),
// never failing after it. Each stage shows what it means and what it does not (R-STG-1; StageChoices.tsx).
import { useId, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { useReachability } from '../../reasons/index.js';
import { type Details, guideOf, labelIn } from './api.js';
import { StageRow } from './StageChoices.js';
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
  // R-ISA-2 (b12 review B12X-4): the person is in the assistant's ISA care, which never runs beside a plan
  ai_isa_active: "they're in the assistant's ISA care, and no plan starts while it lasts",
  // b18 review B18S-5 (owner boundary 2026-11-14): a plan is automated contact
  source_no_automated_contact: 'their lead source is marked "No automated contact for leads from this source"',
  // R-LSRC-9 (owner decision 2026-11-14): an imported person whose source is not reviewed yet
  source_unclassified: 'they came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources)',
};

/** The sentence after "Stage: Active." on the toast; '' when no plan is set for that stage. */
export function automationText(a: StageAutomation): string {
  if (!a) return '';
  if ('started' in a) return `Started ${a.started}`;
  return `${a.plan} didn't start: ${SKIP_WORDS[a.skipped] ?? 'it could not start'}`;
}

export function StagePill({ contactId, name, details, onCall, onText, onReplyChat }: { contactId: string; name: string; details: Details; onCall: () => void; onText: () => void; onReplyChat: () => void }) {
  const [open, setOpen] = useState(false);
  const act = usePersonAction<{ stage: { stage: string; label: string }; previousStage: string; automation?: StageAutomation }>(contactId);
  const toast = useToast();
  const lockedId = useId();
  // R-STG-1: the eight stages as the API describes them for this team
  const guide = guideOf(details.stageGuide);
  const current = details.stage.stage;
  const locked = new Set(details.stage.locked);
  // a reply in the open website chat is first contact (owner decision D8) and opens the stages; a chat that ended, was
  // turned off or is blocked takes no reply (E312), so it is not offered. Asked only for a lead with locked stages.
  const chat = useReachability(locked.size > 0 ? contactId : null)?.channels.web_chat;
  const chatOpen = chat?.session?.open === true && !chat.blocked;

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
      undo: () => void act.run('POST', `/contacts/${contactId}/stage`, { stage: prev }).then((u) => u.ok && toast({ text: `Stage back to ${labelIn(guide, prev)}${still}` })),
    });
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
          <ul className="flex flex-col gap-1" aria-label="Stages">
            {guide.map((g) => (
              <li key={g.key}>
                <StageRow mode="pick" stage={g} current={g.key === current} locked={locked.has(g.key)} lockedBy={lockedId} disabled={act.pending} onPick={() => void move(g.key)} />
              </li>
            ))}
          </ul>
          {act.error ? <Notice tone="error">{act.error}</Notice> : null}
        </Dialog>
      ) : null}
    </>
  );
}
