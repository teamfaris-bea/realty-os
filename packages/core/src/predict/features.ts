// Runtime guard for prediction inputs (R-PRED-1, E120). The compile-time type already admits only the six
// allowed facts; this is the same rule for untrusted data (API bodies, stored rows). Any other key is
// refused, and named by the shared fair-housing vocabulary when it is a protected class, a proxy,
// geography, a life event, prediction output or identity.
import { classifyAttributeKey } from '../fairhousing/index.js';
import { EQUITY_BANDS, FEATURE_NAME_OF, type FeatureIssue, type FeatureKey, type PredictionFeatures } from './types.js';

/** Inclusive integer ranges for the numeric features. VERIFY: upper bounds are sanity limits, not policy. */
export const FEATURE_RANGES = {
  yearsInHome: { min: 0, max: 150 },
  recentSaves: { min: 0, max: 10_000 },
  statedTimelineDays: { min: 0, max: 3_650 },
  pastClientYears: { min: 0, max: 150 },
} as const satisfies Partial<Record<FeatureKey, { min: number; max: number }>>;

const KEY_SET: ReadonlySet<string> = new Set(Object.keys(FEATURE_NAME_OF));

const CATEGORY_WORDS = {
  protected_class: 'a protected class',
  protected_proxy: 'a stand-in for a protected class',
  geography: 'geography',
  prediction_output: 'prediction output',
  life_event: 'a life event',
  identity: 'personal identity',
} as const;

/** True when `v` is a valid value for feature key `k` (shared by the guard and by `score`). */
export function isValidFeatureValue(k: FeatureKey, v: unknown): boolean {
  switch (k) {
    case 'equityBand':
      return typeof v === 'string' && (EQUITY_BANDS as readonly string[]).includes(v);
    case 'recentPermit':
      return typeof v === 'boolean';
    default: {
      const r = FEATURE_RANGES[k];
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= r.min && v <= r.max;
    }
  }
}

function describeValue(k: FeatureKey): string {
  switch (k) {
    case 'equityBand':
      return 'one of low, mid, high';
    case 'recentPermit':
      return 'true or false';
    default: {
      const r = FEATURE_RANGES[k];
      return `a whole number from ${r.min} to ${r.max}`;
    }
  }
}

export type ParseFeaturesResult =
  | { ok: true; features: PredictionFeatures }
  | { ok: false; code: 'PREDICTION_FEATURES_INVALID'; issues: FeatureIssue[] };

/**
 * Accepts only a plain object whose own keys are among the six, each with a valid value. Refuses
 * inherited keys (non-plain prototypes), symbol keys, accessors, nested objects and every other key.
 */
export function parseFeatures(raw: unknown): ParseFeaturesResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'PREDICTION_FEATURES_INVALID', issues: [{ key: '', kind: 'not_an_object', message: 'features must be a plain object' }] };
  }
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, code: 'PREDICTION_FEATURES_INVALID', issues: [{ key: '', kind: 'not_an_object', message: 'features must be a plain object (no prototype chain)' }] };
  }
  const issues: FeatureIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === 'symbol') {
      issues.push({ key: String(key), kind: 'not_allowed', message: 'symbol keys are not allowed' });
      continue;
    }
    if (!KEY_SET.has(key)) {
      const cat = classifyAttributeKey(key);
      issues.push(
        cat === null
          ? { key, kind: 'not_allowed', message: `${key}: not an allowed feature` }
          : { key, kind: cat, message: `${key}: ${CATEGORY_WORDS[cat]} can never be a prediction input` },
      );
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc === undefined || !('value' in desc)) {
      issues.push({ key, kind: 'invalid_value', message: `${key}: must be a plain value` });
      continue;
    }
    const k = key as FeatureKey;
    if (desc.value === undefined) continue; // absent
    if (!isValidFeatureValue(k, desc.value)) {
      issues.push({ key, kind: 'invalid_value', message: `${key}: must be ${describeValue(k)}` });
      continue;
    }
    out[k] = desc.value;
  }
  if (issues.length > 0) return { ok: false, code: 'PREDICTION_FEATURES_INVALID', issues };
  return { ok: true, features: out as PredictionFeatures };
}

/** Only the six keys of `f` that are own data properties with a valid value (for scoring and hashing). */
export function presentFeatures(f: PredictionFeatures): PredictionFeatures {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(FEATURE_NAME_OF) as FeatureKey[]) {
    const desc = Object.getOwnPropertyDescriptor(f, k);
    if (desc === undefined || !('value' in desc)) continue; // only own data properties count
    const v: unknown = desc.value;
    if (v !== undefined && isValidFeatureValue(k, v)) out[k] = v;
  }
  return out as PredictionFeatures;
}

