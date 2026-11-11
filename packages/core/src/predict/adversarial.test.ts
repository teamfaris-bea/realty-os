// Adversarial inputs for core/predict: smuggling protected attributes, forged models and reasons, and
// numeric edge values (R-PRED-1, R-PRED-3, R-PRED-5).
import { describe, expect, it } from 'vitest';
import { parseFeatures, predictionFeedCard, reasonsCiteModel, score, scoreWithModel, validateModel, type ApprovedModel, type PredictionFeatures } from './index.js';
import { APPROVED, NARROW, cid, withStatus } from './testing/fixtures.js';

const kinds = (raw: unknown): string[] => {
  const r = parseFeatures(raw);
  return r.ok ? [] : r.issues.map((i) => `${i.key}:${i.kind}`);
};

describe('adversarial: smuggling attributes into the features (R-PRED-1, E120)', () => {
  it('R-PRED-1 E120: forbidden keys are refused and named by category', () => {
    expect(kinds({ yearsInHome: 3, age: 40 })).toEqual(['age:protected_class']);
    expect(kinds({ pcsTimeline: 90 })).toEqual(['pcsTimeline:life_event']);
    expect(kinds({ zip: '30301' })).toEqual(['zip:geography']);
    expect(kinds({ householdSize: 4 })).toEqual(['householdSize:protected_proxy']);
    expect(kinds({ lifeEvent: 'divorce' })).toEqual(['lifeEvent:life_event']);
    expect(kinds({ name: 'Pat' })).toEqual(['name:identity']);
    expect(kinds({ likelyBand: 'likely_90d' })).toEqual(['likelyBand:prediction_output']);
    expect(kinds({ shoeSize: 9 })).toEqual(['shoeSize:not_allowed']);
  });

  it('R-PRED-1: case and separator tricks on allowed names are refused (one spelling only)', () => {
    for (const k of ['YearsInHome', 'yearsinhome', 'years_in_home', 'years-in-home', 'yearsInHome ', 'yearsInHome​', 'ｙearsInHome']) {
      expect(parseFeatures({ [k]: 3 }).ok, k).toBe(false);
    }
    // case/separator tricks on forbidden names are still classified
    expect(kinds({ Familial_Status: 'x' })).toEqual(['Familial_Status:protected_class']);
    expect(kinds({ 'ZIP-code': '1' })).toEqual(['ZIP-code:geography']);
    expect(kinds({ NATIONAL_ORIGIN: 'x' })).toEqual(['NATIONAL_ORIGIN:protected_class']);
  });

  it('R-PRED-1: __proto__, prototype chains, symbols and accessors cannot carry values', () => {
    const viaJson = JSON.parse('{"yearsInHome": 3, "__proto__": {"age": 70}}') as unknown;
    expect(parseFeatures(viaJson).ok).toBe(false);
    const inherited = Object.create({ age: 70 }) as Record<string, unknown>;
    inherited.yearsInHome = 3;
    expect(parseFeatures(inherited)).toMatchObject({ ok: false, issues: [{ kind: 'not_an_object' }] });
    expect(parseFeatures({ yearsInHome: 3, [Symbol('race')]: 'x' }).ok).toBe(false);
    const getter = {};
    Object.defineProperty(getter, 'yearsInHome', { get: () => 3, enumerable: true });
    expect(parseFeatures(getter)).toMatchObject({ ok: false, issues: [{ key: 'yearsInHome', kind: 'invalid_value' }] });
    const hidden = { yearsInHome: 3 };
    Object.defineProperty(hidden, 'race', { value: 'x', enumerable: false });
    expect(kinds(hidden)).toEqual(['race:protected_class']);
    // null-prototype objects are fine when clean
    const bare = Object.create(null) as Record<string, unknown>;
    bare.recentPermit = true;
    expect(parseFeatures(bare)).toEqual({ ok: true, features: { recentPermit: true } });
  });

  it('R-PRED-1: nested objects, arrays and non-objects are refused', () => {
    expect(parseFeatures({ yearsInHome: { value: 3, age: 70 } }).ok).toBe(false);
    expect(parseFeatures({ equityBand: ['high'] }).ok).toBe(false);
    expect(parseFeatures({ recentPermit: 'true' }).ok).toBe(false);
    for (const raw of [null, undefined, 3, 'x', [], [{ yearsInHome: 3 }], new Map([['yearsInHome', 3]])]) expect(parseFeatures(raw).ok).toBe(false);
  });

  it('R-PRED-1: NaN, Infinity, negatives, fractions and very large values are refused by the guard', () => {
    for (const v of [Number.NaN, Infinity, -Infinity, -1, 2.5, 151, 1e308, Number.MAX_SAFE_INTEGER + 2, '12']) {
      expect(parseFeatures({ yearsInHome: v }).ok, String(v)).toBe(false);
    }
    expect(parseFeatures({ recentSaves: 10_001 }).ok).toBe(false);
    expect(parseFeatures({ statedTimelineDays: 3_651 }).ok).toBe(false);
    expect(parseFeatures({ yearsInHome: 0, recentSaves: 10_000 }).ok).toBe(true);
  });

  it('R-PRED-1: score ignores invalid values that bypass the guard; huge values never make a band without a matching rule', () => {
    const bad = { yearsInHome: Number.NaN, recentSaves: Infinity, statedTimelineDays: -5, pastClientYears: 1e308 } as PredictionFeatures;
    expect(score(bad, APPROVED)).toEqual({ band: 'not_enough_data', reasons: [] });
    // a model whose only rule has a ceiling: a huge in-range value earns nothing above it
    const capped: ApprovedModel = { ...NARROW, rules: [{ feature: 'years_in_home', steps: [{ min: 10, max: 20, points: 40 }] }], minFeaturesPresent: 1 };
    expect(score({ yearsInHome: 150 }, capped)).toEqual({ band: 'none', reasons: [] });
    // corrupt points on an unvalidated model count as zero, never overflow to a band
    const corrupt = { ...NARROW, rules: [{ feature: 'recent_permit', whenTrue: Number.MAX_SAFE_INTEGER }, { feature: 'years_in_home', steps: [{ min: 0, points: Infinity }] }] } as ApprovedModel;
    expect(score({ recentPermit: true, yearsInHome: 3 }, corrupt)).toEqual({ band: 'none', reasons: [] });
  });
});

