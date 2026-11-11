import { describe, expect, it } from 'vitest';
import { velocityRows } from './index.js';

describe('R-OWNER-3 velocity (app.stage_dwell_norms rows, not recomputed)', () => {
  it('R-OWNER-3: keeps the DB medians and sample sizes, orders by pipeline stage, and words carry n', () => {
    const rows = velocityRows([
      { stage: 'under_contract', medianDays: 12, sampleSize: 34 },
      { stage: 'zz_unknown', medianDays: 1, sampleSize: 1 },
      { stage: 'prospect', medianDays: 20.5, sampleSize: 8 },
    ]);
    expect(rows).toEqual([
      { stage: 'prospect', medianDays: 20.5, sampleSize: 8, words: 'median 20.5 days (n=8)' },
      { stage: 'under_contract', medianDays: 12, sampleSize: 34, words: 'median 12 days (n=34)' },
      { stage: 'zz_unknown', medianDays: 1, sampleSize: 1, words: 'median 1 day (n=1)' },
    ]);
  });
});
