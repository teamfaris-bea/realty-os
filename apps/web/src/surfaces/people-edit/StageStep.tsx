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
// A partial save is said exactly (E775; b19 Today fix 1, R-TODAY-11): when the follow-up, the stage change or the
// closing of an earlier task fails after something was saved, the sheet stays open and says in one sentence what was
// saved and what was not (partialSave.ts), with the server's reason; the button stays enabled, and a retry finishes
// only what is left.
//
// Nothing is created or closed unseen (R-TODAY-11). What the one button will ADD (the follow-up task) and what it will
// MARK DONE (an earlier follow-up, only by core's rule decideTaskReplacement) is named in the sheet's PINNED footer,
// directly under the button and described-by it, so it is on screen before the tap on the smallest phone. The earlier
// task is closed LAST, after the follow-up and the stage have saved.
import { type StageSignal, decideTaskReplacement, suggestStageFromOutcome, suggestedFollowUpDays } from '@realty/core/parity/people';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { useApi } from '../../shell/index.js';
import { whenWords as dayWords } from '../feed/lib/followUp.js';
import { type Details, type StageGuideRow, detailsKey, firstNameOf, guideOf, labelIn } from './api.js';
import { FollowUpChips, followUpKeyForDays, followUpSavedText, morningIn, useFollowUp } from './FollowUp.js';
import { peopleMessage, usePersonAction, useToast } from './hooks.js';
import { StageRow } from './StageChoices.js';
import { type PartialSave, partialSaveWords, unsureReason } from './partialSave.js';
import { NeverNote, StagePreviewBlock } from './StagePreview.js';
import { type StageResponse, type SuggestedStage, effectLabel, joinWords, useStagePreview, whenWords } from './stageFlow.js';
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
  /** R-TODAY-7: the sheet was opened from Today or the global "Log a call or conversation" entry (see OnePassOptions) */
  onePass?: OnePassOptions | undefined;
}

/**
 * One pass from Today or from any screen (R-TODAY-7; feed/OnePass.tsx). The step is the SAME one the person's page
 * uses; these only say how it opens and what else its one button does:
 *   - a follow-up is PRESELECTED from the outcome (core suggestedFollowUpDays: tomorrow after a voicemail or no
 *     answer, 3 days after a text or email, a week after a conversation). The line above the chips says the exact task,
 *     and the pinned footer names it under the button ("Adds: …"); None removes it. Nothing is created before the tap;
 *   - `cardTask`: the task the card or row was about. Core's rule (decideTaskReplacement, R-TODAY-11) decides whether
 *     the new follow-up replaces it: only the card's own follow-up or callback, only once its deadline has passed, and
 *     only by a later follow-up. Then the same tap marks it done, LAST, and the footer says so first ("Marks done:
 *     …"). Otherwise it stays open, and the footer says the person will have two follow-ups;
 *   - the closing toast says the whole result once ("Voicemail logged. Stage: Trying to reach. Follow-up saved …").
 */
export interface OnePassOptions {
  /** the outcome's signal, when `signal` is not given because the server answered the stage suggestion itself (a call) */
  followUpSignal?: StageSignal | null | undefined;
  cardTask?: CardTask | null | undefined;
}

/** The task a follow-up card or a row of the daily plan is about, as GET /feed says it (its `nextPromise`). */
export interface CardTask {
  taskId: string;
  title: string;
  /** tasks.kind */
  kind: string;
  dueAt: string | null;
  dueAllDay: boolean;
  /** when it stops being on time (the server's own deadline); null or absent: undated, or an older server: never replaced */
  deadlineAt: string | null | undefined;
}

