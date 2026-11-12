// Performance budget of prepareCma (PHASE2_3_PLAN §6, module 70): 2,000 candidates, including the
// back-test, in under 300 ms on CI. The budget is VERIFY. The first (cold, JIT) call is printed but not
// asserted; the asserted time is the median of three warm calls, which is what a running API sees.
import { describe, expect, it } from 'vitest';
import { prepareCma } from './index.js';
import { VALUATION_DATE, linearMarket, subject } from './testing/fixtures.js';

const BUDGET_MS = 300; // VERIFY
const COVERAGE = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__?.config?.coverage?.enabled === true;
const log = (globalThis as { console?: { log(...a: unknown[]): void } }).console?.log ?? (() => undefined);

describe('prepareCma performance', () => {
  it.skipIf(COVERAGE)('prepareCma with 2,000 candidates, back-test included, runs in under 300 ms (warm median)', () => {
    const candidates = linearMarket({ n: 2_000, seed: 1, trendCentsPerMonth: 60, poolCents: 2_500_000, poolShare: 0.3, bedCents: 1_000_000, noise: 0.03, radiusMiles: 3 });
    const input = { subject: subject(), candidates, tierReads: [], valuationDate: VALUATION_DATE };
    const t0 = Date.now();
    const first = prepareCma(input);
    const cold = Date.now() - t0;
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      prepareCma(input);
      warm.push(Date.now() - t);
    }
    warm.sort((a, b) => a - b);
    log(`prepareCma 2,000 candidates: cold ${cold} ms, warm ${warm.join('/')} ms (budget ${BUDGET_MS} ms, VERIFY)`);
    expect(first.available).toBe(true);
    expect(first.backtest.salesTested).toBeGreaterThan(0);
    expect(warm[1] as number).toBeLessThan(BUDGET_MS);
  }, 60_000);
});
