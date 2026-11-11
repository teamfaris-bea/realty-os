// 90-day forecast by stage share (R-OWNER-3, R-OWNER-4; E109).
//
// For each open stage S:
//   n = deals that entered S in the trailing 365 days AND whose 90-day outcome window has fully
//       passed (entry + 90 d <= now). So the counted entries lie in [now − 365 d, now − 90 d].
//   k = those of the n that reached `closed` within 90 days of entering S (entry <= closed <= entry + 90 d).
// Window choice: an entry younger than 90 days is never counted, even if its deal already closed.
// Counting "closed early" entries while leaving out the still-open ones of the same age would only
// ever add successes and bias the share upward; requiring the whole window keeps n and k honest.
// A deal counts at most once per stage: its earliest qualifying entry (re-entering a stage after a
// bounce does not add a second sample).
//
// Expected = Σ over open deals of their stage's k/n (× the deal's expected commission for the
// commission unit). low / high = the same sum with the 80 % Wilson interval bounds of each share.
// Stages with n < minSample are left out (excluded.thinStages, E109) and their open deals are not
// counted (excluded.thinStageDeals). No per-deal number is ever returned (R-OWNER-4).
//
// Not enough history: when no open stage reaches minSample, the result has notEnoughHistory = true,
// low = expected = high = 0, and a method sentence that says there is no forecast.
// Rounding: the commission unit rounds each total half-up to whole cents (Math.round, applied to
// non-negative sums; monotone, so low <= expected <= high survives); closings are left unrounded.
import { DAY_MS, type DealId, type Instant } from '../foundation/index.js';
import { formatCents, plural } from './money.js';
import { OPEN_STAGES, type Forecast, type ForecastOpenDeal, type ForecastUnit, type OpenStage, type StageEntry, type StageSample } from './types.js';

/** z for a two-sided 80 % interval: the 0.9 quantile of the standard normal. */
export const WILSON_Z_80 = 1.2815515655446004;
export const FORECAST_HORIZON_DAYS = 90;
export const FORECAST_LOOKBACK_DAYS = 365;
export const FORECAST_MIN_SAMPLE = 10;

/**
 * Wilson score interval for k successes of n, clamped to [0, 1] and always containing k/n.
 * With n = 0 there is no information and the interval is [0, 1].
 */
export function wilsonInterval(k: number, n: number, z: number = WILSON_Z_80): { low: number; high: number } {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilsonInterval: expected integers 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = Math.min(p, Math.max(0, (center - margin) / denom));
  const high = Math.max(p, Math.min(1, (center + margin) / denom));
  return { low, high };
}

const isOpenStage = (s: string): s is OpenStage => (OPEN_STAGES as readonly string[]).includes(s);

/** n and k per open stage, under the window rule in the file header. */
export function stageSamples(stageEntries: readonly StageEntry[], now: Instant): StageSample[] {
  const horizon = FORECAST_HORIZON_DAYS * DAY_MS;
  const from = now - FORECAST_LOOKBACK_DAYS * DAY_MS;
  const lastKnown = now - horizon;

  const closedAtByDeal = new Map<DealId, Instant[]>();
  for (const e of stageEntries) {
    if (e.toStage !== 'closed') continue;
    const list = closedAtByDeal.get(e.dealId) ?? [];
    list.push(e.changedAt);
    closedAtByDeal.set(e.dealId, list);
  }

  // earliest qualifying entry per (stage, deal)
  const firstEntry = new Map<OpenStage, Map<DealId, Instant>>();
  for (const e of stageEntries) {
    if (!isOpenStage(e.toStage)) continue;
    if (e.changedAt < from || e.changedAt > lastKnown) continue;
    let m = firstEntry.get(e.toStage);
    if (!m) {
      m = new Map();
      firstEntry.set(e.toStage, m);
    }
    const prev = m.get(e.dealId);
    if (prev === undefined || e.changedAt < prev) m.set(e.dealId, e.changedAt);
  }

  return OPEN_STAGES.map((stage) => {
    const m = firstEntry.get(stage);
    let n = 0;
    let k = 0;
    for (const [dealId, entered] of m ?? []) {
      n += 1;
      const closes = closedAtByDeal.get(dealId) ?? [];
      if (closes.some((c) => c >= entered && c <= entered + horizon)) k += 1;
    }
    return { stage, n, k };
  });
}

