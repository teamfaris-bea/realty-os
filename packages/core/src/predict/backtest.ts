// Platform back-test (R-PRED-3): of the people a model flagged likely_90d, how many transacted within the
// window after the prediction. Stored on prediction_models (backtest_flagged/transacted/window_days/dataset)
// and shown on every card. Pure; independent of input order.
import { DAY_MS } from '../foundation/index.js';
import type { BacktestDeal, BacktestPrediction, BacktestSummary } from './types.js';

export type BacktestResult = { flagged: number; transacted: number };

/**
 * flagged = distinct people with a likely_90d prediction; transacted = those of them with a deal closed
 * after one of their flagged predictions and no more than `windowDays` days later.
 */
export function backtest(p: readonly BacktestPrediction[], deals: readonly BacktestDeal[], opts: { windowDays: number }): BacktestResult {
  if (!Number.isSafeInteger(opts.windowDays) || opts.windowDays < 0) throw new RangeError('backtest: windowDays must be a whole number ≥ 0');
  const windowMs = opts.windowDays * DAY_MS;
  const flaggedAt = new Map<string, number[]>();
  for (const x of p) {
    if (x.band !== 'likely_90d') continue;
    const list = flaggedAt.get(x.contactId) ?? [];
    list.push(x.predictedAt);
    flaggedAt.set(x.contactId, list);
  }
  const dealsBy = new Map<string, number[]>();
  for (const d of deals) {
    if (!flaggedAt.has(d.contactId)) continue;
    const list = dealsBy.get(d.contactId) ?? [];
    list.push(d.closedAt);
    dealsBy.set(d.contactId, list);
  }
  let transacted = 0;
  for (const [contact, times] of flaggedAt) {
    const closes = dealsBy.get(contact) ?? [];
    if (times.some((t) => closes.some((c) => c > t && c - t <= windowMs))) transacted += 1;
  }
  return { flagged: flaggedAt.size, transacted };
}

/** The four prediction_models back-test columns. */
export function backtestSummary(r: BacktestResult, windowDays: number, dataset: string): BacktestSummary {
  return { flagged: r.flagged, transacted: r.transacted, windowDays, dataset: dataset.trim() };
}
