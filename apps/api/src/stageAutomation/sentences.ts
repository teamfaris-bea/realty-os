// The sentences of a stage entry's decision (R-STG-3, R-STG-4): one per skip reason, in the words the contact page
// shows. Pure. A sentence never says a plan "started" where it did not, and never names a plan the viewer may not
// see: the caller passes the plan's name as that viewer is shown it (planNames.ts).
//
// `tense`: 'will' before the change (the preview: "will not start"), 'did' after it (the status: "did not start").
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, sourceRefusalSentence } from '../leads/automatedContact.js';
import { type SkipReason, type UnreachableCause, isSkipReason, isUnreachableCause } from './decide.js';

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

/**
 * E787: `cannot_be_reached` in its real causes, so a person who texted STOP is told that is the reason. The cause is
 * the one kept with the decision (or read with the preview's facts). Without one (a decision made before the cause
 * was kept) the sentence names all of them, as it always did.
 */
const UNREACHABLE: Record<UnreachableCause, string> = {
  opted_out: 'they texted STOP or otherwise opted out, and a plan never messages over an opt-out.',
  do_not_contact: 'they are marked do not contact.',
  wrong_number: 'their number was reported as a wrong number.',
  no_address: 'they have no phone or email this plan could use.',
};

/**
 * `runningPlan` (the preview only, E763): the plan the person is in now, as the viewer may see its name. With it, an
 * `already_in_a_plan` sentence names that plan and says how to get the new one instead.
 * `cause` (E787): for `cannot_be_reached`, which cause it was; ignored for every other reason.
 */
export function skipSentence(reason: SkipReason, plan: string, tense: Tense, runningPlan?: string, cause?: string | null): string {
  const head = `${cap(plan)} ${tense === 'will' ? 'will not start' : 'did not start'}`;
  if (reason === 'cannot_be_reached' && isUnreachableCause(cause)) return `${head}: ${UNREACHABLE[cause]}`;
  if (reason === 'already_in_a_plan' && runningPlan !== undefined) {
    return `${head}: they are already in ${runningPlan}, and a person is in one plan at a time. Stop ${runningPlan} first if you want ${plan}.`;
  }
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
export function decisionSentence(d: { outcome: 'started' | 'skipped'; reason: string | null; unreachableCause?: string | null }, plan: string): string {
  if (d.outcome === 'started') return startedSentence(plan);
  return d.reason !== null && isSkipReason(d.reason) ? skipSentence(d.reason, plan, 'did', undefined, d.unreachableCause) : `${cap(plan)} did not start.`;
}

// ---- why a plan is not moving (playbook_enrollments.pause_reason / stop_reason) ---------------------------------

// E786: `why` is true for anyone looking. `invite` is said only to a viewer whose own resume request would act (the
// status's canResume): the screen never invites a tap the server would refuse. A pause made with the Pause button is
// "by hand": the enrollment does not record who pressed it, and the person reading may be the one who did.
const PAUSED: Record<string, { why: string; invite?: string }> = {
  manual: { why: 'Paused by hand.', invite: 'Resume it when you are ready.' },
  client_reply: { why: 'Paused because they replied.', invite: 'Read the reply, then resume the plan if it still fits.' },
  owner_change: { why: 'Paused because this person has a new owner.' },
  opt_out: { why: 'Paused because they opted out. A plan never resumes over an opt-out.' },
  wrong_number: { why: 'Paused because their number was reported as a wrong number.' },
  approval_revoked: { why: "Paused because the plan's approval was withdrawn. It needs a newly approved version." },
  ineligible: { why: 'Paused because the plan could not run for this person.' },
};

/** Why the resume route would refuse, for the refusals that are about the plan itself (never about who is asking). */
const CANNOT_RESUME: Record<string, string> = {
  PLAYBOOK_NOT_APPROVED: 'It cannot resume until the plan has an approved version again.',
  PLAYBOOK_OWNER_MISMATCH: 'It cannot resume: the plan belonged to this person’s previous owner.',
  [SOURCE_NO_AUTOMATED_CONTACT]: `It cannot resume. ${sourceRefusalSentence(SOURCE_NO_AUTOMATED_CONTACT)}`,
  [SOURCE_UNCLASSIFIED]: `It cannot resume. ${sourceRefusalSentence(SOURCE_UNCLASSIFIED)}`,
};

/**
 * Why a paused plan is paused (`code` is the stored pause reason), for a viewer who can (`canResume`) or cannot resume
 * it. `refusal`: the resume route's own refusal code for this viewer, when their request reached the plan and the
 * plan could not resume; a viewer who simply may not resume it is told only that it is paused.
 */
export function pausedSentence(code: string, o: { canResume: boolean; refusal?: string | null } = { canResume: false }): string {
  const p = PAUSED[code];
  if (!p) return 'Paused.';
  if (o.canResume) return p.invite ? `${p.why} ${p.invite}` : p.why;
  const cannot = o.refusal ? CANNOT_RESUME[o.refusal] : undefined;
  return cannot ? `${p.why} ${cannot}` : p.why;
}

const STOPPED: Record<string, string> = {
  // E786: by hand (the Stop button). The enrollment does not record who pressed it, so nobody is told "someone".
  manual: 'Stopped by hand.',
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

/**
 * The plan's last message was handed to the carrier or the mail provider and no answer came (R-GATE-8, E753). It is
 * never called sent or delivered, never "not delivered", and never retried: only that it could not be confirmed.
 */
export function deliveryUnconfirmedSentence(channel: string, checking: boolean): string {
  const what = channel === 'email' ? 'email' : 'text';
  // the words E753's three surfaces use: could not be confirmed, may have reached them, check before sending again
  return checking
    ? `Delivery of the plan's last ${what} could not be confirmed yet: it may have reached them. We're still checking, and the plan does not submit it a second time. Check with them before sending it again yourself.`
    : `Delivery of the plan's last ${what} could not be confirmed: it may have reached them. The plan did not submit it a second time. Check with them before sending it again yourself.`;
}
