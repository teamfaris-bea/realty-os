// The sentences of a stage entry's decision (R-STG-3, R-STG-4): one per skip reason, in the words the contact page
// shows. Pure. A sentence never says a plan "started" where it did not, and never names a plan the viewer may not
// see: the caller passes the plan's name as that viewer is shown it (planNames.ts).
//
// `tense`: 'will' before the change (the preview: "will not start"), 'did' after it (the status: "did not start").
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, sourceRefusalSentence } from '../leads/automatedContact.js';
import type { SkipReason } from './decide.js';

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
