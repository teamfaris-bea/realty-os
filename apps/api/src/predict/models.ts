// Model definitions of module 50 (R-PRED-1, R-PRED-5, E144).
//
// prediction_models (0018) is global and platform-released: it stores a version's status, features, counsel
// review and platform back-test, but no column for the scorecard's rules, band thresholds or minimum features.
// Those live here, one frozen definition per version. A version scores only while ALL of:
//   - its prediction_models row is approved (counsel reviewed, with its back-test: the 0018 CHECKs);
//   - a definition exists for it here;
//   - the row's features equal the definition's features (as a set), and the merged model passes core
//     requireApproved (every rule cites a feature of its own model).
// Otherwise nothing is written for that version and the pass raises WORKER_ERROR with reason
// PREDICTION_MODEL_INVALID (ids and codes only, R-TEN-7).
//
// The registry SHIPS EMPTY: 0018 seeds prediction_models empty, a fresh database must hold no model
// (rls_smoke_p23), and no point value ships before a counsel-reviewed model exists (core/predict model.ts;
// VERIFY WITH COUNSEL, C4). Releasing a model is the platform's job (a definition here plus its row, the row
// born draft or withdrawn, then approved by the platform after counsel review). No app code inserts, approves or
// withdraws a prediction_models row. Tests register synthetic definitions through an injected registry
// (predict/testing.ts), never this one.
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type ApprovedModel, type FeatureName, type ScorecardModel, requireApproved } from '@realty/core/predict';

/** What a version's definition carries beyond its row. */
export type ModelDefinition = Readonly<Pick<ScorecardModel, 'version' | 'features' | 'rules' | 'bandThresholds' | 'minFeaturesPresent'>>;
export type ModelRegistry = ReadonlyMap<string, ModelDefinition>;

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

/** Freezes a definition (and every nested rule) so it cannot change after release. */
export function defineModel(d: ModelDefinition): ModelDefinition {
  return deepFreeze(structuredClone(d) as ModelDefinition);
}

/** The released definitions, keyed by version. Empty until a counsel-reviewed model exists. */
const RELEASED: readonly ModelDefinition[] = Object.freeze([]);
export const MODEL_DEFINITIONS: ModelRegistry = new Map(RELEASED.map((d) => [d.version, d]));

/** A definition's content hash (the snapshot test pins each one: a changed point value is a new version). */
export function definitionSha256(d: ModelDefinition): string {
  return sha256Hex(canonicalJson({ version: d.version, features: [...d.features].sort(), rules: d.rules, bandThresholds: d.bandThresholds, minFeaturesPresent: d.minFeaturesPresent }));
}

/** One prediction_models row as the pass reads it. */
export interface ModelRow {
  version: string;
  status: string;
  features: string[];
  counsel_reviewed_at: Date | null;
  backtest_flagged: number | null;
  backtest_transacted: number | null;
  backtest_window_days: number | null;
  backtest_dataset: string | null;
}

export type ModelInvalidReason = 'no_definition' | 'features_differ' | 'definition_invalid';
export type ResolvedModels = { scoring: ApprovedModel[]; invalid: { version: string; reason: ModelInvalidReason }[] };

const sameSet = (a: readonly string[], b: readonly string[]) => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

/** The approved rows that can score, and those that cannot (with why). Draft and withdrawn rows are neither. */
export function resolveModels(rows: readonly ModelRow[], registry: ModelRegistry): ResolvedModels {
  const scoring: ApprovedModel[] = [];
  const invalid: ResolvedModels['invalid'] = [];
  for (const row of [...rows].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))) {
    if (row.status !== 'approved') continue;
    const def = registry.get(row.version);
    if (def === undefined || def.version !== row.version) {
      invalid.push({ version: row.version, reason: 'no_definition' });
      continue;
    }
    if (!sameSet(row.features, def.features)) {
      invalid.push({ version: row.version, reason: 'features_differ' });
      continue;
    }
    const merged = {
      version: row.version,
      status: row.status,
      features: [...def.features] as FeatureName[],
      rules: structuredClone(def.rules) as ScorecardModel['rules'],
      bandThresholds: { ...def.bandThresholds },
      minFeaturesPresent: def.minFeaturesPresent,
      counselReviewedAt: row.counsel_reviewed_at ? row.counsel_reviewed_at.toISOString() : null,
      backtest:
        row.backtest_flagged === null || row.backtest_transacted === null || row.backtest_window_days === null || row.backtest_dataset === null
          ? null
          : { flagged: row.backtest_flagged, transacted: row.backtest_transacted, windowDays: row.backtest_window_days, dataset: row.backtest_dataset },
    };
    const r = requireApproved(merged);
    if (!r.ok) {
      invalid.push({ version: row.version, reason: 'definition_invalid' });
      continue;
    }
    scoring.push(r.model);
  }
  return { scoring, invalid };
}

/** The property features: a lookup is made only while a model that can score names one of them. */
export const PROPERTY_FEATURES: readonly FeatureName[] = Object.freeze(['years_in_home', 'equity_band', 'recent_permit']);

export function needsPropertyRecords(models: readonly Pick<ScorecardModel, 'features'>[]): boolean {
  return models.some((m) => m.features.some((f) => PROPERTY_FEATURES.includes(f)));
}
