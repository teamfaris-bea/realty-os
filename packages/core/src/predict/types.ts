// core/predict types (PHASE2_3_PLAN #49; DATA_MODEL R-PRED-1..6).
//
// A deterministic, counsel-reviewable scorecard — not an ML model (PHASE2_3_PLAN §3). The feature type
// can express exactly the six allowed property and first-party facts that `prediction_models.features`
// allows (DB CHECK); nothing else — no protected class, proxy, name, demographic, household, geography or
// life event (R-PRED-1, E120). Output is a band with reasons and evidence; no probability, confidence,
// percentage or likelihood appears in any output type (R-PRED-3).
// **VERIFY WITH COUNSEL**: the feature list itself, and every point value in any model.
import type { ContactId, Instant } from '../foundation/index.js';

/** The six allowed features, spelled as the DB allowlist spells them (0018 prediction_models.features). */
export const FEATURE_NAMES = [
  'years_in_home',
  'equity_band',
  'recent_saves',
  'stated_timeline_days',
  'past_client_years',
  'recent_permit',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export type EquityBand = 'low' | 'mid' | 'high';
export const EQUITY_BANDS: readonly EquityBand[] = ['low', 'mid', 'high'];

/**
 * Prediction inputs. Nothing else is expressible (the DB allowlist mirrors it). Every key is optional:
 * a missing fact is simply absent, never guessed.
 */
export type PredictionFeatures = {
  yearsInHome?: number;
  equityBand?: EquityBand;
  recentSaves?: number;
  statedTimelineDays?: number;
  pastClientYears?: number;
  recentPermit?: boolean;
};
export type FeatureKey = keyof PredictionFeatures;

/** DB name → camelCase key. */
export const FEATURE_KEY = {
  years_in_home: 'yearsInHome',
  equity_band: 'equityBand',
  recent_saves: 'recentSaves',
  stated_timeline_days: 'statedTimelineDays',
  past_client_years: 'pastClientYears',
  recent_permit: 'recentPermit',
} as const satisfies Record<FeatureName, FeatureKey>;

// Compile-time: the two lists agree in both directions (a seventh key on either side fails to build).
type _KeysCoverType = Exclude<FeatureKey, (typeof FEATURE_KEY)[FeatureName]> extends never ? true : never;
type _NamesCoverMap = Exclude<keyof typeof FEATURE_KEY, FeatureName> extends never ? true : never;
const _featureListsAgree: [_KeysCoverType, _NamesCoverMap] = [true, true];
void _featureListsAgree;

/** camelCase key → DB name. */
export const FEATURE_NAME_OF: Readonly<Record<FeatureKey, FeatureName>> = {
  yearsInHome: 'years_in_home',
  equityBand: 'equity_band',
  recentSaves: 'recent_saves',
  statedTimelineDays: 'stated_timeline_days',
  pastClientYears: 'past_client_years',
  recentPermit: 'recent_permit',
};

/**
 * `F` exactly: any key outside the six becomes `never`, so a widened object carrying `age`, `zip`,
 * `pcsTimeline`, ... does not type-check even when it is not a fresh literal (E120).
 */
export type ExactFeatures<F> = F & { [K in Exclude<keyof F, FeatureKey>]: never };

export type NumericFeatureName = 'years_in_home' | 'recent_saves' | 'stated_timeline_days' | 'past_client_years';

/** Inclusive range → points. The first step that matches wins. */
export type ThresholdStep = { min?: number; max?: number; points: number };

export type FeatureRule =
  | { feature: NumericFeatureName; steps: ThresholdStep[] }
  | { feature: 'equity_band'; points: Partial<Record<EquityBand, number>> }
  | { feature: 'recent_permit'; whenTrue: number };

export type ModelStatus = 'draft' | 'approved' | 'withdrawn';

/** The platform back-test stored on prediction_models (all four columns or none). */
export type BacktestSummary = { flagged: number; transacted: number; windowDays: number; dataset: string };

export type ScorecardModel = {
  /** '^predict/[0-9]+\.[0-9]+$' */
  version: string;
  status: ModelStatus;
  features: FeatureName[];
  rules: FeatureRule[];
  /** Integer point totals: total ≥ likely ⇒ likely_90d; total ≥ watch ⇒ watch. 1 ≤ watch < likely. */
  bandThresholds: { likely: number; watch: number };
  /** Fewer model features present than this ⇒ not_enough_data. */
  minFeaturesPresent: number;
  /** ISO timestamp of the recorded counsel review; required when approved. */
  counselReviewedAt?: string | null;
  backtest?: BacktestSummary | null;
};

/** A model that passed `validateModel` with status approved: the only kind `score` accepts (R-PRED-1/5). */
export type ApprovedModel = ScorecardModel & { status: 'approved'; counselReviewedAt: string; backtest: BacktestSummary };

export type Band = 'likely_90d' | 'watch' | 'none' | 'not_enough_data';

export type EvidenceSourceType = 'property_record' | 'saved_search_activity' | 'contact_field' | 'deal' | 'note';

/** Where a reason's fact came from. `features_input` names the input key when the caller gave no source. */
export type EvidenceRef =
  | { sourceType: EvidenceSourceType; sourceId: string; field: string }
  | { sourceType: 'features_input'; field: FeatureKey };

export type FeatureEvidence = Partial<Record<FeatureName, Extract<EvidenceRef, { sourceType: EvidenceSourceType }>>>;

export type Reason = {
  feature: FeatureName;
  /** Integer points this feature added (always ≥ 1). */
  points: number;
  evidence: EvidenceRef;
  /** Short plain explanation shown on the card. */
  text: string;
};

export type ScoreResult = { band: Band; reasons: Reason[] };

/** contact_predictions.reasons element ([{feature, points, evidence_ref}]). */
export type StoredReason = { feature: FeatureName; points: number; evidence_ref: string };

export type PredictErrorCode =
  | 'PREDICTION_MODEL_NOT_APPROVED'
  | 'PREDICTION_MODEL_INVALID'
  | 'PREDICTION_FEATURES_INVALID';

export type FeatureIssueKind =
  | 'protected_class'
  | 'protected_proxy'
  | 'geography'
  | 'prediction_output'
  | 'life_event'
  | 'identity'
  | 'not_allowed'
  | 'invalid_value'
  | 'not_an_object';

export type FeatureIssue = { key: string; kind: FeatureIssueKind; message: string };

/** One stored prediction, as the back-test and the feed read it. */
export type StoredPrediction = { contactId: ContactId; modelVersion: string; band: Band; reasons: Reason[] };

export type BacktestPrediction = { contactId: ContactId; band: Band; predictedAt: Instant };
export type BacktestDeal = { contactId: ContactId; closedAt: Instant };
