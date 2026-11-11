// @realty/core/predict — public interface of PHASE2_3_PLAN module 49: a deterministic, explainable
// scorecard over six allowed property and first-party facts (R-PRED-1..6). Bands and reasons only; no
// probability anywhere. Never imported by ownership, priority, ads, portal or messaging code
// (realty/no-prediction-import, R-PRED-4).
export * from './types.js';
export { FEATURE_RANGES, isValidFeatureValue, parseFeatures, presentFeatures, type ParseFeaturesResult } from './features.js';
export {
  BACKTEST_WINDOW_DAYS,
  MAX_BAND_THRESHOLD,
  MAX_RULE_POINTS,
  MODEL_VERSION_RE,
  isFeatureName,
  isModelLive,
  requireApproved,
  validateModel,
  type RequireApprovedResult,
  type ValidateModelResult,
} from './model.js';
export { evidenceRefString, inputsSha256, reasonsCiteModel, score, scoreWithModel, storedReasons, type ScoreWithModelResult } from './score.js';
export {
  EQUITY_RATIO_BANDS,
  attachPropertyRecord,
  derivePropertyFeatures,
  normalizeAddress,
  normalizeOwnerName,
  type AttachContact,
  type AttachDecision,
  type PostalAddress,
  type PropertyFacts,
  type PropertyRecordCandidate,
} from './property.js';
export {
  backtestText,
  isPredictionVisible,
  listableForOutreach,
  predictionFeedCard,
  visiblePredictions,
  type FeedBand,
  type OutreachContact,
  type PredictionFeedCard,
} from './card.js';
export { backtest, backtestSummary, type BacktestResult } from './backtest.js';
