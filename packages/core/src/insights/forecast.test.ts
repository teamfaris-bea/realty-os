import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DAY_MS, instant, type DealId } from '../foundation/index.js';
import { NOW, allKeys, daysAgo, deal, src } from './testing/fixtures.js';
import {
  WILSON_Z_80,
  forecast,
  forecastBoth,
  forecastRangeWords,
  stageSamples,
  wilsonInterval,
  OPEN_STAGES,
  type ForecastOpenDeal,
  type OpenStage,
  type StageEntry,
} from './index.js';

let seq = 1000;
/** `n` deals entering `stage` `ageDays` ago, the first `k` of them closing `closeAfterDays` later. */
function history(stage: OpenStage, n: number, k: number, ageDays = 200, closeAfterDays = 30): StageEntry[] {
  const out: StageEntry[] = [];
  for (let i = 0; i < n; i++) {
    const id = deal(seq++);
    const entered = daysAgo(ageDays);
    out.push({ dealId: id, toStage: stage, changedAt: entered });
    if (i < k) out.push({ dealId: id, toStage: 'closed', changedAt: instant(entered + closeAfterDays * DAY_MS) });
  }
  return out;
}
const open = (n: number, stage: OpenStage, commission: number | null = 1_000_000, source: number | null = 1): ForecastOpenDeal => ({
  id: deal(n),
  stage,
  leadSourceId: source === null ? null : src(source),
  expectedCommissionCents: commission,
});

describe('R-OWNER-3 Wilson interval', () => {
  it('R-OWNER-3: the 80% Wilson interval of 6 of 10 matches the closed form', () => {
    const w = wilsonInterval(6, 10, WILSON_Z_80);
    expect(w.low).toBeCloseTo(0.4014, 3);
    expect(w.high).toBeCloseTo(0.7704, 3);
    expect(WILSON_Z_80).toBe(1.2815515655446004);
  });

  it('R-OWNER-3: the edge shares 0/n and n/n stay inside [0, 1] and contain the share; n = 0 is [0, 1]', () => {
    expect(wilsonInterval(0, 20).low).toBe(0);
    expect(wilsonInterval(20, 20).high).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
  });

  it('R-OWNER-3 property: Wilson bounds lie within [0, 1] and contain k/n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))),
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        ([k, n], z) => {
          const w = wilsonInterval(k, n, z);
          return w.low >= 0 && w.high <= 1 && w.low <= k / n && k / n <= w.high;
        },
      ),
    );
  });
});

describe('R-OWNER-3 stage samples (k of n)', () => {
  it('R-OWNER-3: n counts entries whose whole 90-day window has passed within the trailing 365 days; recent entries never count, closed or not', () => {
    const entries: StageEntry[] = [
      { dealId: deal(1), toStage: 'under_contract', changedAt: daysAgo(100) }, // counted, closed in window
      { dealId: deal(1), toStage: 'closed', changedAt: daysAgo(70) },
      { dealId: deal(2), toStage: 'under_contract', changedAt: daysAgo(30) }, // window still open: not counted even though it closed
      { dealId: deal(2), toStage: 'closed', changedAt: daysAgo(10) },
      { dealId: deal(3), toStage: 'under_contract', changedAt: daysAgo(400) }, // older than 365 d
      { dealId: deal(4), toStage: 'under_contract', changedAt: daysAgo(90) }, // exactly 90 d: window known
      { dealId: deal(5), toStage: 'under_contract', changedAt: daysAgo(365) }, // exactly 365 d: inside
      { dealId: deal(5), toStage: 'closed', changedAt: daysAgo(270) }, // 95 d later: not within 90
    ];
    const uc = stageSamples(entries, NOW).find((s) => s.stage === 'under_contract');
    expect(uc).toEqual({ stage: 'under_contract', n: 3, k: 1 });
  });

  it('R-OWNER-3: a deal counts once per stage (earliest entry) even after re-entering it; closing exactly on day 90 counts', () => {
    const entries: StageEntry[] = [
      { dealId: deal(1), toStage: 'active', changedAt: daysAgo(300) },
      { dealId: deal(1), toStage: 'active', changedAt: daysAgo(200) },
      { dealId: deal(1), toStage: 'closed', changedAt: daysAgo(210) }, // 90 d after the earliest entry
    ];
    expect(stageSamples(entries, NOW).find((s) => s.stage === 'active')).toEqual({ stage: 'active', n: 1, k: 1 });
  });

  it('R-OWNER-3: samples list every open stage in pipeline order', () => {
    expect(stageSamples([], NOW).map((s) => s.stage)).toEqual([...OPEN_STAGES]);
  });
});

