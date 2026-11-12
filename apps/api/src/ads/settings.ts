// Module 52 constants and owner-question defaults (Q-ADS-1..8 are open: each recommended default lives here, in ONE
// constant, so the orchestrator can relay a change as a one-line edit).
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@realty/core/foundation';

/** The platform pack that keeps Google Ads dark until counsel review AND the vendor check (D7, R-ADS-7). */
export const ADS_PACK = 'platform:ads';

/** D2: the only connection kind module 52 mirrors, proposes for, plans or pauses. */
export const ADS_KIND = 'ads_google';

/** Q-ADS-1 default: mirroring and spend sync (reads) run while the pack is dark; only budget changes wait. */
export const READS_WHILE_DARK = true;

/** Q-ADS-3 default: the monthly cap counts every campaign of the account, mirrored or not, managed or not. */
export const CAP_COUNTS_EVERY_CAMPAIGN = true;

/** The one currency module 52 manages (VERIFY: other currencies need an exchange-rate decision first). */
export const MANAGED_CURRENCY = 'USD';

/** campaign_ref of a mirrored Google Ads campaign; deals and inquiries carry it (only these refs count). */
export const campaignRefOf = (externalCampaignId: string): string => `gads:${externalCampaignId}`;
export const CAMPAIGN_REF_PREFIX = 'gads:';

/** How long one applyBudgetChange / pauseCampaign call is waited for; then the outcome is "unknown" (readback decides). */
export const APPLY_TIMEOUT_MS = 30_000;

/** A planned row with no outcome after this long is resolved by readback in the hourly reconcile (E447). */
export const STALE_PLANNED_MS = 10 * MINUTE_MS;

/** A planned row still unresolved after this long is failed OUTCOME_UNKNOWN (never planned again, E447). */
export const OUTCOME_UNKNOWN_AFTER_MS = DAY_MS;

/** "Not checked" alert after this long without a successful spend check (E453). */
export const UNCHECKED_ALERT_MS = 2 * HOUR_MS;

/** The hourly reconcile (mirror, spend sync, readback, overspend) and the hourly wake of the weekly proposal. */
export const RECONCILE_EVERY_MS = HOUR_MS;
export const PROPOSE_EVERY_MS = HOUR_MS;

/** Q-ADS-4 default: the weekly proposal is built on the tenant's local Monday (ISO weekday 1). */
export const PROPOSAL_WEEKDAY = 1;

/** Ledger page size (GET /ads/ledger) and the events shown per campaign in GET /ads. */
export const LEDGER_PAGE = 50;
export const LEDGER_PER_CAMPAIGN = 5;

/** The sentence the overview always shows (R-ADS-5). VERIFY WITH COUNSEL the wording. */
export const OVERSPEND_NOTE =
  'Google Ads may spend more than a daily budget on a given day; Realty OS pauses every campaign once month-to-date spend reaches your monthly cap.';

/** The Owner's attestation for a cap, rebuilt from the amounts (R-ADS-1). */
export function capAttestation(monthlyCapCents: number, dailyCeilingCents: number): string {
  return `I approve a Google Ads cap of ${dollars(monthlyCapCents)} a month and ${dollars(dailyCeilingCents)} a day.`;
}

/** Whole cents as dollars: $1,234.50 (always two decimals). */
export function dollars(cents: number): string {
  const neg = cents < 0;
  const c = Math.abs(Math.trunc(cents));
  const whole = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(c % 100).padStart(2, '0')}`;
}
