// Module 52 constants and owner-question defaults (Q-ADS-1..8 are open: each recommended default lives here, in ONE
// constant, so the orchestrator can relay a change as a one-line edit).
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@realty/core/foundation';

/** The platform pack that keeps Google Ads dark until counsel review AND the vendor check (D7, R-ADS-7). */
export const ADS_PACK = 'platform:ads';

/** D2: the only connection kind module 52 mirrors, proposes for, plans or pauses. */
export const ADS_KIND = 'ads_google';

/**
 * Q-ADS-1 default: mirroring and spend sync (reads) run while the pack is dark; only money moves wait (at the cap the
 * reconcile only alerts). Read by mirror.ts runReconcile and overview.ts buildOverview. Set to false, a pass while the
 * pack is not cleared reads, writes and alerts nothing (no mirror, spend sync, readback of an unresolved plan or
 * overspend check) and GET /ads says why; once the pack is cleared the next pass reads again.
 */
export const READS_WHILE_DARK = true;

/**
 * Q-ADS-3 default: the monthly cap counts every campaign of the account, mirrored or not, managed or not, and the cap
 * pause covers every mirrored campaign Google Ads reports serving (unmanaged ones are resumed in Google Ads). Read by
 * mirror.ts runReconcile. Set to false, the cap counts only campaigns linked here (a listing and its approved creative,
 * R-ADS-12) and pauses only managed (`active`) ones. The daily ceiling covers managed campaigns only either way.
 * VERIFY WITH COUNSEL (C3): auto-pausing at the cap, unmanaged campaigns included.
 */
export const CAP_COUNTS_EVERY_CAMPAIGN = true;

/**
 * Q-ADS-4 default (built in repo.ts ownersAndAdmins and notifyOverspend, pointer only): the cap and "not checked"
 * alerts go to every active Owner and Admin, in-app and web push to their own devices, never SMS.
 * Q-ADS-6 default (built in module 33's owner view, pointer only): the owner view sums manual and ads_sync costs, and
 * GET /ads warns when one lead source has both for a month (repo.ts doubleCounted, E451); enter spend by hand only for
 * accounts that are not connected.
 * Q-ADS-7 default (built in core, packages/core/src/ads/propose.ts DEFAULT_ALLOC_RULES.leadingOutcome, pointer only):
 * cost per agreement ranks campaigns (R-ADS-6), with closings shown alongside.
 * Q-ADS-8 default (no code): no application for higher Google Ads API access before the pilot; only after counsel clears
 * C3 for ads and a real adapter exists (VERIFY).
 * Q-ADS-2 default (no code here): clearing needs the vendor check too; VENDOR_CHECKED_PACKS in integrations/catalog.ts
 * and the 0070 gates' app.platform_cleared('platform:ads', true).
 */

/** The one currency module 52 manages (VERIFY: other currencies need an exchange-rate decision first). */
export const MANAGED_CURRENCY = 'USD';

/** campaign_ref of a mirrored Google Ads campaign; deals and inquiries carry it (only these refs count). */
export const campaignRefOf = (externalCampaignId: string): string => `gads:${externalCampaignId}`;
export const CAMPAIGN_REF_PREFIX = 'gads:';

/**
 * How long one applyBudgetChange / pauseCampaign call is waited for; then the outcome is "unknown" (readback decides).
 * VERIFY (engineering): against a real adapter's observed latency.
 */
export const APPLY_TIMEOUT_MS = 30_000;

/**
 * A planned row with no outcome after this long is resolved by readback in the hourly reconcile (E447). VERIFY
 * (engineering): long enough that a slow apply is not read back while still in flight.
 */
export const STALE_PLANNED_MS = 10 * MINUTE_MS;

/** A planned row still unresolved after this long is failed OUTCOME_UNKNOWN (never planned again, E447). */
export const OUTCOME_UNKNOWN_AFTER_MS = DAY_MS;

/** "Not checked" alert after this long without a successful spend check (E453). */
export const UNCHECKED_ALERT_MS = 2 * HOUR_MS;

/**
 * The hourly reconcile (mirror, spend sync, readback, overspend) and the hourly wake of the weekly proposal. Operation
 * budget (VERIFY against the Google Ads access level, said to be about 2,880 operations a day for Explorer, and whether
 * reads count): 4 reads per connection-hour (accountInfo, listCampaigns, daily and hourly spend), so 96 a day; plus the
 * weekly proposal's 2 reads, each approved change and each cap pause.
 */
export const RECONCILE_EVERY_MS = HOUR_MS;
export const PROPOSE_EVERY_MS = HOUR_MS;

/** Q-ADS-5 default: the weekly proposal is built on the tenant's local Monday (ISO weekday 1); a new one replaces an unanswered one. */
export const PROPOSAL_WEEKDAY = 1;

/** Ledger page size (GET /ads/ledger) and the events shown per campaign in GET /ads. */
export const LEDGER_PAGE = 50;
export const LEDGER_PER_CAMPAIGN = 5;

/**
 * The over-delivery sentence the overview shows (R-ADS-5), by what the reconcile does on this deployment now (b11
 * api-ui/F4): it pauses only while platform:ads is cleared. VERIFY WITH COUNSEL (C3) the wording.
 */
export const OVERSPEND_NOTE =
  'Google Ads may spend more than a daily budget on a given day; Realty OS pauses every campaign once month-to-date spend reaches your monthly cap.';
export const OVERSPEND_NOTE_NO_LEAD_SOURCE =
  'Google Ads may spend more than a daily budget on a given day; Realty OS pauses the campaigns it records once month-to-date spend reaches your monthly cap. Without a lead source it records no new campaign: pause those in Google Ads.';
export const OVERSPEND_NOTE_DARK =
  'Google Ads may spend more than a daily budget on a given day. Until counsel review and the Google Ads check are complete, Realty OS reads spend and alerts you at your monthly cap but cannot pause campaigns: pause them in Google Ads.';
export const OVERSPEND_NOTE_NOT_READ =
  'Google Ads may spend more than a daily budget on a given day. Until counsel review and the Google Ads check are complete, Realty OS does not read Google Ads, so it cannot alert you or pause campaigns at your monthly cap.';

/** The Owner's attestation for a cap, rebuilt from the amounts (R-ADS-1). VERIFY WITH COUNSEL (C3) the wording. */
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
