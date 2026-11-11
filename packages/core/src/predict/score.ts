// Deterministic scorecard (R-PRED-1, R-PRED-3). Integer points per matched rule; only the model's own
// features count (a present feature the model does not name is ignored, never a reason); fewer present
// model features than `minFeaturesPresent` ⇒ not_enough_data with no reasons. The output is a band and
// reasons — never a probability, confidence, percentage or likelihood.
import { sha256Hex, canonicalJson } from '../compliance/index.js';
import { isValidFeatureValue, parseFeatures, presentFeatures } from './features.js';
import { MAX_RULE_POINTS, requireApproved } from './model.js';
import {
  FEATURE_KEY,
  FEATURE_NAMES,
  type ApprovedModel,
  type Band,
  type EquityBand,
  type ExactFeatures,
  type FeatureEvidence,
  type FeatureIssue,
  type FeatureName,
  type FeatureRule,
  type PredictionFeatures,
  type Reason,
  type ScoreResult,
  type StoredReason,
} from './types.js';

type FeatureValue = number | boolean | EquityBand;

function rulePoints(rule: FeatureRule, v: FeatureValue): number {
  if (rule.feature === 'equity_band') return typeof v === 'string' ? (rule.points[v] ?? 0) : 0;
  if (rule.feature === 'recent_permit') return v === true ? rule.whenTrue : 0;
  if (typeof v !== 'number') return 0;
  for (const s of rule.steps) {
    if ((s.min === undefined || v >= s.min) && (s.max === undefined || v <= s.max)) return s.points;
  }
  return 0;
}

/** Points that are not a safe non-negative integer count as zero (a corrupt rule never makes a band). */
const safePoints = (p: unknown): number => (typeof p === 'number' && Number.isSafeInteger(p) && p > 0 && p <= MAX_RULE_POINTS ? p : 0);

function reasonText(feature: FeatureName, v: FeatureValue): string {
  switch (feature) {
    case 'years_in_home':
      return v === 1 ? '1 year in the home' : `${String(v)} years in the home`;
    case 'equity_band':
      return `Estimated equity: ${String(v)}`;
    case 'recent_saves':
      return v === 1 ? 'Saved 1 listing recently' : `Saved ${String(v)} listings recently`;
    case 'stated_timeline_days':
      return `Said they plan to move within ${String(v)} days`;
    case 'past_client_years':
      return v === 1 ? 'Past client, last deal 1 year ago' : `Past client, last deal ${String(v)} years ago`;
    case 'recent_permit':
      return 'Recent building permit on the property';
  }
}

const ORDER: Readonly<Record<FeatureName, number>> = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i])) as Record<FeatureName, number>;

/**
 * Scores `f` with an approved model. Deterministic and total: the same inputs give the same band and the
 * same reasons in the same order (points descending, then the allowlist order).
 * Throws on a model that is not approved — that is a programming error; use `scoreWithModel` for
 * untrusted models (it returns PREDICTION_MODEL_NOT_APPROVED).
 */
export function score<F extends PredictionFeatures>(f: ExactFeatures<F>, m: ApprovedModel, evidence: FeatureEvidence = {}): ScoreResult {
  if (m.status !== 'approved') throw new TypeError('score: only an approved model can score (R-PRED-5)');
  const present = presentFeatures(f) as Record<string, FeatureValue | undefined>;
  const modelFeatures = FEATURE_NAMES.filter((n) => m.features.includes(n));
  const presentInModel = modelFeatures.filter((n) => present[FEATURE_KEY[n]] !== undefined);
  if (presentInModel.length < m.minFeaturesPresent) return { band: 'not_enough_data', reasons: [] };

  const reasons: Reason[] = [];
  const used = new Set<FeatureName>();
  for (const rule of m.rules) {
    const feature = rule.feature;
    if (!modelFeatures.includes(feature) || used.has(feature)) continue; // a rule outside the model never counts
    used.add(feature);
    const key = FEATURE_KEY[feature];
    const v = present[key];
    if (v === undefined || !isValidFeatureValue(key, v)) continue;
    const points = safePoints(rulePoints(rule, v));
    if (points === 0) continue;
    reasons.push({ feature, points, evidence: evidence[feature] ?? { sourceType: 'features_input', field: key }, text: reasonText(feature, v) });
  }
  reasons.sort((a, b) => b.points - a.points || ORDER[a.feature] - ORDER[b.feature]);
  const total = reasons.reduce((s, r) => s + r.points, 0);
  const { likely, watch } = m.bandThresholds;
  const band: Band = reasons.length > 0 && total >= likely ? 'likely_90d' : reasons.length > 0 && total >= watch && watch >= 1 ? 'watch' : 'none';
  return { band, reasons };
}

/** contact_predictions.inputs_sha256: canonical JSON of the present valid features and the model version. */
export function inputsSha256(f: PredictionFeatures, modelVersion: string): string {
  return sha256Hex(canonicalJson({ features: presentFeatures(f), modelVersion }));
}

export type ScoreWithModelResult =
  | { ok: true; modelVersion: string; result: ScoreResult; inputsSha256: string }
  | { ok: false; code: 'PREDICTION_MODEL_NOT_APPROVED'; status: string }
  | { ok: false; code: 'PREDICTION_MODEL_INVALID'; issues: string[] }
  | { ok: false; code: 'PREDICTION_FEATURES_INVALID'; issues: FeatureIssue[] };

/**
 * The untrusted-input entry point: validates the model (draft/withdrawn ⇒ PREDICTION_MODEL_NOT_APPROVED,
 * R-PRED-5/E144) and the features (R-PRED-1/E120), then scores.
 */
export function scoreWithModel(raw: unknown, model: unknown, evidence: FeatureEvidence = {}): ScoreWithModelResult {
  const m = requireApproved(model);
  if (!m.ok) return m;
  const parsed = parseFeatures(raw);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    modelVersion: m.model.version,
    result: score(parsed.features, m.model, evidence),
    inputsSha256: inputsSha256(parsed.features, m.model.version),
  };
}

/** The evidence_ref string stored in contact_predictions.reasons. */
export function evidenceRefString(r: Reason): string {
  const e = r.evidence;
  return e.sourceType === 'features_input' ? `features_input#${e.field}` : `${e.sourceType}:${e.sourceId}#${e.field}`;
}

/** contact_predictions.reasons ([{feature, points, evidence_ref}]); the DB trigger re-checks the features. */
export function storedReasons(reasons: readonly Reason[]): StoredReason[] {
  return reasons.map((r) => ({ feature: r.feature, points: r.points, evidence_ref: evidenceRefString(r) }));
}

/** True when every reason cites a feature of the model (the contact_predictions_guard trigger, in core). */
export function reasonsCiteModel(reasons: readonly { feature: string }[], m: { features: readonly string[] }): boolean {
  return reasons.every((r) => m.features.includes(r.feature));
}
