// overspend(hourly, cap): which campaigns hourly reconciliation pauses (R-ADS-5, core half; E124).
//
// The caller (module 52) passes the CURRENT month's provider-reported hourly rows, the month taken in
// the provider's reporting zone (VERIFY, N14: that zone, and how late hourly spend arrives), and a
// row for EVERY campaign of the account (a zero-spend row is fine): the signature has no campaign
// list, so a campaign with no row is not returned. Once month-to-date spend reaches monthly_cap_cents,
// every campaign in the rows is returned; otherwise none. A day over a daily budget, on its own,
// pauses nothing: platforms may overspend a daily budget on a given day (VERIFY, N14: by how much).
// A cap lowered below month-to-date spend (E124) pauses everything at once; nothing is retroactive.
import type { CampaignId, Cap, HourlySpend } from './types.js';
import { cents, checkCap, safeSum, uuid } from './validate.js';

export function overspend(hourly: HourlySpend[], cap: Cap): CampaignId[] {
  checkCap(cap);
  if (!Array.isArray(hourly)) throw new RangeError('hourly: expected an array');
  const seen = new Set<string>();
  const ids = new Set<CampaignId>();
  for (const h of hourly) {
    const id = uuid(h.campaignId, 'hourly.campaignId');
    if (!Number.isSafeInteger(h.hourStart)) throw new RangeError('hourly.hourStart: expected an instant');
    cents(h.spendCents, 'hourly.spendCents');
    const key = `${id}@${h.hourStart}`;
    if (seen.has(key)) throw new RangeError(`hourly: duplicate row for ${key}`);
    seen.add(key);
    ids.add(h.campaignId);
  }
  const monthToDate = safeSum(hourly.map((h) => h.spendCents), 'month-to-date spend');
  if (monthToDate < cap.monthlyCapCents) return [];
  return [...ids].sort();
}
