// Years owned (R-HOME-4; E582): whole years since the last recorded transfer, floor(days / 365.25) as module 50's
// yearsSince (apps/api/src/predict/decide.ts). It names the date and the source it was computed from: the county's
// transfer date when the record has one, otherwise the team's own closing of the purchase when the caller passes one
// the viewer can see (b11 reconciliation homeowner-3: the county date needs the Gisfile step, off by default). A future
// date, a malformed one, or one more than 150 years back gives null (nothing is guessed).
import type { HomeownerFact } from './types.js';

/** The source named when years owned counts from the team's closing (no county transfer date). */
export const TEAM_CLOSING_SOURCE = "the team's closed deal in this CRM";

export interface YearsOwned {
  years: number;
  /** the date it counts from (YYYY-MM-DD) */
  since: string;
  /** what that date is: the county's last transfer, or the team's closing of the purchase */
  basis: 'county_transfer' | 'team_closing';
  source: string;
  asOf: string | null;
}

function wholeYears(fromDay: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) return null;
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  const years = Math.floor((to - from) / 86_400_000 / 365.25);
  return years > 150 ? null : years;
}

/**
 * Years owned from the county transfer fact, or, only when there is none, from `teamClosingOn` (the closing date of
 * the team's purchase deal for this home, in the team's time zone, that the viewer may see).
 */
export function yearsOwned(transfer: HomeownerFact<'last_transfer_date'> | null | undefined, today: string, teamClosingOn?: string | null): YearsOwned | null {
  if (transfer) {
    const years = wholeYears(transfer.value, today);
    return years === null ? null : { years, since: transfer.value, basis: 'county_transfer', source: transfer.source, asOf: transfer.asOf };
  }
  if (!teamClosingOn) return null;
  const years = wholeYears(teamClosingOn, today);
  return years === null ? null : { years, since: teamClosingOn, basis: 'team_closing', source: TEAM_CLOSING_SOURCE, asOf: null };
}
