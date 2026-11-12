// Model definitions (R-PRED-1, R-PRED-5): the shipped registry is empty, every definition's hash is pinned, and a
// version scores only with an approved row, a definition and equal features. E120: the assembler's output type takes
// no seventh key (compile-time; `pnpm -r typecheck` fails if an @ts-expect-error below stops erroring).
import type { ExactFeatures, PredictionFeatures } from '@realty/core/predict';
import { describe, expect, it } from 'vitest';
import type { AssembledFeatures } from './decide.js';
import { MODEL_DEFINITIONS, type ModelRow, definitionSha256, needsPropertyRecords, resolveModels } from './models.js';
import { FIRST_PARTY_MODEL, PROPERTY_MODEL, TEST_BACKTEST, definitionOf } from './testing.js';

const row = (version: string, features: string[], status = 'approved'): ModelRow => ({
  version,
  status,
  features,
  counsel_reviewed_at: new Date('2026-10-01T00:00:00Z'),
  backtest_flagged: TEST_BACKTEST.flagged,
  backtest_transacted: TEST_BACKTEST.transacted,
  backtest_window_days: TEST_BACKTEST.windowDays,
  backtest_dataset: TEST_BACKTEST.dataset,
});

describe('the model registry (R-PRED-1)', () => {
  it('R-PRED-1: the shipped registry is empty, and each definition\'s hash is pinned (snapshot): a changed point value is a new version', () => {
    expect(MODEL_DEFINITIONS.size).toBe(0);
    const pinned = Object.fromEntries(
      [...MODEL_DEFINITIONS.values(), definitionOf(PROPERTY_MODEL, 'predict/0.1'), definitionOf(FIRST_PARTY_MODEL, 'predict/0.2')].map((d) => [d.version, definitionSha256(d)]),
    );
    expect(pinned).toMatchSnapshot();
    const changed = definitionOf({ ...PROPERTY_MODEL, bandThresholds: { likely: 61, watch: 30 } }, 'predict/0.1');
    expect(definitionSha256(changed)).not.toBe(pinned['predict/0.1']);
  });

  it('definitions are frozen', () => {
    const d = definitionOf(PROPERTY_MODEL);
    expect(Object.isFrozen(d) && Object.isFrozen(d.rules) && Object.isFrozen(d.rules[0])).toBe(true);
    expect(() => (d.rules as unknown as unknown[]).push({})).toThrow();
  });

  it('resolveModels: approved + definition + equal features scores; a draft or withdrawn row is ignored without an alert; the rest are invalid with a reason', () => {
    const d = definitionOf(FIRST_PARTY_MODEL);
    const reg = new Map([[d.version, d]]);
    expect(resolveModels([row(d.version, ['past_client_years', 'recent_saves'])], reg).scoring.map((m) => m.version)).toEqual([d.version]);
    expect(resolveModels([row(d.version, [...d.features], 'withdrawn'), row('predict/0.9', ['recent_saves'], 'draft')], reg)).toEqual({ scoring: [], invalid: [] });
    expect(resolveModels([row('predict/0.9', ['recent_saves'])], reg).invalid).toEqual([{ version: 'predict/0.9', reason: 'no_definition' }]);
    expect(resolveModels([row(d.version, ['recent_saves', 'past_client_years', 'recent_permit'])], reg).invalid).toEqual([{ version: d.version, reason: 'features_differ' }]);
    // an approved row without its back-test cannot exist (0018 CHECK) and would not score here either
    expect(resolveModels([{ ...row(d.version, [...d.features]), backtest_flagged: null }], reg).invalid).toEqual([{ version: d.version, reason: 'definition_invalid' }]);
  });

  it('a lookup has a purpose only when a scoring model names a property feature', () => {
    expect(needsPropertyRecords([{ features: ['recent_saves', 'past_client_years'] }])).toBe(false);
    expect(needsPropertyRecords([{ features: ['recent_saves'] }, { features: ['equity_band'] }])).toBe(true);
  });
});

describe('E120: the assembler\'s output type takes no seventh key', () => {
  it('E120 R-PRED-1: pcs_timeline, age, zip, household and a name are not expressible as assembled features', () => {
    type F = AssembledFeatures['features'];
    const ok: F = { yearsInHome: 3, equityBand: 'mid', recentSaves: 1, pastClientYears: 2, recentPermit: false };
    // @ts-expect-error a self-reported PCS timeline is a protected proxy
    const pcs: F = { pcsTimeline: 60 };
    // @ts-expect-error snake case is not a key either
    const pcs2: F = { pcs_timeline: 60 };
    // @ts-expect-error age
    const age: F = { age: 47 };
    // @ts-expect-error geography
    const zip: F = { zip: '90001' };
    // @ts-expect-error household composition
    const household: F = { householdSize: 4 };
    // @ts-expect-error a name
    const name: F = { name: 'Pat Doe' };
    const widened = { recentSaves: 1, zip: '90001' };
    // @ts-expect-error a widened object carrying an extra key does not pass ExactFeatures either
    const exact: ExactFeatures<typeof widened> = widened;
    const keys: (keyof PredictionFeatures)[] = ['yearsInHome', 'equityBand', 'recentSaves', 'statedTimelineDays', 'pastClientYears', 'recentPermit'];
    expect(Object.keys(ok).every((k) => keys.includes(k as keyof PredictionFeatures))).toBe(true);
    void [pcs, pcs2, age, zip, household, name, exact];
  });
});