describe('adversarial: forged models and reasons (R-PRED-1, R-PRED-5)', () => {
  it('R-PRED-1: a model naming a non-allowlisted feature is invalid, wherever it hides', () => {
    expect(validateModel({ ...APPROVED, features: [...APPROVED.features, 'age'] }).ok).toBe(false);
    expect(validateModel({ ...APPROVED, rules: [...APPROVED.rules, { feature: 'zip_code', steps: [{ min: 0, points: 50 }] }] }).ok).toBe(false);
    expect(validateModel({ ...APPROVED, weights: { race: 10 } }).ok).toBe(false);
    expect(validateModel({ ...APPROVED, rules: [{ feature: 'years_in_home', steps: [{ min: 0, points: 5, age: 30 }] }] }).ok).toBe(false);
    expect(validateModel({ ...APPROVED, rules: [{ feature: 'equity_band', points: { high: 5, protected: 50 } }] }).ok).toBe(false);
    expect(validateModel({ ...APPROVED, features: ['Years_In_Home'] }).ok).toBe(false);
  });

  it('R-PRED-1: a rule for a feature outside the model never produces a reason, even on an unvalidated model', () => {
    const forged = { ...NARROW, rules: [...NARROW.rules, { feature: 'stated_timeline_days', steps: [{ max: 999, points: 100 }] }] } as ApprovedModel;
    const r = score({ yearsInHome: 3, statedTimelineDays: 10 }, forged);
    expect(r.reasons.map((x) => x.feature)).not.toContain('stated_timeline_days');
    expect(r.band).toBe('none');
    expect(validateModel(forged).ok).toBe(false);
  });

  it('R-PRED-1: a reason citing a feature outside its model is detected and never becomes a card', () => {
    const forgedReasons = [{ feature: 'stated_timeline_days' as const, points: 90, evidence: { sourceType: 'features_input' as const, field: 'statedTimelineDays' as const }, text: 'x' }];
    expect(reasonsCiteModel(forgedReasons, NARROW)).toBe(false);
    expect(predictionFeedCard({ contactId: cid(1), modelVersion: NARROW.version, band: 'likely_90d', reasons: forgedReasons }, NARROW)).toBeNull();
  });

  it('R-PRED-5 E144: a withdrawn or draft model is refused even if relabelled at the type level', () => {
    expect(scoreWithModel({ yearsInHome: 12 }, withStatus(APPROVED, 'withdrawn'))).toMatchObject({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED' });
    expect(scoreWithModel({ yearsInHome: 12 }, withStatus(APPROVED, 'draft'))).toMatchObject({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED' });
    expect(() => score({ yearsInHome: 12 }, withStatus(APPROVED, 'withdrawn') as ApprovedModel)).toThrow(TypeError);
    // an "approved" label without counsel review or back-test is invalid, not approved
    expect(scoreWithModel({ yearsInHome: 12 }, { ...APPROVED, counselReviewedAt: null })).toMatchObject({ ok: false, code: 'PREDICTION_MODEL_INVALID' });
    expect(scoreWithModel({ yearsInHome: 12 }, { ...APPROVED, status: 'APPROVED' })).toMatchObject({ ok: false, code: 'PREDICTION_MODEL_INVALID' });
  });
});
