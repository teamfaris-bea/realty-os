// Scorecard model validation: mirrors the prediction_models CHECKs (0018) and adds the rule shape the
// DB stores outside SQL. A model's features ⊆ the allowlist; every rule cites a feature of its own model;
// approved ⇒ counsel reviewed and a platform back-test (R-PRED-1, R-PRED-3, R-PRED-5).
// **VERIFY WITH COUNSEL**: no point value ships before a counsel-reviewed model exists; models ship
// `withdrawn` (or `draft`) until then (PHASE2_3_PLAN #49 "Accept when").
import { classifyAttributeKey } from '../fairhousing/index.js';
import { FEATURE_NAMES, type ApprovedModel, type FeatureName, type NumericFeatureName, type ScorecardModel } from './types.js';

export const MODEL_VERSION_RE = /^predict\/[0-9]+\.[0-9]+$/;
/** Largest points a single rule step may carry; six rules ⇒ a total of at most 600 (no overflow). */
export const MAX_RULE_POINTS = 100;
export const MAX_BAND_THRESHOLD = MAX_RULE_POINTS * FEATURE_NAMES.length;
export const BACKTEST_WINDOW_DAYS = { min: 30, max: 365 } as const;

const FEATURE_SET: ReadonlySet<string> = new Set(FEATURE_NAMES);
const NUMERIC: ReadonlySet<string> = new Set<NumericFeatureName>(['years_in_home', 'recent_saves', 'stated_timeline_days', 'past_client_years']);
const MODEL_KEYS: ReadonlySet<string> = new Set(['version', 'status', 'features', 'rules', 'bandThresholds', 'minFeaturesPresent', 'counselReviewedAt', 'backtest']);
const STATUSES: ReadonlySet<string> = new Set(['draft', 'approved', 'withdrawn']);

