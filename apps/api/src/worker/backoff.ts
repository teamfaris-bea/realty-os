// Retry backoff for failed jobs: jittered exponential ("equal jitter"), 5 s base, 15 min cap.
// ARCHITECTURE §6 places the backoff in core; core/foundation ships none, so the worker owns this
// pure function (randomness injected) and reports the deviation.
import { MINUTE_MS, SECOND_MS } from '@realty/core/foundation';

export const BACKOFF_BASE_MS = 5 * SECOND_MS;
export const BACKOFF_CAP_MS = 15 * MINUTE_MS;

/** Delay before retry number `attempts` (1 = after the first failed run). In [d/2, d], d = min(cap, base·2^(n-1)). */
export function retryDelayMs(attempts: number, random: () => number): number {
  const n = Math.max(1, Math.floor(attempts));
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(d / 2 + (d / 2) * r);
}
