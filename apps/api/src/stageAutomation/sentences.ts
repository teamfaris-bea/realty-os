// The sentences of a stage entry's decision (R-STG-3, R-STG-4): one per skip reason, in the words the contact page
// shows. Pure. A sentence never says a plan "started" where it did not, and never names a plan the viewer may not
// see: the caller passes the plan's name as that viewer is shown it (planNames.ts).
//
// `tense`: 'will' before the change (the preview: "will not start"), 'did' after it (the status: "did not start").
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, sourceRefusalSentence } from '../leads/automatedContact.js';
import { type SkipReason, isSkipReason } from './decide.js';

export type Tense = 'will' | 'did';

/** Why, as the clause after "<Plan> will not start: ". The two source reasons reuse the source refusal's own sentence. */
const WHY: Record<Exclude<SkipReason, 'source_no_automated_contact' | 'source_unclassified'>, string> = {
  not_a_person_change: 'an import or the system changed the stage, not a person.',
  protected_audience: 'the stage was changed in bulk for a list built from a protected tag.',
  person_removed: 'this person was deleted or merged into another record.',
  stage_changed_again: 'the stage changed again before the plan could start.',
  not_visible: 'whoever changed the stage can no longer see this person.',
  plan_not_approved: 'it has no approved version yet, and only an approved plan runs.',
  already_in_a_plan: 'they are already in a plan, and a person is in one plan at a time.',
  cannot_be_reached: 'they opted out, are marked do not contact, or have no phone or email this plan could use.',
  ai_isa_active: 'AI follow-up is working with this person now, and a plan does not run beside it.',
  undo: 'this change was an undo, and an undo never starts a plan.',
};

export function skipSentence(reason: SkipReason, plan: string, tense: Tense): string {
  const head = `${cap(plan)} ${tense === 'will' ? 'will not start' : 'did not start'}`;
  if (reason === 'source_no_automated_contact') return `${head}. ${sourceRefusalSentence(SOURCE_NO_AUTOMATED_CONTACT)}`;
  if (reason === 'source_unclassified') return `${head}. ${sourceRefusalSentence(SOURCE_UNCLASSIFIED)}`;
  return `${head}: ${WHY[reason]}`;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** "<Plan> started." (only ever said of a decision row whose outcome is `started`). */
export function startedSentence(plan: string): string {
  return `${cap(plan)} started.`;
}

/** What a decision row says after the change, in the past tense. An unknown reason says only that it did not start. */
export function decisionSentence(d: { outcome: 'started' | 'skipped'; reason: string | null }, plan: string): string {
  if (d.outcome === 'started') return startedSentence(plan);
  return d.reason !== null && isSkipReason(d.reason) ? skipSentence(d.reason, plan, 'did') : `${cap(plan)} did not start.`;
}

// ---- why a plan is not moving (playbook_enrollments.pause_reason / stop_reason) ---------------------------------

const PAUSED: Record<string, string> = {
  manual: 'Paused by someone on the team. Resume it when you are ready.',
  client_reply: 'Paused because they replied. Read the reply, then resume the plan if it still fits.',
  owner_change: 'Paused because this person has a new owner.',
  opt_out: 'Paused because they opted out. A plan never resumes over an opt-out.',
  wrong_number: 'Paused because their number was reported as a wrong number.',
  approval_revoked: "Paused because the plan's approval was withdrawn. It needs a newly approved version.",
  ineligible: 'Paused because the plan could not run for this person.',
};

/** Why a paused plan is paused (`code` is the stored pause reason). */
export function pausedSentence(code: string): string {
  return PAUSED[code] ?? 'Paused.';
}

const STOPPED: Record<string, string> = {
  manual: 'Stopped by someone on the team.',
  replaced: 'Stopped because they were moved to another plan.',
  contact_removed: 'Stopped because this person was deleted.',
  merged: 'Stopped because this person was merged into another record.',
  ai_isa_started: 'Stopped because AI follow-up started for this person.',
  wrong_number: 'Stopped because their number was reported as a wrong number.',
  source_no_automated_contact: `Stopped. ${sourceRefusalSentence(SOURCE_NO_AUTOMATED_CONTACT)}`,
  source_unclassified: `Stopped. ${sourceRefusalSentence(SOURCE_UNCLASSIFIED)}`,
  'stop_if:appointment_booked': 'Stopped because an appointment was booked.',
  'stop_if:deal_opened': 'Stopped because a deal was opened.',
  'stop_if:deal_closed': 'Stopped because their deal closed.',
  'stop_if:listing_inactive': 'Stopped because the listing is no longer active.',
  'stop_if:event_canceled': 'Stopped because the event it was for was canceled.',
};

/** Why a stopped plan stopped (`code` is the stored stop reason). */
export function stoppedSentence(code: string): string {
  return STOPPED[code] ?? 'Stopped.';
}
