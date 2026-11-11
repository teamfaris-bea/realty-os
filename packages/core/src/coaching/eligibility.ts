// Which calls may be reviewed at all (R-COACH-1, R-COACH-3, E104).
//
// A call is reviewed only when ALL of these hold, checked in this order (the first failure is the
// reason returned, so the API can log one stable code):
//   1. the `platform:coaching` pack is cleared (counsel review)            → pack_not_cleared
//   2. the Owner turned call scoring on                                    → scoring_off
//   3. a person handled the call (never voicemail or an AI-handled call)   → not_human_handled
//   4. the call was not imported                                           → imported_call
//   5. there is a recording                                                → no_recording
//   6. the recording was not imported (FUB imports are never reviewed)     → imported_recording
//   7. the recording basis is announced_all_parties or one_party_policy   → consent_basis_not_allowed
//   8. there is a transcript                                               → no_transcript
// The DB enforces the same (call_scores guard, tenant_settings trigger); this is the job's
// pre-check so no model run is spent on a call that can never be stored.
import type { CallReviewFacts, ConsentBasis, ReviewEligibility } from './types.js';

/** Recording bases a review may rest on (R-COACH-1). `unknown_imported` never qualifies. */
export const REVIEWABLE_CONSENT_BASES: readonly ConsentBasis[] = ['announced_all_parties', 'one_party_policy'];

export function reviewEligible(call: CallReviewFacts): ReviewEligibility {
  if (!call.coachingPackCleared) return { eligible: false, reason: 'pack_not_cleared' };
  if (!call.callScoringEnabled) return { eligible: false, reason: 'scoring_off' };
  if (call.handledBy !== 'human') return { eligible: false, reason: 'not_human_handled' };
  if (call.imported) return { eligible: false, reason: 'imported_call' };
  if (call.recording === null) return { eligible: false, reason: 'no_recording' };
  if (call.recording.source !== 'provider') return { eligible: false, reason: 'imported_recording' };
  if (!REVIEWABLE_CONSENT_BASES.includes(call.recording.consentBasis)) return { eligible: false, reason: 'consent_basis_not_allowed' };
  if (!call.hasTranscript) return { eligible: false, reason: 'no_transcript' };
  return { eligible: true };
}
