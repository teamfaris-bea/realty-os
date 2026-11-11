// @realty/core/insights — public interface of PHASE2_3_PLAN module 32: owner view (dollars by
// source, velocity shaping, 90-day forecast), goal pace and the weekly plan.
// Rules: R-OWNER-1 (core part), R-OWNER-2, R-OWNER-3, R-OWNER-4, R-PLAN-1, R-PLAN-3; E107–E111.
// Pure: no I/O, no clock (now is injected), no randomness. Other modules import only from here.
export * from './types.js';
export { divRoundHalfUp, formatCents } from './money.js';
export { sourceDollars, costPerClosing } from './sources.js';
export {
  forecast,
  forecastBoth,
  forecastRangeWords,
  stageSamples,
  wilsonInterval,
  WILSON_Z_80,
  FORECAST_HORIZON_DAYS,
  FORECAST_LOOKBACK_DAYS,
  FORECAST_MIN_SAMPLE,
} from './forecast.js';
export { goalPace, periodEnd, metricWords } from './pace.js';
export { planWeek, dropInvisible, comparePlanItems, PLAN_MAX_ITEMS, PLAN_MIN_ITEMS, type PlanWeekInput } from './plan.js';
export { velocityRows } from './velocity.js';

/** Codes core/insights can return as `{ ok: false, code }` (none: every function is total on valid input). */
export type InsightsErrorCode = never;
