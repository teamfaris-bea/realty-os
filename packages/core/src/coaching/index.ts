// @realty/core/coaching — public interface of PHASE2_3_PLAN module 35: the call review rubric,
// review eligibility, scoring from verified claims, the daily fix and the improving/slipping trend.
// Pure: no I/O, no clock, no randomness. Other modules import only from here.
//
// VERIFY WITH COUNSEL: reviewing agents' calls is employee monitoring and rests on lawful call
// recording. Call scoring stays off until the `platform:coaching` pack is cleared by counsel review
// and the Owner turns it on (R-COACH-1; enforced again in the DB). Nothing here is legal advice and
// no state-specific rule is encoded.
//
// R-COACH-5: call scores never feed routing, ownership, prediction, the scoreboard or any automatic
// consequence (architecture.test.ts). R-COACH-6: no numeric overall score, grade, leaderboard,
// voice-tone or sentiment analysis exists in this module.
export * from './types.js';
export { RUBRIC_V1, assertRubric, isRubricVersion } from './rubric.js';
export { REVIEWABLE_CONSENT_BASES, REVIEWED_ROLES, reviewEligible } from './eligibility.js';
export { callScoreItemsJson, countItems, scoreFromClaims, scoreSummaryText, verifiedRefs } from './score.js';
export { FIX_MAX_QUOTES, FIX_MIN_CALLS, FIX_WINDOW_CALLS, NO_FIX_TEXT, coachingFixKey, dailyFix, dailyFixResult, fixWindow } from './fix.js';
export { TREND_MIN_SCORED, TREND_STEADY_BELOW_POINTS, trend } from './trend.js';