describe('R-OWNER-3 forecast', () => {
  it('R-OWNER-3: expected = Σ stage share over open deals; low/high use the 80% Wilson bounds of each share', () => {
    const entries = [...history('under_contract', 20, 16), ...history('active', 10, 3)];
    const deals = [open(1, 'under_contract'), open(2, 'under_contract'), open(3, 'active')];
    const f = forecast(deals, entries, NOW);
    const uc = wilsonInterval(16, 20);
    const ac = wilsonInterval(3, 10);
    expect(f.unit).toBe('closings');
    expect(f.horizonDays).toBe(90);
    expect(f.expected).toBeCloseTo(0.8 * 2 + 0.3, 10);
    expect(f.low).toBeCloseTo(uc.low * 2 + ac.low, 10);
    expect(f.high).toBeCloseTo(uc.high * 2 + ac.high, 10);
    expect(f.countedDeals).toBe(3);
    expect(f.notEnoughHistory).toBe(false);
    expect(f.samples).toEqual([
      { stage: 'prospect', n: 0, k: 0 },
      { stage: 'agreement_signed', n: 0, k: 0 },
      { stage: 'active', n: 10, k: 3 },
      { stage: 'under_contract', n: 20, k: 16 },
    ]);
    expect(f.method.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 0)).toHaveLength(1);
  });

  it('R-OWNER-3: the commission unit weights each share by the deal expected commission, in whole cents, and counts deals with none', () => {
    const entries = history('under_contract', 10, 5);
    const deals = [open(1, 'under_contract', 1_000_000), open(2, 'under_contract', 333_333), open(3, 'under_contract', null)];
    const f = forecast(deals, entries, NOW, 10, 'commission_cents');
    expect(f.unit).toBe('commission_cents');
    expect(f.expected).toBe(Math.round(0.5 * 1_333_333));
    expect(Number.isInteger(f.low) && Number.isInteger(f.high)).toBe(true);
    expect(f.excluded.noCommission).toBe(1);
    expect(f.countedDeals).toBe(2);
    expect(f.method).toContain('1 open deal with no expected commission');
    expect(forecast(deals, entries, NOW, 10, 'closings').excluded.noCommission).toBe(0);
  });

  it('R-OWNER-3: forecastBoth returns the two units from the same inputs', () => {
    const b = forecastBoth([open(1, 'under_contract', 200)], history('under_contract', 10, 10), NOW);
    expect(b.closings.unit).toBe('closings');
    expect(b.commission.unit).toBe('commission_cents');
    expect(b.closings.expected).toBe(1);
    expect(b.commission.expected).toBe(200);
  });

  it('R-OWNER-3 E109: a stage with fewer than 10 entries in the last year is left out, counted, and its open deals not counted', () => {
    const entries = [...history('under_contract', 12, 6), ...history('prospect', 9, 1)];
    const f = forecast([open(1, 'under_contract'), open(2, 'prospect'), open(3, 'prospect')], entries, NOW);
    expect(f.excluded.thinStages).toEqual(['prospect', 'agreement_signed', 'active']);
    expect(f.excluded.thinStageDeals).toBe(2);
    expect(f.countedDeals).toBe(1);
    expect(f.expected).toBeCloseTo(0.5, 10);
    expect(f.samples.find((s) => s.stage === 'prospect')).toEqual({ stage: 'prospect', n: 9, k: 1 });
    expect(f.method).toContain('not enough history');
    expect(f.method).toContain('2 open deals');
  });

  it('R-OWNER-3 E109: with no stage having enough history the result says "not enough history" with zeros, not a made-up range', () => {
    const f = forecast([open(1, 'active'), open(2, 'under_contract')], history('active', 3, 1), NOW);
    expect(f.notEnoughHistory).toBe(true);
    expect([f.low, f.expected, f.high]).toEqual([0, 0, 0]);
    expect(f.excluded.thinStages).toEqual([...OPEN_STAGES]);
    expect(f.excluded.thinStageDeals).toBe(2);
    expect(f.method).toMatch(/^Not enough history/);
    expect(forecastRangeWords(f)).toBe('Not enough history');
  });

  it('R-OWNER-3: minSample is a parameter (default 10)', () => {
    const entries = history('active', 5, 5);
    expect(forecast([open(1, 'active')], entries, NOW).notEnoughHistory).toBe(true);
    expect(forecast([open(1, 'active')], entries, NOW, 5).expected).toBe(1);
  });

  it('R-OWNER-3: open deals with no lead source are still forecast and counted as noSource (informational)', () => {
    const f = forecast([open(1, 'active', 1, null), open(2, 'active', 1, 3)], history('active', 10, 5), NOW);
    expect(f.excluded.noSource).toBe(1);
    expect(f.countedDeals).toBe(2);
  });

  it('R-OWNER-3: a duplicated open deal counts once', () => {
    const f = forecast([open(1, 'active'), open(1, 'active')], history('active', 10, 5), NOW);
    expect(f.countedDeals).toBe(1);
  });

  it('R-OWNER-4: no key anywhere in the forecast output matches confidence, probability or score (no per-deal figures)', () => {
    const entries = [...history('under_contract', 12, 6), ...history('prospect', 2, 1)];
    for (const unit of ['closings', 'commission_cents'] as const) {
      const f = forecast([open(1, 'under_contract'), open(2, 'prospect', null, null)], entries, NOW, 10, unit);
      expect(allKeys(f).filter((k) => /confiden|probab|score/i.test(k))).toEqual([]);
      expect(JSON.stringify(f)).not.toContain(deal(1)); // no per-deal output
      expect(Object.keys(f).sort()).toEqual(
        ['countedDeals', 'excluded', 'expected', 'high', 'horizonDays', 'low', 'method', 'notEnoughHistory', 'samples', 'unit'].sort(),
      );
    }
  });
});

