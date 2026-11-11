// Goal pace (R-PLAN-2: the counts come from the scoreboard definers through the API; core only
// compares numbers with the calendar).
//
// The goal period starts at local midnight of `period_start` in the user's zone and lasts one
// week / month / quarter / year (calendar arithmetic on local dates; a month-end start clamps to
// the shorter month's last day). Linear pace: expected by now = target × elapsed fraction of the
// period, where the fraction is elapsed instant time over the period's instant length (DST-correct).
//
// Status (decision; the docs do not define the band): with E = target × fraction,
//   done      actual >= target
//   behind    actual <  floor(E)
//   ahead     actual >  ceil(E)
//   on_track  otherwise (one whole unit of slack either side of a fractional E)
import {
  DAY_MS,
  type IanaZone,
  type Instant,
  type LocalDate,
  localDate,
  localDateOf,
  localTimeFromSeconds,
  resolveLocal,
} from '../foundation/index.js';
import { plural } from './money.js';
import type { AgentGoal, GoalMetric, GoalPeriodKind, GoalScoreboard, Pace, PaceStatus } from './types.js';

function ymd(d: LocalDate): [number, number, number] {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return [y, m, dd];
}

function fmt(y: number, m: number, d: number): LocalDate {
  return localDate(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

/** Calendar days in month `m` (1–12) of year `y`. */
function monthLength(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `d` plus `months` calendar months, the day clamped to the target month's length. */
export function addMonths(d: LocalDate, months: number): LocalDate {
  const [y, m, dd] = ymd(d);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(dd, monthLength(ny, nm)));
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const [y, m, dd] = ymd(d);
  const t = new Date(Date.UTC(y, m - 1, dd + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = ymd(a);
  const [by, bm, bd] = ymd(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** The exclusive end date of a goal period. */
export function periodEnd(kind: GoalPeriodKind, start: LocalDate): LocalDate {
  switch (kind) {
    case 'week':
      return addDays(start, 7);
    case 'month':
      return addMonths(start, 1);
    case 'quarter':
      return addMonths(start, 3);
    case 'year':
      return addMonths(start, 12);
  }
}

const METRIC_WORDS: Record<GoalMetric, [string, string]> = {
  appointments_set: ['appointment set', 'appointments set'],
  appointments_held: ['appointment held', 'appointments held'],
  agreements_signed: ['agreement signed', 'agreements signed'],
  closings: ['closing', 'closings'],
  touches: ['touch', 'touches'],
};

export function metricWords(metric: GoalMetric, n: number): string {
  const [one, many] = METRIC_WORDS[metric];
  return plural(n, one, many);
}

export function goalPace(goal: AgentGoal, scoreboard: GoalScoreboard, now: Instant, zone: IanaZone): Pace {
  const midnight = localTimeFromSeconds(0);
  const endDate = periodEnd(goal.periodKind, goal.periodStart);
  const startAt = resolveLocal(goal.periodStart, midnight, zone, 'earlier');
  const endAt = resolveLocal(endDate, midnight, zone, 'earlier');
  const span = endAt - startAt;
  const fraction = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - startAt) / span));

  const actual = Math.max(0, scoreboard.actual);
  const target = goal.target;
  const exact = target * fraction;
  const expectedByNow = Math.round(exact * 10) / 10;
  // ceil with a tiny tolerance so 3.0000000001 (float noise) does not demand 4
  const ceilE = Math.ceil(exact - 1e-9);
  const floorE = Math.floor(exact + 1e-9);
  const behindBy = Math.max(0, ceilE - actual);
  const remaining = Math.max(0, target - actual);

  const today = localDateOf(now, zone);
  const daysLeft = today < goal.periodStart ? daysBetween(goal.periodStart, endDate) : Math.max(0, daysBetween(today, endDate));

  let status: PaceStatus;
  if (actual >= target) status = 'done';
  else if (actual < floorE) status = 'behind';
  else if (actual > ceilE) status = 'ahead';
  else status = 'on_track';

  const words =
    status === 'done'
      ? `${actual} of ${metricWords(goal.metric, target)}: goal reached`
      : `${actual} of ${metricWords(goal.metric, target)}; ${expectedByNow} expected by now; ${remaining} to go in ${plural(daysLeft, 'day', 'days')}`;

  return {
    goalId: goal.id,
    metric: goal.metric,
    periodStart: goal.periodStart,
    periodEndExclusive: endDate,
    actual,
    target,
    expectedByNow,
    behindBy,
    remaining,
    daysLeft,
    status,
    words,
  };
}
