// @realty/core/ads — public interface of PHASE2_3_PLAN module 51: reallocation proposals under the
// Owner's cap, sample holds, and overspend. Pure: no I/O, no clock, no randomness, no tenant input, no
// provider. Nothing here applies a budget: module 52 (api/ads: ads/dispatch.ts, AdsProvider and its fake,
// caps, spend sync, hourly reconcile) writes the planned → applied ledger after an Owner's or Admin's tap.
//
// Rules (core parts only)
//   R-ADS-2  proposal side: the tenant-wide daily total, counted as app.ad_allocation_cap_check() counts
//            it (tenantDailyTotal), stays ≤ the cap version's daily ceiling, and `changes` names exact
//            (campaign_id, to_daily_cents) pairs in the shape the trigger reads from payload->'changes'.
//            The proposal names the cap version it used (capVersionId); the DB refuses a stale one.
//   R-ADS-4  core half: only a housing campaign with valid targeting and an approved creative of its own
//            listing is moved; contact-list audiences, lookalikes and prediction output are refused by
//            the targeting validator. The DB half is the special_category CHECK and ad_campaigns_guard.
//   R-ADS-5  core half: overspend() pauses every campaign once month-to-date spend reaches the monthly
//            cap; a day over a daily budget pauses nothing.
//   R-ADS-6  all of it: money moves only between campaigns with ≥ 5 agreements each in 90 days; otherwise
//            a hold with every campaign's counts.
//   R-FH-4   applied to campaigns, through core/fairhousing's validateTargeting (DEFAULT_TARGETING_LIMITS,
//            VERIFY, never widened here).
//   R-ADS-1 and R-ADS-3 have no core part.
//   D2 Google Ads only: an ads_meta (or any non-'ads_google') campaign is never moved, yet counts in the
//   total. D-ADS: core never applies. R-INT-2: only connected or degraded connections act. R-AST-13: no
//   confidence, probability or score anywhere. R-PRED-4: no prediction import (lint).
// Edge cases, core halves (module 52 closes each): E123 (proposal at the cap moves money only: proven
// here), E124 (a cap lowered below month-to-date spend pauses everything: overspend), E145 (a second run
// for one day: proposals are deterministic and order-independent; the DB's unique keys refuse the
// replay), E146 (a rejected campaign gets nothing and no proposal carries targeting, so there is no
// fallback targeting). E161 and the DB refusals are module 52's and the DB's.
//
// Defaults where the plan is silent (product defaults, in DEFAULT_ALLOC_RULES or the method):
//   - a thin campaign (fewer than 5 agreements) does not hold the whole proposal: it keeps its budget and
//     stays out of the moves; the proposal holds only when fewer than two campaigns are comparable;
//   - the leading outcome is agreements (§1 names appointments/closings; R-ADS-6 counts agreements);
//     AllocRules.leadingOutcome may be 'closings';
//   - a proposal never adds spend below the ceiling (§1 "move budget"): the total stays at the current
//     total, or is lowered to fit the ceiling;
//   - one proposal lowers a costlier campaign by at most 20 % (maxShiftBps), never below minDailyCents (0);
//   - a campaign with a change still planned (in flight), or paused, is not moved.
// VERIFY (Google Ads, N14; kept configurable or passed in): budget units, minimum daily budget and
// increment (core keeps whole cents; module 52's adapter converts); how far a campaign may spend over
// its daily budget in a day (core assumes no factor and pauses only on the monthly cap); the account's
// reporting zone and hourly-spend delay (the caller passes the month's rows); the API access level (said to sit on the
// Cloud project, not on a developer token; VERIFY, N14).
// VERIFY WITH COUNSEL (R-ADS-4, R-FH-4, C3): housing special-category requirements and targeting limits
// per jurisdiction and platform policy.
// Platform pack: `platform:ads` (migration 0070, module 52) keeps ads dark (D7): its two invoker gates refuse every new
// ad_reallocation approval and planned ledger row until counsel review AND rules.vendor_ready_at (R-ADS-7, R-INT-6).
// core/ads takes no clearance input; api/ads checks the pack.
export * from './types.js';
export { proposeReallocation, eligibility, DEFAULT_ALLOC_RULES } from './propose.js';
export { overspend } from './overspend.js';
export { tenantDailyTotal, countedDailyCents } from './total.js';
