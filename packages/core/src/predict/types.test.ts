import { describe, expect, expectTypeOf, it } from 'vitest';
import { FEATURE_KEY, FEATURE_NAME_OF, FEATURE_NAMES, score, type ExactFeatures, type FeatureName, type PredictionFeatures, type Reason, type ScoreResult } from './index.js';
import { APPROVED, withStatus } from './testing/fixtures.js';

// The DB allowlist, copied from 0018 prediction_models.features CHECK.
const DB_ALLOWLIST = ['years_in_home', 'equity_band', 'recent_saves', 'stated_timeline_days', 'past_client_years', 'recent_permit'];

describe('prediction feature type (R-PRED-1, E120)', () => {
  it('R-PRED-1 E120: compile time: a self-reported PCS timeline, age, ZIP, household, life event or name is not representable', () => {
    const ok: PredictionFeatures = { yearsInHome: 12, equityBand: 'high', recentSaves: 3, statedTimelineDays: 60, pastClientYears: 6, recentPermit: true };
    expect(Object.keys(ok)).toHaveLength(6);
    // @ts-expect-error E120: a PCS timeline is not a prediction feature
    const pcs: PredictionFeatures = { statedTimelineDays: 60, pcsTimeline: 90 };
    // @ts-expect-error age is a protected class
    const age: PredictionFeatures = { yearsInHome: 3, age: 64 };
    // @ts-expect-error ZIP is geography
    const zip: PredictionFeatures = { zip: '30301' };
    // @ts-expect-error household composition
    const hh: PredictionFeatures = { householdSize: 4 };
    // @ts-expect-error life events are cut
    const le: PredictionFeatures = { lifeEvent: 'divorce' };
    // @ts-expect-error names are identity
    const nm: PredictionFeatures = { name: 'Pat' };
    // @ts-expect-error only low, mid, high
    const eq: PredictionFeatures = { equityBand: 'very_high' };
    expect([pcs, age, zip, hh, le, nm, eq]).toHaveLength(7);
  });

  it('R-PRED-1 E120: compile time: a widened object carrying an extra key cannot be scored', () => {
    const withPcs = { statedTimelineDays: 60, pcsTimeline: 90 };
    // @ts-expect-error E120: pcsTimeline becomes never in ExactFeatures
    score(withPcs, APPROVED);
    const withAge = { yearsInHome: 12, age: 70 };
    // @ts-expect-error age becomes never
    score(withAge, APPROVED);
    expectTypeOf<ExactFeatures<{ yearsInHome: number; zip: string }>['zip']>().toEqualTypeOf<never>();
    expect(score({ yearsInHome: 12, recentPermit: true }, APPROVED).band).toBeDefined();
  });

  it('R-PRED-5: compile time: score accepts only an approved model', () => {
    // @ts-expect-error a withdrawn model is not an ApprovedModel
    expect(() => score({ yearsInHome: 12 }, withStatus(APPROVED, 'withdrawn'))).toThrow(TypeError);
  });

  it('R-PRED-1: the six feature names equal the DB allowlist and the camelCase map is its exact inverse', () => {
    expect([...FEATURE_NAMES]).toEqual(DB_ALLOWLIST);
    expect(Object.keys(FEATURE_KEY).sort()).toEqual([...DB_ALLOWLIST].sort());
    for (const n of FEATURE_NAMES) expect(FEATURE_NAME_OF[FEATURE_KEY[n]]).toBe(n);
    expect(Object.keys(FEATURE_NAME_OF)).toHaveLength(6);
    expectTypeOf<keyof PredictionFeatures>().toEqualTypeOf<(typeof FEATURE_KEY)[FeatureName]>();
  });

  it('R-PRED-3: compile time: output types carry no probability, confidence, percent or likelihood', () => {
    expectTypeOf<keyof ScoreResult>().toEqualTypeOf<'band' | 'reasons'>();
    expectTypeOf<keyof Reason>().toEqualTypeOf<'feature' | 'points' | 'evidence' | 'text'>();
  });
});
