// The stage step (R-STG-2, R-STG-3, R-STG-6; redesigned in the b19 fix pass, M4 and M6): the last step of logging
// what happened, in the same sheet. Two sheets use it:
//
//   - StageStep (this file's dialog), after an outcome that is ALREADY saved: a call's outcome (saved by its own tap),
//     a sent text, an appointment's result. Call → outcome → confirm = 3 taps.
//   - the Log sheet (notes/LogSheet.tsx), IN PLACE: choosing an outcome reveals the step under what is being logged,
//     and ONE primary button saves the log and then the stage. Log → outcome → that button = 3 taps.
//
// Top to bottom, so that on a phone (390 × 664) nothing that matters is under the fold when the step opens:
//
//   what was logged ("Voicemail logged")
//   the stage the outcome suggests, with what the stage means and why it is suggested, preselected
//   "Keep <current>"
//   "Long-term follow-up" when the server offers it beside "Connected"
//   "Another stage…" (all eight with their definitions and locks)
//   ONE line: what the selected choice will do to the automated plan, from the server's preview (StagePreview.tsx),
//     with "Keeps running: <plan>" and Stop directly under it when a plan is running
//   the follow-up chips (FollowUp.tsx: what the screen says is the task the server stored)
//   the primary button, pinned above the safe area and named for its effect; it is described by that one line
//
// Nothing is offered that the server would refuse: the stage controls show only to someone who may edit the person
// (`details.canEdit`), a locked stage is disabled, and the primary button waits for the preview and is disabled when
// the preview says the change is not allowed. The stage route decides again when the button is tapped; what it did
// is then on the toast (with Undo) and stays on the page's "What happens next" panel.
//
// A partial save is said exactly (E775): when the follow-up or the stage change fails after something was saved, the
// sheet stays open, says what was saved and what was not with the server's reason, and the button stays enabled.
import { type StageSignal, suggestStageFromOutcome } from '@realty/core/parity/people';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { useApi } from '../../shell/index.js';
import { type Details, type StageGuideRow, detailsKey, firstNameOf, guideOf, labelIn } from './api.js';
import { FollowUpChips, followUpSavedText, morningIn, useFollowUp } from './FollowUp.js';
import { peopleMessage, useToast } from './hooks.js';
import { StageRow } from './StageChoices.js';
import { NeverNote, StagePreviewBlock } from './StagePreview.js';
import { type SuggestedStage, effectLabel, joinWords, useStagePreview } from './stageFlow.js';
import { useStageChange } from './useStageChange.js';

export type { StageSignal };
export { morningIn };

/** Where the step's suggestion comes from. */
export interface StageStepSource {
  /** the server's suggestion for the saved outcome (the outcome routes answer it), or null */
  suggested?: SuggestedStage | null | undefined;
  /**
   * For an outcome whose route answers no suggestion before the step shows (a text sent from the compose box; a log
   * that is not saved yet): the signal, read by core's own table (suggestStageFromOutcome, the function the API's
   * routes use) against the person's fresh details.
   */
  signal?: StageSignal | null | undefined;
  /** false: no outcome is chosen yet (the Log sheet before its outcome), so nothing is asked about any stage */
  active?: boolean | undefined;
}

export interface StageStepProps extends StageStepSource {
  contactId: string;
  contactName: string;
  /** what the step before this one saved, in words ("Voicemail logged") */
  saved: string;
  onClose(): void;
}

/** The suggestion for `signal` from the person's own details, by core's table; locked as the details say. */
export function suggestionFromSignal(details: Pick<Details, 'stage'>, signal: StageSignal): SuggestedStage | null {
  const s = suggestStageFromOutcome({ current: details.stage.stage as Parameters<typeof suggestStageFromOutcome>[0]['current'], signal });
  if (!s) return null;
  const locked = (k: string) => details.stage.locked.includes(k);
  return { stage: s.stage, why: s.why, locked: locked(s.stage), alsoOffer: s.alsoOffer.map((k) => ({ stage: k, locked: locked(k) })) };
}

