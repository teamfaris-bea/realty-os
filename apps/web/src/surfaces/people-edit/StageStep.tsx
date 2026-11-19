// The stage step (R-STG-2, R-STG-3, R-STG-6): the last step of logging what happened, in the same sheet. After a
// call's outcome, a logged call, text or email, a sent text, or an appointment's result is saved, the sheet shows:
//
//   - what was saved ("Voicemail logged"): the outcome is already stored; nothing below can undo or repeat it;
//   - the stage the outcome suggests, with what the stage means and why it is suggested, preselected. The agent
//     confirms it or picks otherwise: "Keep <current>", "Long-term follow-up" when the server offers it beside
//     "Connected", or "Another stage…" for all eight with their definitions and locks. A suggestion never changes a
//     stage by itself, and a stage the server marks locked is shown locked with the reason, never selectable;
//   - what the selected choice will do, from the server's preview (StagePreview.tsx);
//   - a follow-up: None, Tomorrow, 3 days, 1 week, or a picked date. It is an ordinary task, created with an id made
//     once per sheet, so a second tap or a retry answers the same task (R-STG-6);
//   - ONE primary button named for its effect ("Change to Trying to reach", "Keep New lead"), with the one line that
//     says what the choice will do to the automated plan directly above it, so it is read before the tap even when
//     the sheet's body is scrolled (a phone shows the choices first).
//
// Nothing is offered that the server would refuse: the stage controls show only to someone who may edit the person
// (`details.canEdit`), a locked stage is disabled, and the primary button waits for the preview and is disabled when
// the preview says the change is not allowed. The stage route decides again when the button is tapped; what it did
// is then on the toast (with Undo) and stays on the page's "What happens next" panel.
import { type StageSignal, suggestStageFromOutcome } from '@realty/core/parity/people';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { formatDateTime } from '../feed/lib/format.js';
import { useApi } from '../../shell/index.js';
import { type Details, type StageGuideRow, detailsKey, firstNameOf, guideOf, labelIn } from './api.js';
import { Chip, peopleMessage, selectClass, usePersonAction, useToast } from './hooks.js';
import { StageRow } from './StageChoices.js';
import { PREVIEW_FAILED, PREVIEW_LOADING, StagePreviewBlock } from './StagePreview.js';
import { type SuggestedStage, effectLabel, effectLine, useStagePreview } from './stageFlow.js';
import { useStageChange } from './useStageChange.js';

export type { StageSignal };

export interface StageStepProps {
  contactId: string;
  contactName: string;
  /** what the step before this one saved, in words ("Voicemail logged") */
  saved: string;
  /** the server's suggestion for the saved outcome (the outcome routes answer it), or null */
  suggested?: SuggestedStage | null;
  /**
   * For an outcome whose route answers no suggestion (a text sent from the compose box): the signal, read by core's
   * own table (suggestStageFromOutcome, the function the API's routes use) against the person's fresh details.
   */
  signal?: StageSignal | null;
  onClose(): void;
}

const FOLLOW_UPS = [
  { key: 'none', label: 'None', days: 0 },
  { key: 'tomorrow', label: 'Tomorrow', days: 1 },
  { key: '3d', label: '3 days', days: 3 },
  { key: '1w', label: '1 week', days: 7 },
  { key: 'pick', label: 'Pick a date', days: 0 },
] as const;
type FollowUpKey = (typeof FOLLOW_UPS)[number]['key'];

