import { describe, expect, it } from 'vitest';
import { reviewEligible } from './index.js';
import { facts } from './testing/fixtures.js';

describe('R-COACH-1 R-COACH-3 review eligibility', () => {
  it('R-COACH-1: a human-handled call with an announced or one-party recording and a transcript is reviewed', () => {
    expect(reviewEligible(facts())).toEqual({ eligible: true });
    expect(reviewEligible(facts({ recording: { source: 'provider', consentBasis: 'one_party_policy' } }))).toEqual({ eligible: true });
  });

  it('R-COACH-1: scoring stays off until platform:coaching is cleared, even if the Owner turned it on', () => {
    expect(reviewEligible(facts({ coachingPackCleared: false }))).toEqual({ eligible: false, reason: 'pack_not_cleared' });
  });

  it('R-COACH-1: scoring stays off while the Owner has not turned call scoring on', () => {
    expect(reviewEligible(facts({ callScoringEnabled: false }))).toEqual({ eligible: false, reason: 'scoring_off' });
  });

  it('R-COACH-3: an AI-handled call or a voicemail is never reviewed', () => {
    expect(reviewEligible(facts({ handledBy: 'assistant' }))).toEqual({ eligible: false, reason: 'not_human_handled' });
    expect(reviewEligible(facts({ handledBy: 'voicemail' }))).toEqual({ eligible: false, reason: 'not_human_handled' });
  });

  it('E104 R-COACH-1: an imported FUB recording is never reviewed', () => {
    expect(reviewEligible(facts({ imported: true, recording: { source: 'import_fub', consentBasis: 'unknown_imported' } }))).toEqual({
      eligible: false,
      reason: 'imported_call',
    });
    expect(reviewEligible(facts({ recording: { source: 'import_fub', consentBasis: 'unknown_imported' } }))).toEqual({ eligible: false, reason: 'imported_recording' });
  });

  it('E104 R-COACH-1: an unknown_imported consent basis never qualifies, whatever the source says', () => {
    expect(reviewEligible(facts({ recording: { source: 'provider', consentBasis: 'unknown_imported' } }))).toEqual({
      eligible: false,
      reason: 'consent_basis_not_allowed',
    });
  });

  it('R-COACH-1: no recording or no transcript ⇒ not reviewed', () => {
    expect(reviewEligible(facts({ recording: null }))).toEqual({ eligible: false, reason: 'no_recording' });
    expect(reviewEligible(facts({ hasTranscript: false }))).toEqual({ eligible: false, reason: 'no_transcript' });
  });

  it('R-COACH-1: the first failing check is the reason (pack before scoring before the call)', () => {
    expect(reviewEligible(facts({ coachingPackCleared: false, callScoringEnabled: false, handledBy: 'assistant', recording: null }))).toEqual({
      eligible: false,
      reason: 'pack_not_cleared',
    });
    expect(reviewEligible(facts({ callScoringEnabled: false, handledBy: 'assistant' }))).toEqual({ eligible: false, reason: 'scoring_off' });
  });
});
