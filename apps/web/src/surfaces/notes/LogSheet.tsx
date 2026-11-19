// Log an outside call, text or email (PARITY_PLAN §5: Log (Call preselected) → outcome → one button = 3 taps).
// It is a note, never a call or message record and never a touch (R-PAR-30, R-PAR-32): the sheet says so.
// "Remind me in N days" makes an ordinary task. If the note reads like "they asked not to be contacted",
// the sheet asks, and offers the real person-level do-not-contact: a note alone never blocks anything (E193).
//
// The stage step, in place (R-STG-2; b19 fix pass M6, E775). Choosing an outcome reveals the stage step in THIS sheet
// (people-edit/StageStep.tsx): the stage the outcome suggests, to confirm, what the choice will do, and a follow-up.
// The suggestion shown before the save is core's own (activitySignal + suggestStageFromOutcome, the functions the log
// route answers its suggestion with) against the person's details read when the sheet opened. ONE primary button
// then does both, in order: it saves the log ("Save and change to Trying to reach", "Save and keep New lead"), then
// the follow-up and the stage. So Log → outcome → that button is 3 taps to a confirmed stage.
//
//   - The log's id is made once per sheet: a second tap or a retry of the button answers the same note (R-STG-6).
//   - Once the log is saved the sheet says so ("Call logged (left voicemail)") in place of the fields, and the button
//     is named for what is left ("Change to Trying to reach"). When the stage change (or the follow-up) fails after
//     the log saved, the sheet stays open and says exactly what was saved and what was not, with the server's reason;
//     the button stays enabled and a retry never makes a second note.
//   - A call logged with no outcome suggests nothing: no stage step, the button is "Save", and the sheet closes.
//   - Nothing is said twice: the toast after the sheet closes is the only place the save is confirmed.
//   - One follow-up per log (E790): "Remind me" and the stage step's Follow-up are never both set, and a replayed log
//     says its reminder from the server's answer (the first save's task), never from this sheet's select.
//   - When the server says the note reads like a do-not-contact request, the stage is NOT changed by that tap: the
//     sheet asks first. "No" comes back to the saved log with the stage step still to confirm.
import { ACTIVITY_MAX_AHEAD_MS, CALL_OUTCOMES, activitySignal, suggestsDoNotContact } from '@realty/core/parity/people';
import { useId, useRef, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { firstNameOf } from '../people-edit/api.js';
import { Chip, selectClass, textareaClass, usePersonAction, useToast } from '../people-edit/hooks.js';
import { NeverNote } from '../people-edit/StagePreview.js';
import { type OnePassOptions, Saved, StageStepBody, useStageStep } from '../people-edit/StageStep.js';
import { type SuggestedStage, joinWords } from '../people-edit/stageFlow.js';

const KINDS = [
  { key: 'call', label: 'Call' },
  { key: 'text', label: 'Text' },
  { key: 'email', label: 'Email' },
] as const;
export const OUTCOME_LABEL: Record<(typeof CALL_OUTCOMES)[number], string> = { connected: 'Talked', left_voicemail: 'Left voicemail', no_answer: 'No answer', wrong_number: 'Wrong number', other: 'Other' };
const REMIND = [0, 1, 2, 3, 7, 14, 30];

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * One-tap times for "when did it happen" (R-TODAY-9): now, an hour ago, and this morning (9:00) once the morning has
 * passed. Each is a time today, never in the future; the field under them shows the exact time and stays editable.
 */
export function whenPresets(now: Date): { key: string; label: string; at: Date }[] {
  const out = [{ key: 'now', label: 'Just now', at: now }];
  const hourAgo = new Date(now.getTime() - 3_600_000);
  if (hourAgo.getDate() === now.getDate()) out.push({ key: 'hour', label: 'An hour ago', at: hourAgo });
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  if (now.getTime() - morning.getTime() > 3_600_000) out.push({ key: 'morning', label: 'This morning', at: morning });
  return out;
}

export function LogSheet({ contactId, contactName, onClose, onePass }: { contactId: string; contactName: string; onClose: () => void; /** R-TODAY-7: opened from Today or the global entry (StageStep.tsx OnePassOptions) */ onePass?: OnePassOptions | undefined }) {
  const [kind, setKind] = useState<'call' | 'text' | 'email'>('call');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number] | null>(null);
  const [when, setWhen] = useState(() => localInputValue(new Date()));
  // false: the agent left "when" at now, so the log carries the instant of the save itself. (The field holds whole
  // minutes: sent as it reads, a call logged "just now" would be dated before a note written seconds earlier.)
  const [whenChosen, setWhenChosen] = useState(false);
  const [body, setBody] = useState('');
  const [remind, setRemind] = useState(0);
  // the chips shown again after an outcome folded them into one line
  const [editing, setEditing] = useState(false);
  // 'asked': the agent opened the question themselves, nothing is saved yet; 'suggested': the server asked after the save
  const [askDnc, setAskDnc] = useState<'asked' | 'suggested' | null>(null);
  const act = usePersonAction<{ suggestDoNotContact: boolean; taskId: string | null; suggestedStage?: SuggestedStage | null; replayed?: boolean }>(contactId);
  // R-STG-6: one id for whatever this sheet logs; the server answers the same note for it again
  const noteId = useRef<string>(globalThis.crypto.randomUUID());
  // the log as the server stored it, in words (null: not saved yet)
  const [saved, setSaved] = useState<string | null>(null);
  const busy = useRef(false);
  const done = useRef(false);
  const [working, setWorking] = useState(false);
  const dnc = usePersonAction<{ alreadySet: boolean }>(contactId);
  const toast = useToast();
  const first = firstNameOf(contactName);
  const ids = { when: useId(), body: useId(), remind: useId() };
  const at = new Date(when);
  const future = Number.isFinite(at.getTime()) && at.getTime() > Date.now() + ACTIVITY_MAX_AHEAD_MS;

  // The stage step. An outcome is what reveals it: a call's outcome chip, or a text or email (its own outcome).
  const hasOutcome = kind !== 'call' || outcome !== null;
  const step = useStageStep(contactId, contactName, { signal: activitySignal({ kind, direction, outcome }), active: hasOutcome, onePass });
  const stepOn = hasOutcome && step.canEdit;
  // the outcome is chosen and the person is still being read: the button waits, so the step is never skipped by a fast tap
  const stepPending = hasOutcome && step.details === null && step.failed === null;
  const folded = saved === null && kind === 'call' && outcome !== null && !editing;
  // E790: one follow-up per log. "Remind me" (a task the log route makes with the note) and the stage step's
  // Follow-up (a task of its own) are the same thing to the agent, so only one of them is ever set: with a reminder
  // chosen the step shows no chips, and with a chip chosen (or its task already saved) "Remind me" is off.
  const stepFollowUp = stepOn && (step.follow.key !== 'none' || step.follow.stored !== null);
  const reminding = remind > 0 && !stepFollowUp;

  const kindLabel = KINDS.find((k) => k.key === kind)!.label;
  // R-TODAY-9: said as what it was, a call or text from the agent's own phone (never as something the app placed)
  const directionLabel = (d: 'outbound' | 'inbound') => (d === 'outbound' ? (kind === 'call' ? 'I called from my phone' : kind === 'text' ? 'I texted from my phone' : 'I emailed') : kind === 'call' ? `${first} called me` : kind === 'text' ? `${first} texted me` : `${first} emailed me`);
  // "when": now unless the agent says otherwise; "earlier today" is one tap, and the exact time stays editable below
  const presets = whenPresets(new Date());

  const run = async () => {
    if (busy.current || done.current) return;
    busy.current = true;
    setWorking(true);
    try {
      let words = saved;
      if (words === null) {
        const r = await act.run('POST', `/contacts/${contactId}/activities`, {
          kind,
          direction,
          at: (whenChosen ? at : new Date()).toISOString(),
          ...(kind === 'call' && outcome ? { outcome } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(reminding ? { remindInDays: remind } : {}),
          noteId: noteId.current,
        });
        // nothing was saved (or nobody can say): nothing is claimed, and the same tap again is the same note
        if (!r.ok) return;
        // E790: the reminder is said from the server's answer. A first save says the days this sheet asked for; a
        // replay answers the FIRST save's task, whose days this sheet may no longer show, so no number is said.
        const reminder = !r.data.taskId ? '' : r.data.replayed ? ', with the reminder set the first time' : `, reminder in ${remind} day${remind === 1 ? '' : 's'}`;
        const logged = `${kindLabel} logged${reminder}`;
        const what = kind === 'call' && outcome ? `${logged} (${OUTCOME_LABEL[outcome].toLowerCase()})` : logged;
        // a repeat of this sheet's save (a retry after a lost answer) is the note the first one stored
        words = r.data.replayed ? `${what}. Your first tap had already saved it, as first written.` : what;
        setSaved(words);
        if (r.data.suggestDoNotContact) {
          setAskDnc('suggested');
          return;
        }
      }
      if (!stepOn) {
        done.current = true;
        toast({ text: joinWords([words]) });
        onClose();
        return;
      }
      if (await step.finish({ saved: words, lead: words })) {
        done.current = true;
        onClose();
      }
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  const recordDnc = async () => {
    const r = await dnc.run('POST', `/contacts/${contactId}/do-not-contact`, { reason: kind === 'call' ? 'asked_on_call' : 'asked_in_writing' });
    if (!r.ok) return;
    toast({ text: `Recorded: do not contact ${first}` });
    onClose();
  };

  if (askDnc) {
    // "No": back to the sheet when something is left to do there (the unsaved log, or the stage still to confirm)
    const back = askDnc === 'asked' || stepOn;
    const no = () => {
      if (back) {
        setAskDnc(null);
        return;
      }
      if (saved) toast({ text: joinWords([saved]) });
      onClose();
    };
    return (
      <Dialog
        title={`Did ${first} ask not to be contacted?`}
        description={`${saved !== null ? `Your note was saved${stepOn ? ', and the stage was not changed' : ''}. ` : ''}A note alone doesn’t stop anything from being sent.`}
        onClose={no}
        footer={
          <div className="flex flex-col gap-2">
            <Button block onClick={() => void recordDnc()} pending={dnc.pending}>
              Yes, record do not contact
            </Button>
            <Button block variant="secondary" onClick={no}>
              No
            </Button>
          </div>
        }
      >
        <p className="text-[15px] text-ink">Recording it stops every text, email and call to {first} from anyone on the team. Only {first} can undo it.</p>
        {dnc.error ? <Notice tone="error">{dnc.error}</Notice> : null}
      </Dialog>
    );
  }

  const primary = saved !== null ? step.primary : stepOn ? `Save and ${lowerFirst(step.primary)}` : 'Save';
  return (
    <Dialog
      title={`Log for ${contactName}`}
      description={saved === null && !folded ? `Something that happened outside Realty OS. It shows as logged by you and doesn’t count as reaching ${first}.` : undefined}
      onClose={onClose}
      closeButton
      footer={
        <div className="flex flex-col gap-2">
          {act.error ? <Notice tone="error">{act.error}</Notice> : null}
          {step.failure ? <Notice tone="error">{step.failure}</Notice> : null}
          <Button block onClick={() => void run()} pending={working} disabled={(saved === null && future) || stepPending || (stepOn && step.blocked)} aria-describedby={stepOn ? step.ids.effect : undefined} data-testid="log-save">
            {primary}
          </Button>
        </div>
      }
    >
      <div className={`flex flex-col ${folded || saved !== null ? 'gap-2' : 'gap-3'}`}>
        {saved !== null ? (
          <Saved text={saved} />
        ) : folded ? (
          // what is about to be logged, in one line; "Edit" brings the choices back
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 py-0.5 pl-3 pr-1 text-[15px] text-ink">
            <p className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="log-summary">
              <span className="font-medium">To log:</span> {kindLabel} · {directionLabel(direction)} · {OUTCOME_LABEL[outcome!]}
            </p>
            <Button variant="quiet" className="shrink-0 px-2" aria-label="Edit what happened" disabled={working} onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        ) : (
          <>
            <div role="group" aria-label="What happened" className="flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <Chip key={k.key} selected={kind === k.key} disabled={working} onClick={() => setKind(k.key)}>
                  {k.label}
                </Chip>
              ))}
            </div>
            <div role="group" aria-label="Direction" className="flex flex-wrap gap-2">
              {(['outbound', 'inbound'] as const).map((d) => (
                <Chip key={d} selected={direction === d} disabled={working} onClick={() => setDirection(d)}>
                  {directionLabel(d)}
                </Chip>
              ))}
            </div>
            {kind === 'call' ? (
              <div role="group" aria-label="Outcome" className="flex flex-wrap gap-2">
                {CALL_OUTCOMES.map((o) => (
                  <Chip
                    key={o}
                    selected={outcome === o}
                    disabled={working}
                    onClick={() => {
                      setOutcome(outcome === o ? null : o);
                      setEditing(false);
                    }}
                  >
                    {OUTCOME_LABEL[o]}
                  </Chip>
                ))}
              </div>
            ) : null}
          </>
        )}
        {stepOn ? (
          <StageStepBody s={step} disabled={working} followUpNote={saved === null && reminding ? `Follow-up: the reminder in ${remind} day${remind === 1 ? '' : 's'}, saved with this log.` : undefined} />
        ) : stepPending ? (
          <p className="text-[15px] text-ink-muted">Loading</p>
        ) : hasOutcome && step.details && !step.canEdit ? (
          <p className="text-[15px] text-ink">The stage stays {step.details.stage.label}. Only someone who can edit this person changes it.</p>
        ) : hasOutcome && step.failed ? (
          <p className="text-[15px] text-ink">We couldn’t read this person’s stage, so this sheet only saves the log. {step.failed}</p>
        ) : null}
        {saved === null ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.when} className="text-[15px] font-medium text-ink">
                When
              </label>
              <div role="group" aria-label="When, quickly" className="flex flex-wrap gap-2">
                {presets.map((p) => (
                  // (pressed while the field still holds that time, give or take the minute that may have turned since)
                  <Chip
                    key={p.key}
                    selected={Math.abs(new Date(when).getTime() - p.at.getTime()) < 90_000}
                    disabled={working}
                    onClick={() => {
                      setWhen(localInputValue(p.at));
                      setWhenChosen(p.key !== 'now');
                    }}
                  >
                    {p.label}
                  </Chip>
                ))}
              </div>
              <input
                id={ids.when}
                type="datetime-local"
                value={when}
                onChange={(e) => {
                  setWhen(e.target.value);
                  setWhenChosen(true);
                }}
                className={selectClass}
                aria-invalid={future || undefined}
              />
              {future ? <p className="text-[14px] font-medium text-danger">That time is in the future.</p> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.body} className="text-[15px] font-medium text-ink">
                Note (optional)
              </label>
              <textarea id={ids.body} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} maxLength={20000} />
              {suggestsDoNotContact(body) ? <p className="text-[14px] text-ink-muted">If {first} asked not to be contacted, use “They asked not to be contacted…” below: a note alone doesn’t stop anything.</p> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.remind} className="text-[15px] font-medium text-ink">
                Remind me
              </label>
              <select id={ids.remind} value={stepFollowUp ? 0 : remind} disabled={stepFollowUp} aria-describedby={stepFollowUp ? `${ids.remind}-why` : undefined} onChange={(e) => setRemind(Number(e.target.value))} className={`${selectClass} disabled:opacity-60`}>
                {REMIND.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? 'No reminder' : `In ${d} day${d === 1 ? '' : 's'}`}
                  </option>
                ))}
              </select>
              {stepFollowUp ? (
                <p id={`${ids.remind}-why`} className="text-[14px] text-ink-muted">
                  A follow-up is already set above: one task per log.
                </p>
              ) : null}
            </div>
            <Button variant="quiet" className="self-start px-3" disabled={working} onClick={() => setAskDnc('asked')}>
              They asked not to be contacted…
            </Button>
          </>
        ) : null}
        {stepOn ? <NeverNote /> : null}
      </div>
    </Dialog>
  );
}
