// Named settings of module 50 (VERIFY with the vendor, N13; VERIFY WITH COUNSEL, R-DATA-6, C4). Every value the
// plan leaves open is here, in one place, so it can change without touching the pass.

export interface PredictSettings {
  /** an attached or no-facts record older than this is looked up again (VERIFY with the vendor: refresh terms) */
  refreshAgeDays: number;
  /** lookups per tenant and local date: rows fetched today plus the lookups this pass made (VERIFY: cost, rate limits) */
  lookupBudgetPerDay: number;
  /** property_records.retention_until = fetched_at + this; at most 12 months (R-DATA-6; VERIFY WITH COUNSEL, licence term) */
  recordRetentionDays: number;
  /** the pass acts only while the tenant's local hour is in [nightStartHour, nightEndHour) */
  nightStartHour: number;
  nightEndHour: number;
  /** recent_saves counts listing_saved facts in this many days (VERIFY WITH COUNSEL, C4) */
  recentSavesWindowDays: number;
  /** contacts scored per transaction */
  batchSize: number;
  /** candidate addresses read per transaction (the lookups run outside any transaction) */
  lookupPageSize: number;
}

export const PREDICT_SETTINGS: Readonly<PredictSettings> = Object.freeze({
  refreshAgeDays: 90,
  lookupBudgetPerDay: 200,
  recordRetentionDays: 365,
  nightStartHour: 1,
  nightEndHour: 5,
  recentSavesWindowDays: 90,
  batchSize: 500,
  lookupPageSize: 200,
});

/** The longest record retention the plan allows (R-DATA-6: property records per licence, at most 12 months). */
export const MAX_RECORD_RETENTION_DAYS = 365;

/** The pass is woken hourly; it acts only in the tenant's night window (R-OWN-27: nightly per tenant and date). */
export const PREDICT_PASS_EVERY_MS = 60 * 60_000;

/**
 * The fixed feed score of a likely-to-move card per band: never the scorecard's point total (R-PRED-3). Low on
 * purpose: a prediction is a prompt to think about someone, below the day's due work.
 */
export const BAND_CARD_SCORE = Object.freeze({ likely_90d: 30, watch: 15 } as const);

/** The band in words, the first line of a card (no probability, R-PRED-3). */
export const BAND_WORDS = Object.freeze({
  likely_90d: 'Scorecard band: may move in the next 90 days',
  watch: 'Scorecard band: worth keeping an eye on',
} as const);

export function resolveSettings(o: Partial<PredictSettings> = {}): PredictSettings {
  const s = { ...PREDICT_SETTINGS, ...o };
  if (!(s.recordRetentionDays >= 1 && s.recordRetentionDays <= MAX_RECORD_RETENTION_DAYS)) throw new RangeError('recordRetentionDays: 1 to 365 (R-DATA-6)');
  if (!(s.lookupBudgetPerDay >= 0 && Number.isSafeInteger(s.lookupBudgetPerDay))) throw new RangeError('lookupBudgetPerDay: a whole number ≥ 0');
  if (!(s.refreshAgeDays >= 1)) throw new RangeError('refreshAgeDays ≥ 1');
  if (!(s.nightStartHour >= 0 && s.nightStartHour < s.nightEndHour && s.nightEndHour <= 24)) throw new RangeError('night window');
  if (!(s.recentSavesWindowDays >= 1)) throw new RangeError('recentSavesWindowDays ≥ 1');
  if (!(s.batchSize >= 1)) throw new RangeError('batchSize ≥ 1');
  if (!(s.lookupPageSize >= 1)) throw new RangeError('lookupPageSize ≥ 1');
  return s;
}