describe('R-OWNER-3 forecast properties', () => {
  const stageArb = fc.constantFrom<OpenStage>(...OPEN_STAGES);
  const entriesArb = fc.array(
    fc.record({
      deal: fc.integer({ min: 1, max: 60 }),
      stage: fc.constantFrom<OpenStage | 'closed' | 'lost'>(...OPEN_STAGES, 'closed', 'closed', 'lost'),
      age: fc.integer({ min: 0, max: 500 }),
    }),
    { maxLength: 300 },
  );
  const dealsArb = fc.array(
    fc.record({ n: fc.integer({ min: 1, max: 80 }), stage: stageArb, commission: fc.option(fc.integer({ min: 0, max: 5_000_000 })), src: fc.option(fc.integer({ min: 1, max: 3 })) }),
    { maxLength: 40 },
  );
  const build = (es: { deal: number; stage: OpenStage | 'closed' | 'lost'; age: number }[]): StageEntry[] =>
    es.map((e) => ({ dealId: deal(e.deal) as DealId, toStage: e.stage, changedAt: daysAgo(e.age) }));

  it('R-OWNER-3 property: 0 <= low <= expected <= high, and for closings high <= counted open deals', () => {
    fc.assert(
      fc.property(entriesArb, dealsArb, fc.integer({ min: 1, max: 12 }), fc.constantFrom('closings' as const, 'commission_cents' as const), (es, ds, minSample, unit) => {
        const deals = ds.map((d) => open(d.n, d.stage, d.commission, d.src));
        const f = forecast(deals, build(es), NOW, minSample, unit);
        expect(f.low).toBeGreaterThanOrEqual(0);
        expect(f.low).toBeLessThanOrEqual(f.expected);
        expect(f.expected).toBeLessThanOrEqual(f.high);
        if (unit === 'closings') expect(f.high).toBeLessThanOrEqual(f.countedDeals + 1e-9);
        for (const s of f.samples) expect(s.k).toBeLessThanOrEqual(s.n);
        const distinct = new Set(deals.map((d) => d.id)).size;
        expect(f.countedDeals + f.excluded.thinStageDeals + f.excluded.noCommission).toBe(distinct);
        if (f.notEnoughHistory) expect([f.low, f.expected, f.high]).toEqual([0, 0, 0]);
      }),
    );
  });
});