/** "today 2:10 PM", "yesterday", "Tue" for a time that has passed; "tomorrow 10:48 AM" for one ahead; a day alone for an all-day task. */
function taskDueWords(t: Pick<CardTask, 'dueAt' | 'dueAllDay'>, now: number): string | null {
  if (t.dueAt === null) return null;
  const at = Date.parse(t.dueAt);
  if (!Number.isFinite(at)) return null;
  if (t.dueAllDay) return dayWords(t.dueAt, now).replace(/^today .*$/, 'today');
  return dayWords(t.dueAt, now, { time: at > now });
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
    <p role="status" data-testid="stage-step-saved" className="rounded-xl bg-ok-soft px-3 py-1 text-[15px] font-medium text-ink [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}

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
  // what the last tap saved and what it did not (null: nothing failed since the last tap). Kept as facts and worded at
  // render, so the sentence stays true when the saved follow-up is then changed or removed with its own controls.
  const [failure, setFailure] = useState<PartialSave | null>(null);
  const stage = useStageChange(contactId, labelOf);
  const toast = useToast();
  const ids = { locked: useId(), effect: useId(), tap: useId() };
  const first = firstNameOf(contactName);
  // R-TODAY-7: in a one-pass sheet the follow-up the outcome suggests is preselected (never on the person's page)
  const onePass = src.onePass;
  const suggestedDays = onePass && (src.active ?? true) ? suggestedFollowUpDays(onePass.followUpSignal ?? src.signal ?? null) : null;
  // M1: what the screen says about the follow-up is the task the server answered (FollowUp.tsx)
  const follow = useFollowUp(contactId, first, { suggested: followUpKeyForDays(suggestedDays) });
  const cardTask = onePass?.cardTask ?? null;
  const closer = usePersonAction<{ task: { id: string; status: string } }>(contactId);
  // the earlier task was marked done by this sheet (a retry does not ask again)
  const [replaced, setReplaced] = useState(false);
  // the stage change this sheet's button already made (a retry does not send it again); its toast is held until the
  // rest of the tap has saved, or the sheet is left
  const [stageSaved, setStageSaved] = useState<{ data: StageResponse; from: string; to: string } | null>(null);

  const preview = useStagePreview(contactId, canEdit && (src.active ?? true) ? selected : null);
  // never a control the server would refuse: the change waits for its preview, and a refused one cannot be sent
  const stagePending = selected !== current && stageSaved === null;
  const refused = stagePending && preview.data !== undefined && !preview.data.allowed;
  const waiting = stagePending && preview.isPending;

  // R-TODAY-11: what the one button will add and close, decided by core's rule from what is on screen NOW. `finish`
  // acts on exactly this (it is the same render's value), so nothing is closed that was not named before the tap.
  const nowMs = Date.now();
  const newDueAt = follow.stored ? (follow.stored.dueAt ? Date.parse(follow.stored.dueAt) : null) : follow.due && follow.dueOk ? follow.due.getTime() : null;
  const deadline = cardTask?.deadlineAt ? Date.parse(cardTask.deadlineAt) : null;
  const replacement = decideTaskReplacement({ task: cardTask ? { isCardTask: true, kind: cardTask.kind, deadline: deadline !== null && Number.isFinite(deadline) ? deadline : null } : null, newDueAt: newDueAt !== null && Number.isFinite(newDueAt) ? newDueAt : null, now: nowMs });
  const willClose = cardTask !== null && replacement.replace && !replaced;
  const adds = follow.willAdd && follow.due !== null && follow.dueOk;
  const tapEffects = (() => {
    const parts: string[] = [];
    if (adds && follow.due) parts.push(`Adds: ${follow.title}, ${follow.due.getTime() > nowMs ? whenWords(follow.due.toISOString(), nowMs) : dayWords(follow.due.toISOString(), nowMs, { time: true })}.`);
    if (cardTask && willClose) {
      const was = taskDueWords(cardTask, nowMs);
      parts.push(`Marks done: ${cardTask.title}${was ? ` (was due ${was})` : ''}.`);
    } else if (cardTask && adds && !replacement.replace) {
      const due = taskDueWords(cardTask, nowMs);
      parts.push(replacement.twoFollowUps ? `${first} will have two follow-ups: “${cardTask.title}” (${due ? `due ${due}` : 'no date set'}) stays open.` : `Stays open: ${cardTask.title}.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  })();

  /**
   * The follow-up, then the stage change, then LAST the earlier task the new follow-up replaces. `saved`: what is
   * already stored, in words (for the sentence of a partial save). `lead`: words the closing toast starts with (the
   * Log sheet's "Call logged": that sheet has no banner left once it closes). Resolves true when everything asked for
   * was done; the caller then closes the sheet. On a failure the sheet says what was saved and what was not
   * (partialSave.ts) and the next tap does only what is left.
   */
  const finish = async (o: { saved: string; lead?: string | undefined }): Promise<boolean> => {
    if (busy.current || done.current) return false;
    busy.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const still = labelOf(current);
      const earlier = (state: 'failed' | 'unsure' | 'not_tried') => (willClose && cardTask ? { title: cardTask.title, state } : undefined);
      const why = (r: { message: string; uncertain: boolean }) => (r.uncertain ? unsureReason(r.message) : r.message);
      // 1. the follow-up (a stored one is answered again, never made twice: FollowUp.tsx)
      const f = await follow.save();
      if (!f.ok) {
        // a lost answer is not a refusal: the task may be stored (the retry then answers it)
        setFailure({ before: o.saved, followUp: { state: f.uncertain ? 'unsure' : 'failed' }, stage: stagePending ? { state: 'not_tried', label: still } : undefined, earlier: earlier('not_tried'), reason: why(f) });
        return false;
      }
      const followUp = f.task ? ({ state: 'saved', text: followUpSavedText(f.task) } as const) : undefined;
      // 2. the stage (its toast is held: the tap is not finished)
      let st = stageSaved;
      if (stagePending) {
        const r = await stage.change(selected, { from: current, hold: true });
        if (!r.ok) {
          // refused: the stage did not change. A lost answer: nobody knows yet; the retry reads what is stored (E780)
          setFailure({ before: o.saved, followUp, stage: { state: r.uncertain ? 'unsure' : 'failed', label: still }, earlier: earlier('not_tried'), reason: why(r) });
          return false;
        }
        st = { data: r.data, from: current, to: selected };
        setStageSaved(st);
      }
      // 3. LAST, the earlier task the new follow-up replaces (only what the footer named before this tap)
      let closed = replaced;
      if (willClose && cardTask && f.task) {
        const d = await closer.run('PATCH', `/tasks/${cardTask.taskId}`, { status: 'done' });
        if (!d.ok) {
          setFailure({ before: o.saved, followUp, stage: st ? { state: 'saved', label: st.data.stage.label } : undefined, earlier: { title: cardTask.title, state: d.uncertain ? 'unsure' : 'failed' }, reason: why(d) });
          return false;
        }
        closed = true;
        setReplaced(true);
      }
      // everything asked for is saved: the one toast says all of it
      const also = joinWords([f.task ? followUpSavedText(f.task) : undefined, closed && cardTask ? `Marked done: “${cardTask.title}”` : undefined]) || undefined;
      if (st) stage.say(st.data, { to: st.to, from: st.from, lead: o.lead, also });
      else {
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

  /**
   * The sheet is being closed by the agent. When a stage change of this sheet is saved and its toast was still held
   * (something after it failed), the toast is shown now, so what WAS saved is said once and the stage keeps its Undo.
   * It claims nothing that did not save: the earlier task is said to be still open.
   */
  const leave = (o: { lead?: string | undefined } = {}) => {
    if (done.current || stageSaved === null) return;
    done.current = true;
    const also = joinWords([follow.stored ? followUpSavedText(follow.stored) : undefined, willClose && cardTask ? `Still open: “${cardTask.title}”` : undefined]) || undefined;
    stage.say(stageSaved.data, { to: stageSaved.to, from: stageSaved.from, lead: o.lead, also });
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
    /** the partial save in words; a follow-up it names is the task as it is stored NOW (changed since: the new date; removed: not named) */
    failure: failure === null ? null : partialSaveWords({ ...failure, followUp: failure.followUp?.state === 'saved' ? (follow.stored ? { state: 'saved', text: followUpSavedText(follow.stored) } : undefined) : failure.followUp }),
    ids,
    refused,
    /**
     * The button is named for its effect on the stage, and stays short enough for one line on a phone: "Change to
     * Connected", "Keep New lead". The task it adds and the task it marks done are named under it (`tapEffects`).
     * Once this sheet's stage change is saved and only the rest is left: "Try again".
     */
    primary: stageSaved ? 'Try again' : effectLabel(selected, current, labelOf),
    /** R-TODAY-11: what the tap will add and mark done, for the pinned footer (null: neither) */
    tapEffects,
    /** this sheet's stage change is saved: the stage choices are settled */
    stageSaved: stageSaved !== null,
    onePass: onePass !== undefined,
    blocked: refused || waiting || !follow.dueOk,
    finish,
    leave,
  };
}

export type StageStepState = ReturnType<typeof useStageStep>;

/** The step's choices, the one effect line and the follow-up, in that order (for someone who may edit). */
export function StageStepBody({ s, disabled = false, followUpNote }: { s: StageStepState; disabled?: boolean; /** E790: the sheet already makes this log's one follow-up another way (the Log sheet's "Remind me"): said here in place of the chips */ followUpNote?: string | undefined }) {
  const { offer, offerLocked, current, lockedSet, selected, all, ids } = s;
  const off = disabled || s.working || s.stageSaved;
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
      {followUpNote ? (
        <p className="text-[14px] leading-snug text-ink [overflow-wrap:anywhere]" data-testid="follow-up-line">
          {followUpNote}
        </p>
      ) : (
        <FollowUpChips f={s.follow} disabled={off} />
      )}
    </>
  );
}

/**
 * R-TODAY-11: what the one button will add and mark done, directly under it in the sheet's pinned footer (the button
 * is described by it). Null when the tap adds and closes nothing.
 */
export function TapEffects({ s }: { s: Pick<StageStepState, 'tapEffects' | 'ids'> }) {
  if (!s.tapEffects) return null;
  return (
    <p id={s.ids.tap} data-testid="tap-effects" className="text-[14px] leading-snug text-ink [overflow-wrap:anywhere]">
      {s.tapEffects}
    </p>
  );
}

/** The ids the one button is described by: the plan's one effect line, and what the tap adds and marks done. */
export function describedBy(s: Pick<StageStepState, 'tapEffects' | 'ids'>): string {
  return s.tapEffects ? `${s.ids.effect} ${s.ids.tap}` : s.ids.effect;
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
  // R-TODAY-7: away from the person's page the closing toast is the only place the result stays: it says all of it
  const lead = s.onePass ? { lead: saved } : {};
  const confirm = async () => {
    if (await s.finish({ saved, ...lead })) onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={() => {
        // left after a partial save: what was saved is said once, with the stage's Undo
        s.leave(lead);
        onClose();
      }}
      closeButton
      footer={
        <div className="flex flex-col gap-2">
          {s.failure ? <Notice tone="error">{s.failure}</Notice> : null}
          <Button block pending={s.working} disabled={s.blocked} aria-describedby={describedBy(s)} onClick={() => void confirm()} data-testid="stage-step-confirm">
            {s.primary}
          </Button>
          <TapEffects s={s} />
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
