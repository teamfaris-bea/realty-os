// Test fixtures for core/predict. The point values are PLACEHOLDERS for tests only — no counsel-reviewed
// model exists yet (VERIFY WITH COUNSEL); real models are platform-released rows of prediction_models.
import type { ContactId } from '../../foundation/index.js';
import type { ApprovedModel, ScorecardModel } from '../types.js';

export const cid = (n: number): ContactId => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as ContactId;

export const APPROVED: ApprovedModel = {
  version: 'predict/1.0',
  status: 'approved',
  features: ['years_in_home', 'equity_band', 'recent_saves', 'stated_timeline_days', 'past_client_years', 'recent_permit'],
  rules: [
    { feature: 'years_in_home', steps: [{ min: 10, points: 20 }, { min: 6, max: 9, points: 10 }] },
    { feature: 'equity_band', points: { high: 20, mid: 10 } },
    { feature: 'recent_saves', steps: [{ min: 5, points: 25 }, { min: 1, max: 4, points: 10 }] },
    { feature: 'stated_timeline_days', steps: [{ max: 90, points: 40 }, { min: 91, max: 180, points: 15 }] },
    { feature: 'past_client_years', steps: [{ min: 5, points: 10 }] },
    { feature: 'recent_permit', whenTrue: 10 },
  ],
  bandThresholds: { likely: 60, watch: 30 },
  minFeaturesPresent: 2,
  counselReviewedAt: '2026-10-01T00:00:00Z',
  backtest: { flagged: 120, transacted: 31, windowDays: 90, dataset: 'platform back-test 2025 (synthetic fixture)' },
};

/** A narrower approved model: only two property features. */
export const NARROW: ApprovedModel = {
  ...APPROVED,
  version: 'predict/2.0',
  features: ['years_in_home', 'recent_permit'],
  rules: [
    { feature: 'years_in_home', steps: [{ min: 10, points: 40 }] },
    { feature: 'recent_permit', whenTrue: 30 },
  ],
  bandThresholds: { likely: 70, watch: 30 },
  minFeaturesPresent: 1,
};

export const withStatus = (m: ScorecardModel, status: ScorecardModel['status']): ScorecardModel => ({ ...m, status });
