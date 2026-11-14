// Plain words for the Google Ads page (module 55 item 10; R-STAFF-1, R-STAFF-3, R-STAFF-4; CONVENTIONS §7: never a raw
// code). Every map is typed and exhaustive over what the API stores; an unknown stored code falls back to a plain
// sentence, never to the code itself.
import { messageFor } from '../../shell/index.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';

/** Whole cents as dollars: $1,234.50 (mirrors apps/api/src/ads/settings.ts dollars). */
export function dollars(cents: number): string {
  const neg = cents < 0;
  const c = Math.abs(Math.trunc(cents));
  const whole = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(c % 100).padStart(2, '0')}`;
}

/**
 * The Owner's cap attestation, rebuilt from the amounts exactly as the API does (apps/api/src/ads/settings.ts
 * capAttestation; words.test.ts reads that source and compares). The API stays the judge: a mismatch answers
 * ATTESTATION_REQUIRED with details.expected, which the form then shows verbatim (E670).
 */
export function capAttestation(monthlyCapCents: number, dailyCeilingCents: number): string {
  return `I approve a Google Ads cap of ${dollars(monthlyCapCents)} a month and ${dollars(dailyCeilingCents)} a day.`;
}

/** ad_campaigns.status (core/ads CAMPAIGN_STATUSES). */
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended' | 'rejected';
export const CAMPAIGN_STATUS_WORDS: Record<CampaignStatus, string> = {
  draft: 'Not managed here',
  active: 'Managed here',
  paused: 'Paused',
  ended: 'Ended',
  rejected: 'Rejected by Google Ads',
};
export function campaignStatusWords(s: string): string {
  return (CAMPAIGN_STATUS_WORDS as Record<string, string>)[s] ?? 'Status not known';
}

/** ad_allocation_events.event_kind (core/ads LEDGER_EVENT_KINDS). */
export type LedgerKind = 'planned' | 'applied' | 'failed' | 'paused';
export const LEDGER_KIND_WORDS: Record<LedgerKind, string> = {
  // b14 review F2: the planned row is written before any call to Google (ads/dispatch.ts TX1); only the applied,
  // failed and pending outcome rows say what reached Google
  planned: 'Approved, waiting to be sent to Google Ads',
  applied: 'Changed on Google Ads',
  failed: 'Not changed',
  paused: 'Paused',
};
export function ledgerKindWords(k: string): string {
  return (LEDGER_KIND_WORDS as Record<string, string>)[k] ?? 'Recorded';
}

/** ad_allocation_events.reason_code: the proposal's reasons (core/ads ProposalReasonCode) and the outcomes ads/dispatch.ts records. */
const REASON_WORDS: Record<string, string> = {
  RAISED_LOWER_COST_PER_OUTCOME: 'raised: lower cost per outcome',
  LOWERED_HIGHER_COST_PER_OUTCOME: 'lowered: higher cost per outcome',
  LOWERED_TO_FIT_CEILING: 'lowered to fit the daily ceiling',
  KEPT_UNCHANGED: 'kept the same',
  KEPT_BELOW_MINIMUM_SAMPLE: 'kept: too few agreements to compare',
  KEPT_NO_SPEND: 'kept: no spend reported',
  KEPT_NOT_ELIGIBLE: 'kept: not managed here',
  APPROVED_SHIFT: 'an approved change',
  RESUMED: 'resumed',
  APPLIED: 'Google Ads confirmed it',
  READBACK: 'confirmed at the hourly check',
  MONTHLY_CAP_REACHED: 'the monthly cap was reached',
  PACK_WITHDRAWN: 'budget changes were turned off before it was sent',
  ADS_CONNECTION_NOT_LIVE: 'the Google Ads account was no longer connected',
  CREDENTIAL_UNAVAILABLE: 'the Google Ads sign-in could not be read',
  OUTCOME_UNKNOWN: 'Google Ads never confirmed it within a day',
  PLATFORM_CHANGED: 'the budget was changed in Google Ads meanwhile',
  ADS_REJECTED: 'Google Ads refused the change',
  SHARED_BUDGET: 'the campaign uses a shared budget',
  CAMPAIGN_NOT_FOUND: 'Google Ads no longer has the campaign',
  CAMPAIGN_REMOVED: 'the campaign was removed in Google Ads',
};
export function reasonWords(code: string | null): string {
  if (!code) return '';
  return REASON_WORDS[code] ?? 'Google Ads refused the change';
}

/** One row of an approval's run, in words (E669: pending is waiting, never re-sent). */
export const PENDING_WORDS = 'Waiting for Google Ads to confirm; checked hourly';
export function runOutcomeWords(r: { outcome: 'pending' | 'applied' | 'failed'; outcomeCode: string | null }): string {
  if (r.outcome === 'pending') return PENDING_WORDS;
  if (r.outcome === 'applied') return 'Changed on Google Ads';
  return `Not changed: ${reasonWords(r.outcomeCode)}`;
}

/** core/ads EligibilityCode: why a campaign cannot be resumed here (ADS_CAMPAIGN_NOT_ELIGIBLE details.blockers). */
const BLOCKER_WORDS: Record<string, string> = {
  NOT_PAUSED: 'it is not paused',
  NOT_GOOGLE_ADS: 'it is not a Google Ads campaign',
  CONNECTION_NOT_LIVE: 'its account is not connected',
  NOT_ACTIVE: 'it is not managed here',
  PAUSED: 'it is paused',
  REJECTED: 'Google Ads rejected it',
  NOT_HOUSING_CATEGORY: 'it is not a housing campaign',
  TARGETING_REFUSED: 'its targeting is not allowed',
  CREATIVE_NOT_APPROVED: 'its creative is not approved',
  CHANGE_IN_FLIGHT: 'a change is still waiting for Google Ads',
};

/** ADS_PROPOSAL_STALE details.reason (ads/dispatch.ts staleness). */
const STALE_WORDS: Record<string, string> = {
  CAP_VERSION_CHANGED: 'the cap changed since it was made',
  CAMPAIGN_CHANGED: 'a campaign in it changed',
  CAMPAIGN_NOT_ELIGIBLE: 'a campaign in it is no longer managed here',
  PLATFORM_CHANGED: 'a budget was changed in Google Ads meanwhile',
};

/** ACTION_NOT_PENDING details.status (a proposal handled while the page was open). */
const NOT_PENDING_WORDS: Record<string, string> = {
  superseded: 'A newer proposal replaced this one. The page now shows the current one.',
  approved: 'Someone already approved this proposal.',
  executed: 'Someone already approved this proposal.',
  rejected: 'Someone already rejected this proposal.',
  blocked: 'This proposal was put on hold.',
};

/**
 * The ads codes of apps/api/src/errors.ts (module 52), in words. They are registered as the surface's errorMessages
 * (no other surface words them). ACTION_NOT_PENDING is worded here only, locally (other surfaces word it their way).
 */
export const ADS_ERROR_MESSAGES: Record<string, string> = {
  ADS_NOT_CLEARED: 'Budget changes stay off until counsel review and the Google Ads check are complete. Nothing was changed.',
  ADS_GOOGLE_ONLY: 'Only Google Ads campaigns are managed here. Nothing was changed.',
  ADS_CONNECTION_NOT_LIVE: 'The Google Ads account is not connected, so no budget can move. Nothing was changed.',
  AD_APPROVAL_FROZEN: 'An approved budget change cannot be edited. Wait for next week’s proposal.',
  AD_CAP_EXCEEDED: 'This change would take the daily budgets above your daily ceiling, so it was not approved. Nothing was changed.',
  AD_CAP_VERSION_STALE: 'The cap changed after this proposal was made, so it was not approved. Nothing was changed.',
  AD_SHIFT_NOT_IN_APPROVAL: 'That change is not part of what was approved. Nothing was changed.',
  AD_SHIFT_NOT_APPROVED: 'Nobody approved that change. Nothing was changed.',
  AD_CREATIVE_NOT_APPROVED: 'Pick a marketing piece of that listing that is approved or published.',
  AD_BUDGET_THROUGH_LEDGER: 'Budgets change only through an approved change. Nothing was changed.',
  AD_APPLY_WITHOUT_PLAN: 'That result matches no approved change. Nothing was changed.',
  ADS_PROPOSAL_STALE: 'This proposal no longer matches your campaigns or cap, so it was replaced. Nothing was changed.',
  ADS_APPROVAL_NOT_FROM_ADS: 'This change was not approved on the Google Ads page, so it is never sent. Nothing was changed.',
  ADS_MONTHLY_CAP_REACHED: 'Month-to-date spend has reached your monthly cap. Resume next month, or after the Owner raises the cap.',
  ADS_CAMPAIGN_NOT_ELIGIBLE: 'This campaign cannot be resumed here. Resume it in Google Ads.',
  ADS_NO_CAP: 'Set a monthly cap and a daily ceiling first.',
  ADS_NO_LEAD_SOURCE: 'The Google Ads account has no lead source, so its spend is not recorded and no budget moves.',
  AD_CAP_CHANGED: 'Another cap was saved at the same moment. The page now shows it; check it, then save again if you still want this one.',
  AD_CAP_INVALID: 'The daily ceiling cannot be above the monthly cap.',
};

const LOCAL: Record<string, string> = {
  ACTION_NOT_PENDING: 'This proposal was already handled. The page now shows the current one.',
  ATTESTATION_REQUIRED: 'Confirm the sentence below exactly as shown, then save again.',
  NOT_FOUND: "This isn't available. It may have been replaced, or you may not have access to it.",
};

export const ADS_MESSAGES: Record<string, string> = { ...ADMIN_MESSAGES, ...ADS_ERROR_MESSAGES, ...LOCAL };

/** A refusal in words, with its details (stale reason, the status it reached, the blockers). */
export function refusalWords(f: { code: string; details: Record<string, unknown> | null }): string {
  const d = f.details ?? {};
  if (f.code === 'ADS_PROPOSAL_STALE' && typeof d.reason === 'string' && STALE_WORDS[d.reason]) {
    return `This proposal was replaced because ${STALE_WORDS[d.reason]}. Nothing was changed.`;
  }
  if (f.code === 'ACTION_NOT_PENDING' && typeof d.status === 'string' && NOT_PENDING_WORDS[d.status]) return NOT_PENDING_WORDS[d.status]!;
  if (f.code === 'ADS_CAMPAIGN_NOT_ELIGIBLE' && Array.isArray(d.blockers)) {
    const why = d.blockers.filter((b): b is string => typeof b === 'string').map((b) => BLOCKER_WORDS[b] ?? 'it is not managed here');
    if (why.length > 0) return `This campaign cannot be resumed here: ${[...new Set(why)].join('; ')}. Resume it in Google Ads.`;
  }
  return messageFor({ code: f.code, details: f.details }, ADS_MESSAGES);
}
