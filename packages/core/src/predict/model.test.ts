import { describe, expect, it } from 'vitest';
import { requireApproved, validateModel, type ScorecardModel } from './index.js';
import { APPROVED, withStatus } from './testing/fixtures.js';

const issues = (m: unknown): string[] => {
  const r = validateModel(m);
  return r.ok ? [] : r.issues;
};

describe('validateModel mirrors prediction_models CHECKs (R-PRED-1, R-PRED-3)', () => {
  it('R-PRED-1: the fixture model is valid; a draft without review or back-test is valid too', () => {
    expect(validateModel(APPROVED).ok).toBe(true);
    expect(validateModel({ ...APPROVED, status: 'draft', counselReviewedAt: null, backtest: null }).ok).toBe(true);
  });

  it('R-PRED-1: version must match ^predict/[0-9]+.[0-9]+$', () => {
    for (const v of ['predict/1', 'predict/1.0.0', 'Predict/1.0', 'predict/1.x', ' predict/1.0']) expect(issues({ ...APPROVED, version: v })).not.toEqual([]);
    expect(issues({ ...APPROVED, version: 'predict/12.34' })).toEqual([]);
  });

  it('R-PRED-1: model features ⊆ the allowlist, non-empty, no duplicates', () => {
    expect(issues({ ...APPROVED, features: [] })).not.toEqual([]);
    expect(issues({ ...APPROVED, features: [...APPROVED.features, 'zip_code'] }).join()).toMatch(/zip_code: not an allowed feature \(geography\)/);
    expect(issues({ ...APPROVED, features: [...APPROVED.features, 'household_size'] }).join()).toMatch(/protected proxy/);
    expect(issues({ ...APPROVED, features: ['years_in_home', 'years_in_home'] }).join()).toMatch(/twice/);
  });

  it('R-PRED-1: every rule cites a feature of its own model, at most one rule per feature', () => {
    const m: ScorecardModel = { ...APPROVED, features: ['years_in_home'], minFeaturesPresent: 1 };
    expect(issues(m).join()).toMatch(/is not a feature of this model/);
    expect(issues({ ...APPROVED, rules: [...APPROVED.rules, APPROVED.rules[0]] }).join()).toMatch(/second rule/);
  });

  it('R-PRED-3: approved ⇒ counsel review recorded and a back-test (DB CHECKs)', () => {
    expect(issues({ ...APPROVED, counselReviewedAt: null }).join()).toMatch(/counsel review/);
    expect(issues({ ...APPROVED, backtest: null }).join()).toMatch(/back-test/);
  });

  it('R-PRED-3: back-test is all-or-none, transacted ≤ flagged, window 30..365, dataset 1..300 chars', () => {
    const b = APPROVED.backtest;
    expect(issues({ ...APPROVED, backtest: { ...b, transacted: b.flagged + 1 } }).join()).toMatch(/exceed/);
    expect(issues({ ...APPROVED, backtest: { ...b, windowDays: 29 } })).not.toEqual([]);
    expect(issues({ ...APPROVED, backtest: { ...b, windowDays: 366 } })).not.toEqual([]);
    expect(issues({ ...APPROVED, backtest: { ...b, windowDays: 30 } })).toEqual([]);
    expect(issues({ ...APPROVED, backtest: { ...b, dataset: '   ' } })).not.toEqual([]);
    expect(issues({ ...APPROVED, backtest: { ...b, dataset: 'x'.repeat(301) } })).not.toEqual([]);
    expect(issues({ ...APPROVED, backtest: { flagged: 3 } })).not.toEqual([]);
  });

  it('R-PRED-1: thresholds 1 ≤ watch < likely, integer points 0..100, minFeaturesPresent within the model', () => {
    expect(issues({ ...APPROVED, bandThresholds: { likely: 30, watch: 30 } })).not.toEqual([]);
    expect(issues({ ...APPROVED, bandThresholds: { likely: 30, watch: 0 } })).not.toEqual([]);
    expect(issues({ ...APPROVED, rules: [{ feature: 'recent_permit', whenTrue: 10.5 }] })).not.toEqual([]);
    expect(issues({ ...APPROVED, rules: [{ feature: 'recent_permit', whenTrue: 101 }] })).not.toEqual([]);
    expect(issues({ ...APPROVED, minFeaturesPresent: 7 })).not.toEqual([]);
    expect(issues({ ...APPROVED, minFeaturesPresent: 0 })).not.toEqual([]);
  });

  it('R-PRED-5 E144: requireApproved refuses a draft or withdrawn model', () => {
    expect(requireApproved(withStatus(APPROVED, 'withdrawn'))).toEqual({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED', status: 'withdrawn' });
    expect(requireApproved(withStatus(APPROVED, 'draft'))).toEqual({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED', status: 'draft' });
    expect(requireApproved(APPROVED).ok).toBe(true);
  });
});