/** 9:00 in the morning, local time, `days` from today. */
export function morningIn(days: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The suggestion for `signal` from the person's own details, by core's table; locked as the details say. */
export function suggestionFromSignal(details: Pick<Details, 'stage'>, signal: StageSignal): SuggestedStage | null {
  const s = suggestStageFromOutcome({ current: details.stage.stage as Parameters<typeof suggestStageFromOutcome>[0]['current'], signal });
  if (!s) return null;
  const locked = (k: string) => details.stage.locked.includes(k);
  return { stage: s.stage, why: s.why, locked: locked(s.stage), alsoOffer: s.alsoOffer.map((k) => ({ stage: k, locked: locked(k) })) };
}

function Saved({ text }: { text: string }) {
  return (
    <p role="status" data-testid="stage-step-saved" className="rounded-xl bg-ok-soft px-3 py-2 text-[15px] font-medium text-ink [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}

export function StageStep(props: StageStepProps) {
  const { contactId, contactName, saved, onClose } = props;
  const qc = useQueryClient();
  const api = useApi();
  // The person as they are NOW, asked afresh when the step opens: the outcome just saved may have changed what the
  // page had cached (the dial of a first call is the first contact, which opens the locked stages). The step keeps
  // this one reading: a confirmed change refreshes the details behind the sheet and must not turn the step into
  // another one. The answer also replaces the page's cached details, so the stage pill agrees with the sheet.
  const [details, setDetails] = useState<Details | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    qc.fetchQuery<{ details: Details }>({ queryKey: detailsKey(contactId), queryFn: ({ signal }) => api.get<{ details: Details }>(`/contacts/${contactId}/details`, { signal }), staleTime: 0 }).then(
      (r) => live && setDetails(r.details),
      (e: unknown) => live && setFailed(peopleMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [qc, api, contactId]);
  const canEdit = details?.canEdit === true;

  const guide = useMemo(() => guideOf(details?.stageGuide), [details?.stageGuide]);
  const labelOf = (k: string) => labelIn(guide, k);
  const row = (k: string): StageGuideRow => guide.find((g) => g.key === k) ?? { key: k, label: labelOf(k), definition: '', notThis: '' };
  const current = details?.stage.stage ?? '';
  const lockedSet = new Set(details?.stage.locked ?? []);
  const suggested = !details || !canEdit ? null : (props.suggested ?? (props.signal ? suggestionFromSignal(details, props.signal) : null));
  const offer = suggested && suggested.stage !== current ? suggested : null;
  const offerLocked = offer !== null && (offer.locked || lockedSet.has(offer.stage));
  // null: the agent has not picked, so the suggestion (when it can be taken) or the current stage is selected
  const [pickedStage, setPickedStage] = useState<string | null>(null);
  const selected = pickedStage ?? (offer && !offerLocked ? offer.stage : current);
  const [all, setAll] = useState(false);
  const [followUp, setFollowUp] = useState<FollowUpKey>('none');
  const [picked, setPicked] = useState(() => localInput(morningIn(1)));
  // R-STG-6: one id for this sheet's follow-up: a second tap, or a retry after a lost answer, is the same task
  const taskId = useRef<string>(globalThis.crypto.randomUUID());
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const stage = useStageChange(contactId, labelOf);
  const task = usePersonAction<{ task: { id: string }; replayed: boolean }>(contactId);
  const toast = useToast();
  const ids = { locked: useId(), follow: useId(), pick: useId(), effect: useId() };
  const first = firstNameOf(contactName);

  const preview = useStagePreview(contactId, canEdit ? selected : null);
  // never a control the server would refuse: the change waits for its preview, and a refused one cannot be sent
  const refused = selected !== current && preview.data !== undefined && !preview.data.allowed;
  const waiting = selected !== current && preview.isPending;

  const due = followUp === 'none' ? null : followUp === 'pick' ? new Date(picked) : morningIn(FOLLOW_UPS.find((f) => f.key === followUp)!.days);
  const dueOk = due === null || Number.isFinite(due.getTime());

  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      let also: string | undefined;
      // the follow-up first: the toast of the stage change may then say it, truthfully
      if (due) {
        const t = await task.run('POST', '/tasks', { id: taskId.current, title: `Follow up with ${first}`, kind: 'follow_up', contactId, dueAt: due.toISOString() });
        if (!t.ok) return;
        also = `Follow-up added for ${formatDateTime(due.toISOString())}`;
      }
      if (selected !== current) {
        const r = await stage.change(selected, also ? { also } : {});
        if (!r.ok) return;
      } else if (also) toast({ text: also });
      onClose();
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  const title = `Stage for ${contactName}`;
  if (!details || !canEdit) {
    // still reading, could not read, or someone who may not change the stage: what was saved, and no stage control
    return (
      <Dialog
        title={title}
        onClose={onClose}
        footer={
          <Button block variant="secondary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <Saved text={saved} />
          {!details ? failed ? <Notice tone="error">{failed}</Notice> : <p className="text-[15px] text-ink-muted">Loading</p> : <p className="text-[15px] text-ink">The stage stays {details.stage.label}. Only someone who can edit this person changes it.</p>}
        </div>
      </Dialog>
    );
  }

  const choice = (k: string, o: { badge?: string; why?: string; label?: string } = {}) => (
    <StageRow key={k} mode="select" compact stage={row(k)} locked={k !== current && lockedSet.has(k)} lockedBy={ids.locked} selected={selected === k} badge={o.badge} why={o.why} label={o.label} disabled={working} onPick={() => setPickedStage(k)} />
  );
  const also = (offer?.alsoOffer ?? []).filter((a) => a.stage !== current && a.stage !== offer?.stage);
  const anyLocked = all ? lockedSet.size > 0 : offerLocked || also.some((a) => a.locked || lockedSet.has(a.stage));
  const primary = `${effectLabel(selected, current, labelOf)}${due ? ' + follow-up' : ''}`;

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {/* what the tap will do to the automated plan, always in view above the button (the full preview is in the body) */}
          <p id={ids.effect} data-testid="stage-step-effect" className="text-[14px] leading-snug text-ink [overflow-wrap:anywhere]">
            {refused ? 'Locked for now: reach them first.' : preview.data ? effectLine(preview.data) : preview.isError ? PREVIEW_FAILED : PREVIEW_LOADING}
          </p>
          <Button block className="py-2" pending={working} disabled={refused || waiting || !dueOk} aria-describedby={ids.effect} onClick={() => void confirm()} data-testid="stage-step-confirm">
            {primary}
          </Button>
          <Button block variant="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Saved text={saved} />
        {anyLocked ? (
          <p id={ids.locked} className="rounded-xl bg-warn-soft px-3 py-2 text-[14px] text-ink">
            <span className="font-semibold">Reach them first.</span> The locked stages open once you reach {first} with a call, text, email or a reply in their website chat. Something logged from outside Realty OS does not count.
          </p>
        ) : null}
        <div role="radiogroup" aria-label="Stage" className="flex flex-col gap-1.5">
          {all ? (
            guide.map((g) => choice(g.key, { badge: g.key === current ? 'Current' : g.key === offer?.stage ? 'Suggested' : undefined, why: g.key === offer?.stage ? offer.why : undefined }))
          ) : (
            <>
              {offer ? (
                offerLocked ? (
                  <StageRow mode="select" compact stage={row(offer.stage)} locked lockedBy={ids.locked} why={offer.why} onPick={() => undefined} />
                ) : (
                  choice(offer.stage, { badge: 'Suggested', why: offer.why })
                )
              ) : null}
              {choice(current, { label: `Keep ${labelOf(current)}` })}
              {also.map((a) => (a.locked || lockedSet.has(a.stage) ? <StageRow key={a.stage} mode="select" compact stage={row(a.stage)} locked lockedBy={ids.locked} onPick={() => undefined} /> : choice(a.stage)))}
            </>
          )}
        </div>
        <StagePreviewBlock contactId={contactId} to={selected} />
        {all ? null : (
          <Button variant="quiet" className="self-start" aria-expanded={false} onClick={() => setAll(true)}>
            Another stage…
          </Button>
        )}
        {refused ? <Notice tone="warn">This stage is locked for now: reach {first} first (a call, text, email or reply in their website chat).</Notice> : null}
        <div className="flex flex-col gap-2">
          <p id={ids.follow} className="text-[15px] font-medium text-ink">
            Follow-up
          </p>
          <div role="group" aria-labelledby={ids.follow} className="flex flex-wrap gap-2">
            {FOLLOW_UPS.map((f) => (
              <Chip key={f.key} selected={followUp === f.key} disabled={working} onClick={() => setFollowUp(f.key)}>
                {f.label}
              </Chip>
            ))}
          </div>
          {followUp === 'pick' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.pick} className="text-[15px] font-medium text-ink">
                Follow up on
              </label>
              <input id={ids.pick} type="datetime-local" value={picked} onChange={(e) => setPicked(e.target.value)} className={selectClass} aria-invalid={!dueOk || undefined} />
            </div>
          ) : null}
          <p className="text-[14px] text-ink-muted" data-testid="follow-up-line">
            {due && dueOk ? `A task for you: “Follow up with ${first}”, due ${formatDateTime(due.toISOString())}.` : followUp === 'pick' ? 'Pick a date and time.' : 'No follow-up task.'}
          </p>
        </div>
        {task.error ? <Notice tone="error">{task.error}</Notice> : null}
        {stage.error ? <Notice tone="error">{stage.error}</Notice> : null}
      </div>
    </Dialog>
  );
}
