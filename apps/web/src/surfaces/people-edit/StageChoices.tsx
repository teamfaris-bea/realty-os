// One stage as a choice, wherever a stage is chosen (the stage pill's picker, the stage step after an outcome):
// its label, its one-line definition and, in smaller type, what the stage does NOT mean (R-STG-1). A new agent
// reads what is true of a person in the stage before picking it.
//
// - The label wraps; nothing here truncates (a team's own label can be 24 characters, on a 320 px screen).
// - The control is named by the label and its state ("Trying to reach Current", "Connected Locked") and described by
//   the two lines, the effect line and, when locked, the "Reach them first" explanation (R-PAR-14): a locked stage is
//   shown locked before the tap and is never selectable.
// - `effect`: what choosing it would do to the person's automated plan (StagePreview.tsx), when the caller knows.
// - `compact` (a set of choices in a sheet on a phone): the "does not mean" line shows on demand, for the selected
//   choice, so the choices and what the selected one will do fit one screen. The definition always shows.
// - `brief` ("Keep <current>" in that sheet): the person is in this stage now, so only its label shows.
// - `plain` (the few choices a sheet opens with): the "does not mean" line is left to "Another stage…", where every
//   stage shows it on demand, so what the suggested choice will do and the follow-up stay above the fold on a phone.
import { type ReactNode, useId } from 'react';
import type { StageGuideRow } from './api.js';

export interface StageRowProps {
  stage: StageGuideRow;
  /** the person is in this stage now */
  current?: boolean;
  /** the stage rule refuses it for this viewer now (R-PAR-14) */
  locked?: boolean;
  /** the id of the element that says why locked stages are locked */
  lockedBy?: string | undefined;
  /** a word beside the label ("Suggested") */
  badge?: string | undefined;
  /** one more line under the definition (why it is suggested) */
  why?: string | undefined;
  /** what choosing it would do (a plan starts, or does not and why) */
  effect?: ReactNode;
  disabled?: boolean;
  /** 'pick': tapping it chooses the stage at once. 'select': one of a set, `selected` is the chosen one. */
  mode: 'pick' | 'select';
  selected?: boolean;
  /** the visible label, when it is not the stage's own ("Keep New lead") */
  label?: string | undefined;
  /** show the "does not mean" line only while this choice is selected */
  compact?: boolean;
  /** the label alone: no definition and no "does not mean" line */
  brief?: boolean;
  /** never the "does not mean" line (it shows in the full list) */
  plain?: boolean;
  onPick(): void;
}

export function StageRow({ stage, current = false, locked = false, lockedBy, badge, why, effect, disabled = false, mode, selected = false, label, compact = false, brief = false, plain = false, onPick }: StageRowProps) {
  const id = useId();
  const showDef = !brief;
  const showNot = showDef && !plain && (!compact || selected);
  const state = locked ? 'Locked' : current && mode === 'pick' ? 'Current' : (badge ?? '');
  const describedBy = [showDef ? `${id}-d` : null, showNot ? `${id}-n` : null, why ? `${id}-w` : null, effect ? `${id}-e` : null, locked ? lockedBy : null].filter(Boolean).join(' ');
  const on = mode === 'select' ? selected : current;
  return (
    <button
      type="button"
      role={mode === 'select' ? 'radio' : undefined}
      aria-checked={mode === 'select' ? selected : undefined}
      aria-current={mode === 'pick' && current ? 'true' : undefined}
      aria-labelledby={state ? `${id}-l ${id}-s` : `${id}-l`}
      aria-describedby={describedBy}
      disabled={locked || disabled}
      onClick={onPick}
      className={`flex min-h-tap w-full flex-col justify-center gap-0.5 rounded-xl border px-3 py-2 text-left ${on ? 'border-accent bg-accent-soft' : 'border-transparent'} ${mode === 'select' && !on ? 'border-line' : ''} disabled:opacity-70`}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span id={`${id}-l`} className={`min-w-0 text-[17px] text-ink [overflow-wrap:anywhere] ${on ? 'font-semibold' : 'font-medium'}`}>
          {label ?? stage.label}
        </span>
        {state ? (
          <span id={`${id}-s`} className="shrink-0 pt-0.5 text-[14px] font-medium text-ink-muted">
            {state}
          </span>
        ) : null}
      </span>
      {showDef ? (
        <span id={`${id}-d`} className="text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
          {stage.definition}
        </span>
      ) : null}
      {showNot ? (
        <span id={`${id}-n`} className="text-[13px] leading-snug text-ink-muted [overflow-wrap:anywhere]">
          {stage.notThis}
        </span>
      ) : null}
      {why ? (
        <span id={`${id}-w`} className="text-[14px] leading-snug text-ink [overflow-wrap:anywhere]">
          {why}
        </span>
      ) : null}
      {effect ? (
        <span id={`${id}-e`} className="text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">
          {effect}
        </span>
      ) : null}
    </button>
  );
}