export function Saved({ text }: { text: string }) {
  return (
    <p role="status" data-testid="stage-step-saved" className="rounded-xl bg-ok-soft px-3 py-1.5 text-[15px] font-medium text-ink [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * The step's state: the person read afresh, the selected stage, the follow-up, and `finish` (the follow-up, then the
 * stage change). One instance per sheet.
 */
export function useStageStep(contactId: string, contactName: string, src: StageStepSource) {
  const qc = useQueryClient();
  const api = useApi();
  // The person as they are NOW, asked afresh when the sheet opens: the outcome just saved may have changed what the
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
  const suggested = !details || !canEdit ? null : (src.suggested ?? (src.signal ? suggestionFromSignal(details, src.signal) : null));
  const offer = suggested && suggested.stage !== current ? suggested : null;
  const offerLocked = offer !== null && (offer.locked || lockedSet.has(offer.stage));
  // null: the agent has not picked, so the suggestion (when it can be taken) or the current stage is selected
  const [pickedStage, setPickedStage] = useState<string | null>(null);
  const selected = pickedStage ?? (offer && !offerLocked ? offer.stage : current);
  const [all, setAll] = useState(false);
  const busy = useRef(false);
  // everything asked for was done and the sheet is closing: a late tap does nothing
  const done = useRef(false);
  const [working, setWorking] = useState(false);
  // what was not saved, in words (null: nothing failed since the last tap)
  const [failure, setFailure] = useState<string | null>(null);
  const stage = useStageChange(contactId, labelOf);
  const toast = useToast();
  const ids = { locked: useId(), effect: useId() };
  const first = firstNameOf(contactName);
  // M1: what the screen says about the follow-up is the task the server answered (FollowUp.tsx)
  const follow = useFollowUp(contactId, first);

  const preview = useStagePreview(contactId, canEdit && (src.active ?? true) ? selected : null);
  // never a control the server would refuse: the change waits for its preview, and a refused one cannot be sent
  const refused = selected !== current && preview.data !== undefined && !preview.data.allowed;
  const waiting = selected !== current && preview.isPending;

  /**
   * The follow-up, then the stage change. `saved`: what is already stored, in words (for the sentence of a partial
   * save). `lead`: words the closing toast starts with (the Log sheet's "Call logged": that sheet has no banner left
   * once it closes). Resolves true when everything asked for was done; the caller then closes the sheet.
   */
  const finish = async (o: { saved: string; lead?: string | undefined }): Promise<boolean> => {
    if (busy.current || done.current) return false;
    busy.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const changing = selected !== current;
      // the follow-up first: the toast of the stage change may then say it, in the words of the task the server stored
      const f = await follow.save();
      if (!f.ok) {
        // a lost answer is not a refusal: the task may be stored (the retry then answers it, FollowUp.tsx)
        const what = f.uncertain ? `We could not confirm the follow-up was saved${changing ? ', and the stage was not changed' : ''}` : `The follow-up was not saved${changing ? ' and the stage did not change' : ''}`;
        setFailure(`${sentence(o.saved)} ${what}: ${f.message}`);
        return false;
      }
      const also = f.task ? followUpSavedText(f.task) : undefined;
      if (changing) {
        const r = await stage.change(selected, { ...(o.lead ? { lead: o.lead } : {}), ...(also ? { also } : {}) });
        if (!r.ok) {
          // refused: the stage did not change. A lost answer: nobody knows yet; the retry reads what is stored (E780)
          // (the follow-up is not repeated here: its own line says the stored task, and stays true if it is changed)
          setFailure(`${sentence(o.saved)} ${r.uncertain ? 'We could not confirm the stage change' : 'The stage did not change'}: ${r.message}`);
          return false;
        }
      } else {
        const text = joinWords([o.lead, also]);
        if (text) toast({ text });
      }
      done.current = true;
      return true;
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  return {
    contactId,
    first,
    details,
    failed,
    canEdit,
    guide,
    labelOf,
    row,
    current,
    lockedSet,
    offer,
    offerLocked,
    selected,
    pick: setPickedStage,
    all,
    showAll: () => setAll(true),
    follow,
    working,
    failure,
    ids,
    refused,
    /** the button is named for its effect: "Change to Connected", "Keep New lead" (+ follow-up when it will add one) */
    primary: `${effectLabel(selected, current, labelOf)}${follow.willAdd ? ' + follow-up' : ''}`,
    blocked: refused || waiting || !follow.dueOk,
    finish,
  };
}

export type StageStepState = ReturnType<typeof useStageStep>;

/** The step's choices, the one effect line and the follow-up, in that order (for someone who may edit). */
export function StageStepBody({ s, disabled = false }: { s: StageStepState; disabled?: boolean }) {
  const { offer, offerLocked, current, lockedSet, selected, all, ids } = s;
  const off = disabled || s.working;
  const choice = (k: string, o: { badge?: string; why?: string; label?: string; brief?: boolean } = {}) => (
    <StageRow key={k} mode="select" compact plain={!all} brief={o.brief ?? false} stage={s.row(k)} locked={k !== current && lockedSet.has(k)} lockedBy={ids.locked} selected={selected === k} badge={o.badge} why={o.why} label={o.label} disabled={off} onPick={() => s.pick(k)} />
  );
  const also = (offer?.alsoOffer ?? []).filter((a) => a.stage !== current && a.stage !== offer?.stage);
  const anyLocked = all ? lockedSet.size > 0 : offerLocked || also.some((a) => a.locked || lockedSet.has(a.stage));
  return (
    <>
      {anyLocked ? (
        <p id={ids.locked} className="rounded-xl bg-warn-soft px-3 py-2 text-[14px] text-ink">
          <span className="font-semibold">Reach them first.</span> The locked stages open once you reach {s.first} with a call, text, email or a reply in their website chat. Something logged from outside Realty OS does not count.
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <div role="radiogroup" aria-label="Stage" className="flex flex-col gap-1">
          {all ? (
            s.guide.map((g) => choice(g.key, { badge: g.key === current ? 'Current' : g.key === offer?.stage ? 'Suggested' : undefined, why: g.key === offer?.stage ? offer.why : undefined }))
          ) : (
            <>
              {offer ? (
                offerLocked ? (
                  <StageRow mode="select" compact plain stage={s.row(offer.stage)} locked lockedBy={ids.locked} why={offer.why} onPick={() => undefined} />
                ) : (
                  choice(offer.stage, { badge: 'Suggested', why: offer.why })
                )
              ) : null}
              {choice(current, { label: `Keep ${s.labelOf(current)}`, brief: true })}
              {also.map((a) => (a.locked || lockedSet.has(a.stage) ? <StageRow key={a.stage} mode="select" compact plain stage={s.row(a.stage)} locked lockedBy={ids.locked} onPick={() => undefined} /> : choice(a.stage)))}
            </>
          )}
        </div>
        {all ? null : (
          <Button variant="quiet" className="self-start px-3" aria-expanded={false} disabled={off} onClick={s.showAll}>
            Another stage…
          </Button>
        )}
      </div>
      <StagePreviewBlock contactId={s.contactId} to={selected} effectId={ids.effect} />
      {s.refused ? <Notice tone="warn">This stage is locked for now: reach {s.first} first (a call, text, email or reply in their website chat).</Notice> : null}
      <FollowUpChips f={s.follow} disabled={off} />
    </>
  );
}

export function StageStep(props: StageStepProps) {
  const { contactId, contactName, saved, onClose } = props;
  const s = useStageStep(contactId, contactName, props);
  const title = `Stage for ${contactName}`;
  if (!s.details || !s.canEdit) {
    // still reading, could not read, or someone who may not change the stage: what was saved, and no stage control.
    // While reading, the sheet already has the shape it will have (the header's Close, focus on the dialog itself), so
    // focus is not lost when the choices arrive.
    const reading = !s.details && !s.failed;
    return (
      <Dialog
        title={title}
        onClose={onClose}
        closeButton={reading}
        footer={
          reading ? undefined : (
            <Button block variant="secondary" onClick={onClose}>
              Done
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-3">
          <Saved text={saved} />
          {!s.details ? s.failed ? <Notice tone="error">{s.failed}</Notice> : <p className="text-[15px] text-ink-muted">Loading</p> : <p className="text-[15px] text-ink">The stage stays {s.details.stage.label}. Only someone who can edit this person changes it.</p>}
        </div>
      </Dialog>
    );
  }
  const confirm = async () => {
    if (await s.finish({ saved })) onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      closeButton
      footer={
        <div className="flex flex-col gap-2">
          {s.failure ? <Notice tone="error">{s.failure}</Notice> : null}
          <Button block pending={s.working} disabled={s.blocked} aria-describedby={s.ids.effect} onClick={() => void confirm()} data-testid="stage-step-confirm">
            {s.primary}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <Saved text={saved} />
        <StageStepBody s={s} />
        <NeverNote className="mt-3" />
      </div>
    </Dialog>
  );
}
