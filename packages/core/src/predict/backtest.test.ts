import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, instant } from '../foundation/index.js';
import { backtest, backtestSummary, validateModel, type BacktestDeal, type BacktestPrediction, type Band } from './index.js';
import { APPROVED, cid } from './testing/fixtures.js';

const T0 = Date.UTC(2025, 0, 1);
const predArb = fc.record({
  contactId: fc.integer({ min: 1, max: 15 }).map(cid),
  band: fc.constantFrom<Band>('likely_90d', 'watch', 'none', 'not_enough_data'),
  predictedAt: fc.integer({ min: 0, max: 400 }).map((d) => instant(T0 + d * DAY_MS)),
});
const dealArb = fc.record({
  contactId: fc.integer({ min: 1, max: 15 }).map(cid),
  closedAt: fc.integer({ min: 0, max: 800 * 24 }).map((h) => instant(T0 + h * 3_600_000)),
});

describe('platform back-test (R-PRED-3)', () => {
  it('R-PRED-3: counts flagged people and those who transacted within the window after the prediction', () => {
    const p: BacktestPrediction[] = [
      { contactId: cid(1), band: 'likely_90d', predictedAt: instant(T0) },
      { contactId: cid(2), band: 'likely_90d', predictedAt: instant(T0) },
      { contactId: cid(3), band: 'likely_90d', predictedAt: instant(T0) },
      { contactId: cid(4), band: 'watch', predictedAt: instant(T0) },
    ];
    const d: BacktestDeal[] = [
      { contactId: cid(1), closedAt: instant(T0 + 30 * DAY_MS) }, // inside
      { contactId: cid(2), closedAt: instant(T0 + 91 * DAY_MS) }, // after the window
      { contactId: cid(3), closedAt: instant(T0 - DAY_MS) }, // before the prediction
      { contactId: cid(4), closedAt: instant(T0 + DAY_MS) }, // not flagged
    ];
    expect(backtest(p, d, { windowDays: 90 })).toEqual({ flagged: 3, transacted: 1 });
    expect(backtest(p, d, { windowDays: 91 })).toEqual({ flagged: 3, transacted: 2 });
    const s = backtestSummary(backtest(p, d, { windowDays: 90 }), 90, ' 2025 synthetic ');
    expect(validateModel({ ...APPROVED, backtest: s }).ok).toBe(true);
    expect(() => backtest(p, d, { windowDays: -1 })).toThrow(RangeError);
  });

  it('R-PRED-3: property: transacted ≤ flagged; monotone in the window; independent of input order', () => {
    fc.assert(
      fc.property(fc.array(predArb, { maxLength: 30 }), fc.array(dealArb, { maxLength: 30 }), fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (p, d, w1, w2) => {
        const [lo, hi] = w1 <= w2 ? [w1, w2] : [w2, w1];
        const a = backtest(p, d, { windowDays: lo });
        const b = backtest(p, d, { windowDays: hi });
        expect(a.transacted).toBeLessThanOrEqual(a.flagged);
        expect(b.flagged).toBe(a.flagged);
        expect(b.transacted).toBeGreaterThanOrEqual(a.transacted);
        expect(backtest([...p].reverse(), [...d].reverse(), { windowDays: lo })).toEqual(a);
      }),
    );
  });
});
