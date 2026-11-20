// b19 Today fix 1 (M2; R-TODAY-11): a partial save is said ONCE, in one consistent sentence: what was saved, what was
// not (or could not be confirmed), what that leaves open, and the server's reason. Never "could not confirm … it
// wasn't saved" in one breath.
import { describe, expect, it } from 'vitest';
import { GENERIC_ERROR_MESSAGE } from '../../shell/errorMessages.js';
import { partialSaveWords, unsureReason } from './partialSave.js';

const NET = "Can't reach the server. Check your connection, then try again.";

describe('R-TODAY-11: partialSaveWords', () => {
  it('the log saved and the follow-up was refused: the stage was not tried, and the earlier follow-up is still open', () => {
    expect(
      partialSaveWords({ before: 'Call logged (talked)', followUp: { state: 'failed' }, stage: { state: 'not_tried', label: 'New lead' }, earlier: { title: 'Follow up with Paula', state: 'not_tried' }, reason: 'Pick a date in the future.' }),
    ).toBe('Saved: call logged (talked). Not saved: the follow-up and the stage (still New lead). “Follow up with Paula” is still open. Pick a date in the future.');
  });

  it('the log and the follow-up saved and the stage was refused', () => {
    expect(
      partialSaveWords({ before: 'Call logged (talked)', followUp: { state: 'saved', text: 'Follow-up saved for Thu, Nov 26, 9:00 AM' }, stage: { state: 'failed', label: 'New lead' }, earlier: { title: 'Follow up with Paula', state: 'not_tried' }, reason: 'Reach them first.' }),
    ).toBe('Saved: call logged (talked) and the follow-up for Thu, Nov 26, 9:00 AM. Not saved: the stage (still New lead). “Follow up with Paula” is still open. Reach them first.');
  });

  it('a lost answer is "not confirmed", never "not saved", and its reason never says it was not saved', () => {
    const s = partialSaveWords({ before: 'Call logged (left voicemail)', followUp: { state: 'saved', text: 'Follow-up saved for Fri, Nov 20, 9:00 AM' }, stage: { state: 'unsure', label: 'New lead' }, earlier: { title: 'Follow up with Rosa', state: 'not_tried' }, reason: unsureReason(GENERIC_ERROR_MESSAGE) });
    expect(s).toBe('Saved: call logged (left voicemail) and the follow-up for Fri, Nov 20, 9:00 AM. Not confirmed: the stage change. “Follow up with Rosa” is still open. Something went wrong on our side. Try again in a moment.');
    expect(s).not.toMatch(/wasn.t saved|not saved/i);
  });

  it('everything saved and the earlier follow-up could not be marked done', () => {
    expect(
      partialSaveWords({ before: 'Voicemail logged', followUp: { state: 'saved', text: 'Follow-up saved for Fri, Nov 20, 9:00 AM' }, stage: { state: 'saved', label: 'Trying to reach' }, earlier: { title: 'Follow up with Dana', state: 'failed' }, reason: NET }),
    ).toBe(`Saved: voicemail logged, the follow-up for Fri, Nov 20, 9:00 AM and the stage (Trying to reach). Not saved: “Follow up with Dana” was not marked done, so it is still open. ${NET}`);
  });

  it('with nothing else at stake it is the short form: what was saved, what was not, why', () => {
    expect(partialSaveWords({ before: 'Call logged (left voicemail)', stage: { state: 'failed', label: 'New lead' }, reason: 'Reach them first (a call, text, email or reply in their website chat), or close the lead.' })).toBe(
      'Saved: call logged (left voicemail). Not saved: the stage (still New lead). Reach them first (a call, text, email or reply in their website chat), or close the lead.',
    );
    expect(partialSaveWords({ before: 'Call logged (left voicemail)', stage: { state: 'unsure', label: 'New lead' }, reason: NET })).toBe(`Saved: call logged (left voicemail). Not confirmed: the stage change. ${NET}`);
    expect(partialSaveWords({ before: 'Voicemail logged', followUp: { state: 'unsure' }, stage: { state: 'not_tried', label: 'New lead' }, reason: NET })).toBe(`Saved: voicemail logged. Not confirmed: the follow-up. Not saved: the stage (still New lead). ${NET}`);
  });

  it('a "before" that is already more than one sentence keeps its words', () => {
    expect(partialSaveWords({ before: 'Call logged (left voicemail). Your first tap had already saved it, as first written.', stage: { state: 'failed', label: 'New lead' }, reason: 'No.' })).toBe(
      'Saved: call logged (left voicemail). Your first tap had already saved it, as first written. Not saved: the stage (still New lead). No.',
    );
  });

  it('unsureReason leaves every other sentence as it is', () => {
    expect(unsureReason(NET)).toBe(NET);
    expect(unsureReason(GENERIC_ERROR_MESSAGE)).not.toMatch(/saved/);
  });
});
