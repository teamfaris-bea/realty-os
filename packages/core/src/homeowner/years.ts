// Years owned (E582): whole years since the last recorded transfer, floor(days / 365.25) as module 50's yearsSince
// (apps/api/src/predict/decide.ts). It names the date and the source it was computed from; a future date, or one more
// than 150 years back, gives null (nothing is guessed).
import type { HomeownerFact } from './types.js';

export interface YearsOwned {
  years: number;
  /** the transfer date it counts from (YYYY-MM-DD) */
  since: string;
  source: string;
  asOf: string | null;
}

export function yearsOwned(transfer: HomeownerFact<'last_transfer_date'> | null | undefined, today: string): YearsOwned | null {
  if (!transfer) return null;
  const from = Date.parse(`${transfer.value}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  const years = Math.floor((to - from) / 86_400_000 / 365.25);
  if (years > 150) return null;
  return { years, since: transfer.value, source: transfer.source, asOf: transfer.asOf };
}
