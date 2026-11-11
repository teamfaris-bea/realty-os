// The improving/slipping view (R-COACH-7).
//
//   - `before` is the earlier window, `after` the later one. Both must be scored with the SAME
//     rubric version as `opts.rubric` (default RUBRIC_V1); any other version throws a RangeError:
//     comparing across versions is a caller bug (the API/DB definer selects by rubric_version), and
//     silently dropping rows would make the n on each side lie.
//   - Per item and window: n = calls where the item was met or missed (needs_review and
//     not_applicable are not scored), met = calls where it was met.
//   - An item needs at least `minScored` (default 5) in EACH window, else not_enough_data.
//   - Direction: the change in the item's met rate, in percentage points; a change smaller than
//     `steadyBelowPoints` (default 10) is steady, else improving (up) or slipping (down). The
//     comparison is done in integers (no floating-point edge at exactly the threshold).
//   - Aggregates only: a TrendItem has no quotes, call ids or contact ids (a Team Lead may see it).
//     There is no overall score across items (R-COACH-6).
import { RUBRIC_V1, assertRubric } from './rubric.js';
import type { CallScore, TrendDirection, TrendItem, TrendOptions, TrendWindow } from './types.js';

export const TREND_MIN_SCORED = 5;
export const TREND_STEADY_BELOW_POINTS = 10;

function windowFor(key: string, scores: readonly CallScore[]): TrendWindow {
  let met = 0;
  let n = 0;
  for (const s of scores) {
    const it = s.items.find((i) => i.key === key);
    if (it === undefined) continue;
    if (it.status === 'met') {
      met += 1;
      n += 1;
    } else if (it.status === 'missed') n += 1;
  }
  return { met, n, metRate: n === 0 ? null : met / n };
}

function direction(a: TrendWindow, b: TrendWindow, minScored: number, steadyBelowPoints: number): TrendDirection {
  if (a.n < minScored || b.n < minScored) return 'not_enough_data';
  // (b.met/b.n - a.met/a.n) * 100 compared with the threshold, cross-multiplied
  const delta = (b.met * a.n - a.met * b.n) * 100;
  const bound = steadyBelowPoints * a.n * b.n;
  if (Math.abs(delta) < bound) return 'steady';
  return delta > 0 ? 'improving' : 'slipping';
}

export function trend(before: readonly CallScore[], after: readonly CallScore[], opts: TrendOptions = {}): TrendItem[] {
  const rubric = opts.rubric ?? RUBRIC_V1;
  assertRubric(rubric);
  const minScored = opts.minScored ?? TREND_MIN_SCORED;
  const steadyBelowPoints = opts.steadyBelowPoints ?? TREND_STEADY_BELOW_POINTS;
  if (!(Number.isInteger(minScored) && minScored >= 1)) throw new RangeError('trend: minScored must be a positive integer');
  if (!(Number.isFinite(steadyBelowPoints) && steadyBelowPoints >= 0)) throw new RangeError('trend: steadyBelowPoints must be >= 0');
  for (const s of [...before, ...after]) {
    if (s.rubricVersion !== rubric.version) {
      throw new RangeError(`trend: compares one rubric version only (${rubric.version}), got ${s.rubricVersion}`);
    }
  }
  const disabled = new Set(opts.disabledKeys ?? []);
  return rubric.items
    .filter((it) => !disabled.has(it.key))
    .map((it) => {
      const a = windowFor(it.key, before);
      const b = windowFor(it.key, after);
      return { key: it.key, label: it.label, before: a, after: b, direction: direction(a, b, minScored, steadyBelowPoints) };
    });
}