function methodSentence(f: {
  unit: ForecastUnit;
  minSample: number;
  counted: number;
  thinStageDeals: number;
  thinStages: readonly OpenStage[];
  noCommission: number;
  notEnoughHistory: boolean;
}): string {
  const window = `deals that entered it 90 to 365 days ago`;
  if (f.notEnoughHistory) {
    return (
      `Not enough history: no stage had at least ${f.minSample} ${window} (with a known 90-day outcome), ` +
      `so there is no forecast and ${plural(f.thinStageDeals, 'open deal is', 'open deals are')} not counted.`
    );
  }
  const weight = f.unit === 'commission_cents' ? ', each weighted by its expected commission,' : '';
  const left: string[] = [];
  if (f.thinStageDeals > 0 || f.thinStages.length > 0) {
    left.push(
      `${plural(f.thinStageDeals, 'open deal', 'open deals')} in stages with fewer than ${f.minSample} such entries (not enough history: ${f.thinStages.join(', ')})`,
    );
  }
  if (f.unit === 'commission_cents' && f.noCommission > 0) {
    left.push(`${plural(f.noCommission, 'open deal', 'open deals')} with no expected commission`);
  }
  const tail = left.length > 0 ? `; left out: ${left.join(' and ')}` : '';
  return (
    `For each stage we took the share of ${window} that closed within 90 days (k of n) and added it up over ` +
    `${plural(f.counted, 'open deal', 'open deals')}${weight} with an 80% Wilson range for low and high${tail}.`
  );
}

/**
 * The 90-day forecast in one unit. `stageEntries` are deal_stage_history rows (all stages,
 * including `closed`) from at least now − 365 d up to now. Use `forecastBoth` for both units.
 */
export function forecast(
  openDeals: readonly ForecastOpenDeal[],
  stageEntries: readonly StageEntry[],
  now: Instant,
  minSample: number = FORECAST_MIN_SAMPLE,
  unit: ForecastUnit = 'closings',
): Forecast {
  const samples = stageSamples(stageEntries, now);
  const usable = new Map<OpenStage, { share: number; low: number; high: number }>();
  const thinStages: OpenStage[] = [];
  for (const s of samples) {
    if (s.n < minSample) {
      thinStages.push(s.stage);
      continue;
    }
    const w = wilsonInterval(s.k, s.n, WILSON_Z_80);
    usable.set(s.stage, { share: s.k / s.n, low: w.low, high: w.high });
  }

  let low = 0;
  let expected = 0;
  let high = 0;
  let counted = 0;
  let thinStageDeals = 0;
  let noCommission = 0;
  let noSource = 0;
  const seen = new Set<DealId>();
  for (const d of openDeals) {
    if (seen.has(d.id) || !isOpenStage(d.stage)) continue;
    seen.add(d.id);
    if (d.leadSourceId === null) noSource += 1;
    const u = usable.get(d.stage);
    if (!u) {
      thinStageDeals += 1;
      continue;
    }
    let weight = 1;
    if (unit === 'commission_cents') {
      if (d.expectedCommissionCents === null) {
        noCommission += 1;
        continue;
      }
      weight = d.expectedCommissionCents;
    }
    counted += 1;
    low += u.low * weight;
    expected += u.share * weight;
    high += u.high * weight;
  }

  const notEnoughHistory = usable.size === 0;
  if (unit === 'commission_cents') {
    low = Math.round(low);
    expected = Math.round(expected);
    high = Math.round(high);
  }
  const method = methodSentence({ unit, minSample, counted, thinStageDeals, thinStages, noCommission, notEnoughHistory });
  return {
    low: notEnoughHistory ? 0 : low,
    expected: notEnoughHistory ? 0 : expected,
    high: notEnoughHistory ? 0 : high,
    horizonDays: 90,
    unit,
    method,
    samples,
    countedDeals: counted,
    notEnoughHistory,
    excluded: { thinStages, thinStageDeals, noCommission: unit === 'commission_cents' ? noCommission : 0, noSource },
  };
}

/** Both units of R-OWNER-3 from one set of inputs. */
export function forecastBoth(
  openDeals: readonly ForecastOpenDeal[],
  stageEntries: readonly StageEntry[],
  now: Instant,
  minSample: number = FORECAST_MIN_SAMPLE,
): { closings: Forecast; commission: Forecast } {
  return {
    closings: forecast(openDeals, stageEntries, now, minSample, 'closings'),
    commission: forecast(openDeals, stageEntries, now, minSample, 'commission_cents'),
  };
}

/** "3.1–5.4 closings" / "$12,000.00–$20,500.00" for a header line (no per-deal figures). */
export function forecastRangeWords(f: Forecast): string {
  if (f.notEnoughHistory) return 'Not enough history';
  if (f.unit === 'commission_cents') return `${formatCents(f.low)}–${formatCents(f.high)}`;
  return `${f.low.toFixed(1)}–${f.high.toFixed(1)} closings`;
}
