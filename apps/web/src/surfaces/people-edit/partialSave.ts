// A partial save, said once (b19 Today fix 1, M2; R-TODAY-11). One tap of a sheet's one button may save several
// things in order: the log (already saved when this is said), the follow-up, the stage, and LAST the earlier task the
// new follow-up replaces. When one of them fails the sheet stays open and says, in ONE consistent sentence:
//
//   Saved: call logged (talked) and the follow-up for Thu, Nov 26, 9:00 AM. Not saved: the stage (still New lead).
//   “Follow up with Paula” is still open. <the server's reason>
//
// "Not saved" is said only of something the server REFUSED (or that was never tried because an earlier step failed).
// A lost answer (a network error, a 5xx) is "Not confirmed": nobody can say, the retry asks again and never doubles
// anything, and the reason beside it never says "it wasn't saved" (unsureReason).
import { GENERIC_ERROR_MESSAGE } from '../../shell/errorMessages.js';

export interface PartialSave {
  /** what the step before the button's own work saved, as the sheet says it ("Call logged (left voicemail)") */
  before: string;
  /** the follow-up, when one was asked for: the stored task's own words when it saved */
  followUp?: { state: 'saved'; /** followUpSavedText: "Follow-up saved for Thu, Nov 26, 9:00 AM" */ text: string } | { state: 'failed' | 'unsure' } | undefined;
  /** the stage, when a change was asked for. `label`: the NEW stage's label when saved, otherwise the stage the person is still in */
  stage?: { state: 'saved' | 'failed' | 'unsure' | 'not_tried'; label: string } | undefined;
  /** the earlier task the tap was going to mark done (closed last) */
  earlier?: { title: string; state: 'failed' | 'unsure' | 'not_tried' } | undefined;
  /** the server's reason for the first thing that failed, in words */
  reason: string;
}

/** What is said beside "Not confirmed": the same reason, without a claim that nothing was saved. */
export const UNSURE_GENERIC = 'Something went wrong on our side. Try again in a moment.';
export function unsureReason(message: string): string {
  return message === GENERIC_ERROR_MESSAGE ? UNSURE_GENERIC : message;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const noStop = (s: string) => s.trim().replace(/\.$/, '');
/** "a", "a and b", "a, b and c" */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function partialSaveWords(p: PartialSave): string {
  const saved: string[] = [];
  const notSaved: string[] = [];
  const unsure: string[] = [];
  // a "before" of more than one sentence (a replayed log says so) is said whole, first, and the list goes on after it
  const before = noStop(p.before);
  const whole = /[.!?] /.test(before);
  if (!whole) saved.push(lowerFirst(before));
  if (p.followUp?.state === 'saved') saved.push(`the follow-up ${noStop(p.followUp.text).replace(/^Follow-up saved ?/, '')}`.trim());
  else if (p.followUp?.state === 'failed') notSaved.push('the follow-up');
  else if (p.followUp?.state === 'unsure') unsure.push('the follow-up');
  if (p.stage?.state === 'saved') saved.push(`the stage (${p.stage.label})`);
  else if (p.stage?.state === 'unsure') unsure.push('the stage change');
  else if (p.stage) notSaved.push(`the stage (still ${p.stage.label})`);
  let open = '';
  if (p.earlier?.state === 'unsure') unsure.push(`“${p.earlier.title}” marked done`);
  else if (p.earlier?.state === 'failed') notSaved.push(`“${p.earlier.title}” was not marked done, so it is still open`);
  else if (p.earlier) open = ` “${p.earlier.title}” is still open.`;
  const head = whole ? `Saved: ${lowerFirst(before)}.${saved.length > 0 ? ` Also saved: ${list(saved)}.` : ''}` : `Saved: ${list(saved)}.`;
  return `${head}${unsure.length > 0 ? ` Not confirmed: ${list(unsure)}.` : ''}${notSaved.length > 0 ? ` Not saved: ${list(notSaved)}.` : ''}${open} ${p.reason}`.trim();
}
