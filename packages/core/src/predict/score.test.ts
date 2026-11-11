import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inputsSha256, parseFeatures, reasonsCiteModel, score, scoreWithModel, storedReasons, type PredictionFeatures } from './index.js';
import { APPROVED, NARROW, withStatus } from './testing/fixtures.js';

const FORBIDDEN_KEY = /prob|confidence|likelihood|percent|score$/i;

function walkKeys(v: unknown, path: string, out: string[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => walkKeys(x, `${path}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(`${path}.${k}`);
      walkKeys(x, `${path}.${k}`, out);
    }
  }
}
const forbiddenKeys = (v: unknown): string[] => {
  const keys: string[] = [];
  walkKeys(v, '$', keys);
  return keys.filter((k) => FORBIDDEN_KEY.test(k.split('.').pop() ?? ''));
};

const featuresArb: fc.Arbitrary<PredictionFeatures> = fc.record(
  {
    yearsInHome: fc.integer({ min: 0, max: 150 }),
    equityBand: fc.constantFrom('low' as const, 'mid' as const, 'high' as const),
    recentSaves: fc.integer({ min: 0, max: 10_000 }),
    statedTimelineDays: fc.integer({ min: 0, max: 3_650 }),
    pastClientYears: fc.integer({ min: 0, max: 150 }),
    recentPermit: fc.boolean(),
  },
  { requiredKeys: [] },
);

describe('score (R-PRED-1, R-PRED-3)', () => {
  it('R-PRED-3: band with reasons and evidence, no probability (snapshot)', () => {
    const out = score({ yearsInHome: 14, equityBand: 'high', statedTimelineDays: 60, recentSaves: 2 }, APPROVED, {
      years_in_home: { sourceType: 'property_record', sourceId: 'pr-1', field: 'last_sale_date' },
    });
    expect(out).toMatchSnapshot();
    expect(out.band).toBe('likely_90d');
  });

  it('R-PRED-3: no output key anywhere names a probability, confidence, likelihood, percent or score', () => {
    fc.assert(
      fc.property(featuresArb, (f) => {
        const r = scoreWithModel(f, APPROVED);
        expect(forbiddenKeys(r)).toEqual([]);
        expect(forbiddenKeys(score(f, APPROVED))).toEqual([]);
      }),
    );
    // the walker itself catches such a key
    expect(forbiddenKeys({ reasons: [{ probability: 0.4 }], confidenceScore: 1 })).toEqual(['$.reasons[0].probability', '$.confidenceScore']);
  });

  it('R-PRED-1: only features of the model count; a present feature outside the model is never a reason', () => {
    const f = { yearsInHome: 12, recentSaves: 50, statedTimelineDays: 10, equityBand: 'high' as const };
    const r = score(f, NARROW);
    expect(r.reasons.map((x) => x.feature)).toEqual(['years_in_home']);
    expect(r.band).toBe('watch');
    expect(reasonsCiteModel(r.reasons, NARROW)).toBe(true);
    // a model naming none of the present features: not enough data
    expect(score({ recentSaves: 50, statedTimelineDays: 10 }, NARROW)).toEqual({ band: 'not_enough_data', reasons: [] });
  });

  it('R-PRED-1: fewer than minFeaturesPresent ⇒ not_enough_data with no reasons', () => {
    expect(score({ statedTimelineDays: 10 }, APPROVED)).toEqual({ band: 'not_enough_data', reasons: [] });
    expect(score({}, APPROVED)).toEqual({ band: 'not_enough_data', reasons: [] });
  });

  it('R-PRED-3: likely and watch always carry ≥1 reason, each citing a feature of its own model; integer points', () => {
    fc.assert(
      fc.property(featuresArb, fc.constantFrom(APPROVED, NARROW), (f, m) => {
        const r = score(f, m);
        if (r.band === 'likely_90d' || r.band === 'watch') expect(r.reasons.length).toBeGreaterThanOrEqual(1);
        if (r.band === 'not_enough_data') expect(r.reasons).toEqual([]);
        for (const x of r.reasons) {
          expect(m.features).toContain(x.feature);
          expect(Number.isSafeInteger(x.points) && x.points > 0).toBe(true);
        }
        const total = r.reasons.reduce((s, x) => s + x.points, 0);
        if (r.band === 'likely_90d') expect(total).toBeGreaterThanOrEqual(m.bandThresholds.likely);
        if (r.band === 'none') expect(total).toBeLessThan(m.bandThresholds.watch);
      }),
    );
  });

  it('R-PRED-1: deterministic, and reasons are ordered by points then the allowlist order, whatever the key order', () => {
    fc.assert(
      fc.property(featuresArb, (f) => {
        const reversed = Object.fromEntries(Object.entries(f).reverse()) as PredictionFeatures;
        expect(score(reversed, APPROVED)).toEqual(score(f, APPROVED));
        expect(inputsSha256(reversed, APPROVED.version)).toBe(inputsSha256(f, APPROVED.version));
        const pts = score(f, APPROVED).reasons.map((r) => r.points);
        expect(pts).toEqual([...pts].sort((a, b) => b - a));
      }),
    );
    const tie = score({ yearsInHome: 12, equityBand: 'high' }, APPROVED);
    expect(tie.reasons.map((r) => r.feature)).toEqual(['years_in_home', 'equity_band']);
  });

  it('R-PRED-1: inputsSha256 is 64 hex chars and changes with the model version or an input', () => {
    const h = inputsSha256({ yearsInHome: 3 }, 'predict/1.0');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsSha256({ yearsInHome: 3 }, 'predict/1.1')).not.toBe(h);
    expect(inputsSha256({ yearsInHome: 4 }, 'predict/1.0')).not.toBe(h);
  });

  it('R-PRED-1: scoreWithModel parses features, refuses forbidden keys, and returns inputs_sha256', () => {
    const r = scoreWithModel({ yearsInHome: 12, recentPermit: true }, APPROVED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inputsSha256).toBe(inputsSha256({ yearsInHome: 12, recentPermit: true }, 'predict/1.0'));
    expect(scoreWithModel({ yearsInHome: 12, age: 70 }, APPROVED)).toMatchObject({ ok: false, code: 'PREDICTION_FEATURES_INVALID' });
    expect(scoreWithModel({ yearsInHome: 12 }, { ...APPROVED, features: ['zip'] })).toMatchObject({ ok: false, code: 'PREDICTION_MODEL_INVALID' });
  });

  it('R-PRED-5 E144: a withdrawn or draft model produces nothing', () => {
    expect(scoreWithModel({ yearsInHome: 12, recentPermit: true }, withStatus(APPROVED, 'withdrawn'))).toEqual({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED', status: 'withdrawn' });
    expect(scoreWithModel({ yearsInHome: 12, recentPermit: true }, withStatus(APPROVED, 'draft'))).toEqual({ ok: false, code: 'PREDICTION_MODEL_NOT_APPROVED', status: 'draft' });
  });

  it('R-PRED-1: storedReasons has the contact_predictions.reasons shape [{feature, points, evidence_ref}]', () => {
    const r = score({ yearsInHome: 12, recentPermit: true }, NARROW, { recent_permit: { sourceType: 'property_record', sourceId: 'pr-9', field: 'recent_permit' } });
    expect(storedReasons(r.reasons)).toEqual([
      { feature: 'years_in_home', points: 40, evidence_ref: 'features_input#yearsInHome' },
      { feature: 'recent_permit', points: 30, evidence_ref: 'property_record:pr-9#recent_permit' },
    ]);
    expect(parseFeatures({ yearsInHome: 12 }).ok).toBe(true);
  });
});
