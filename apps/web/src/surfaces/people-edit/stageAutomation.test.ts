// Parity module 67 (flagged edit in module 58): the stage toast says what the stage entry started, or why
// it did not, in plain words (never a raw code).
//
// b19 fix pass L5 (E784): ONE vocabulary. The words are the SERVER's sentence for the decision (the stage route's
// `automationSentence`: the sentence the "What happens next" panel shows for the same change, and the past tense of
// the preview's). The web no longer keeps a table of its own skip words. What is left here is a fallback for an answer
// that carries no sentence: it says only that the plan started or did not, with no reason of the web's own making,
// except the two source reasons whose words batch 18's tests (surfaces/lead-sources, not this batch's to change) read
// straight from this function.
import { describe, expect, it } from 'vitest';
import { automationText } from './StagePill.js';
import { automationWords } from './stageFlow.js';

const REASONS = ['already_in_a_plan', 'plan_not_approved', 'cannot_be_reached', 'not_visible', 'stage_changed_again', 'person_removed', 'not_a_person_change', 'protected_audience', 'ai_isa_active', 'undo'];

describe('R-PAR-16 the stage toast names the plan that started, or why it did not', () => {
  it('L5 E784 the words are the server\'s sentence, whatever the outcome, with nothing added and nothing reworded', () => {
    const stop = 'Buyer plan did not start: they opted out, are marked do not contact, or have no phone or email this plan could use.';
    expect(automationWords({ automation: { skipped: 'cannot_be_reached', plan: 'Buyer plan' }, automationSentence: stop })).toBe(stop);
    expect(automationWords({ automation: { started: 'Buyer plan' }, automationSentence: 'Buyer plan started.' })).toBe('Buyer plan started.');
    // a reason this build has never heard of reads as the server words it
    expect(automationWords({ automation: { skipped: 'SOMETHING_NEW', plan: 'P' }, automationSentence: 'P did not start: a new rule.' })).toBe('P did not start: a new rule.');
    expect(automationWords({ automation: null, automationSentence: null })).toBe('');
    expect(automationWords({ automation: undefined })).toBe('');
  });

  it('L5 E784 the web has no skip words of its own: without the server\'s sentence a skip says only that the plan did not start, never a reason and never a code', () => {
    for (const r of REASONS) {
      const t = automationText({ skipped: r, plan: 'P' });
      expect(t, r).toBe('P did not start');
      expect(automationWords({ automation: { skipped: r, plan: 'P' } }), r).toBe('P did not start');
    }
    expect(automationText({ skipped: 'SOMETHING_NEW', plan: 'P' })).toBe('P did not start');
    expect(automationText({ started: 'Buyer plan' })).toBe('Buyer plan started');
    expect(automationText(null)).toBe('');
    expect(automationText(undefined)).toBe('');
  });
});