export type ValidateModelResult = { ok: true; model: ScorecardModel } | { ok: false; code: 'PREDICTION_MODEL_INVALID'; issues: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPoints = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_RULE_POINTS;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function featureLabel(f: unknown): string {
  if (typeof f !== 'string') return `${String(f)}: a feature name is required`;
  const cat = classifyAttributeKey(f);
  return cat === null ? `${f}: not an allowed feature` : `${f}: not an allowed feature (${cat.replace('_', ' ')})`;
}

/** Structural and policy validation of a scorecard model (any status). */
export function validateModel(m: unknown): ValidateModelResult {
  const issues: string[] = [];
  if (!isObj(m)) return { ok: false, code: 'PREDICTION_MODEL_INVALID', issues: ['model must be an object'] };
  for (const k of Object.keys(m)) if (!MODEL_KEYS.has(k)) issues.push(`${k}: not a model field`);

  if (typeof m.version !== 'string' || !MODEL_VERSION_RE.test(m.version)) issues.push('version: must look like predict/<major>.<minor>');
  if (typeof m.status !== 'string' || !STATUSES.has(m.status)) issues.push('status: must be draft, approved or withdrawn');

  const features: string[] = [];
  if (!Array.isArray(m.features) || m.features.length === 0) issues.push('features: at least one allowed feature is required');
  else {
    for (const f of m.features as unknown[]) {
      if (typeof f !== 'string' || !FEATURE_SET.has(f)) issues.push(`features: ${featureLabel(f)}`);
      else if (features.includes(f)) issues.push(`features: ${f} is listed twice`);
      else features.push(f);
    }
  }

  if (!Array.isArray(m.rules)) issues.push('rules: must be a list');
  else {
    const seen = new Set<string>();
    (m.rules as unknown[]).forEach((r, i) => {
      if (!isObj(r)) return void issues.push(`rules[${i}]: must be an object`);
      const f = r.feature;
      if (typeof f !== 'string' || !FEATURE_SET.has(f)) return void issues.push(`rules[${i}]: ${featureLabel(f)}`);
      if (!features.includes(f)) issues.push(`rules[${i}]: ${f} is not a feature of this model`);
      if (seen.has(f)) issues.push(`rules[${i}]: a second rule for ${f}`);
      seen.add(f);
      const allowedKeys = NUMERIC.has(f) ? ['feature', 'steps'] : f === 'equity_band' ? ['feature', 'points'] : ['feature', 'whenTrue'];
      for (const k of Object.keys(r)) if (!allowedKeys.includes(k)) issues.push(`rules[${i}].${k}: not a field of a ${f} rule`);
      if (NUMERIC.has(f)) {
        if (!Array.isArray(r.steps) || r.steps.length === 0) return void issues.push(`rules[${i}].steps: at least one step is required`);
        (r.steps as unknown[]).forEach((s, j) => {
          if (!isObj(s)) return void issues.push(`rules[${i}].steps[${j}]: must be an object`);
          for (const k of Object.keys(s)) if (!['min', 'max', 'points'].includes(k)) issues.push(`rules[${i}].steps[${j}].${k}: not a step field`);
          if (!isPoints(s.points)) issues.push(`rules[${i}].steps[${j}].points: a whole number from 0 to ${MAX_RULE_POINTS}`);
          if (s.min !== undefined && !isInt(s.min)) issues.push(`rules[${i}].steps[${j}].min: a whole number`);
          if (s.max !== undefined && !isInt(s.max)) issues.push(`rules[${i}].steps[${j}].max: a whole number`);
          if (s.min === undefined && s.max === undefined) issues.push(`rules[${i}].steps[${j}]: needs a min or a max`);
          if (isInt(s.min) && isInt(s.max) && s.min > s.max) issues.push(`rules[${i}].steps[${j}]: min is above max`);
        });
      } else if (f === 'equity_band') {
        if (!isObj(r.points)) return void issues.push(`rules[${i}].points: an object of low/mid/high points`);
        for (const [k, v] of Object.entries(r.points)) {
          if (!['low', 'mid', 'high'].includes(k)) issues.push(`rules[${i}].points.${k}: not an equity band`);
          else if (!isPoints(v)) issues.push(`rules[${i}].points.${k}: a whole number from 0 to ${MAX_RULE_POINTS}`);
        }
      } else if (!isPoints(r.whenTrue)) issues.push(`rules[${i}].whenTrue: a whole number from 0 to ${MAX_RULE_POINTS}`);
    });
  }

  const bt = m.bandThresholds;
  if (!isObj(bt) || !isInt(bt.likely) || !isInt(bt.watch)) issues.push('bandThresholds: whole-number likely and watch thresholds are required');
  else if (!(bt.watch >= 1 && bt.watch < bt.likely && bt.likely <= MAX_BAND_THRESHOLD)) {
    issues.push(`bandThresholds: need 1 ≤ watch < likely ≤ ${MAX_BAND_THRESHOLD}`);
  }

  if (!isInt(m.minFeaturesPresent) || m.minFeaturesPresent < 1 || m.minFeaturesPresent > Math.max(1, features.length)) {
    issues.push('minFeaturesPresent: a whole number from 1 to the number of model features');
  }

  // back-test: all four or none (DB CHECK num_nulls IN (0, 4)), transacted ≤ flagged, window 30..365
  const b = m.backtest;
  if (b !== undefined && b !== null) {
    if (!isObj(b)) issues.push('backtest: must be an object');
    else {
      if (!isInt(b.flagged) || b.flagged < 0) issues.push('backtest.flagged: a whole number ≥ 0');
      if (!isInt(b.transacted) || b.transacted < 0) issues.push('backtest.transacted: a whole number ≥ 0');
      if (isInt(b.flagged) && isInt(b.transacted) && b.transacted > b.flagged) issues.push('backtest: transacted cannot exceed flagged');
      if (!isInt(b.windowDays) || b.windowDays < BACKTEST_WINDOW_DAYS.min || b.windowDays > BACKTEST_WINDOW_DAYS.max) {
        issues.push(`backtest.windowDays: a whole number of days from ${BACKTEST_WINDOW_DAYS.min} to ${BACKTEST_WINDOW_DAYS.max}`);
      }
      const ds = typeof b.dataset === 'string' ? b.dataset.trim() : '';
      if (ds.length < 1 || ds.length > 300) issues.push('backtest.dataset: 1 to 300 characters naming the back-test data');
    }
  }
  const cr = m.counselReviewedAt;
  if (cr !== undefined && cr !== null && (typeof cr !== 'string' || Number.isNaN(Date.parse(cr)))) issues.push('counselReviewedAt: an ISO timestamp');
  if (m.status === 'approved') {
    if (typeof cr !== 'string' || cr === '') issues.push('status: an approved model needs a recorded counsel review');
    if (b === undefined || b === null) issues.push('status: an approved model needs its platform back-test');
  }

  if (issues.length > 0) return { ok: false, code: 'PREDICTION_MODEL_INVALID', issues };
  return { ok: true, model: m as unknown as ScorecardModel };
}

export type RequireApprovedResult =
  | { ok: true; model: ApprovedModel }
  | { ok: false; code: 'PREDICTION_MODEL_INVALID'; issues: string[] }
  | { ok: false; code: 'PREDICTION_MODEL_NOT_APPROVED'; status: string };

/** A valid model that is approved; a draft or withdrawn model produces nothing (R-PRED-5, E144). */
export function requireApproved(m: unknown): RequireApprovedResult {
  const v = validateModel(m);
  if (!v.ok) return v;
  if (v.model.status !== 'approved') return { ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED', status: v.model.status };
  return { ok: true, model: v.model as ApprovedModel };
}

/** True when the model (if any) is approved: predictions of other models are hidden (R-PRED-5). */
export function isModelLive(m: Pick<ScorecardModel, 'status'> | undefined | null): boolean {
  return m?.status === 'approved';
}

export function isFeatureName(s: unknown): s is FeatureName {
  return typeof s === 'string' && FEATURE_SET.has(s);
}
