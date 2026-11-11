// Velocity shaping (R-OWNER-3: "Velocity is median stage dwell with sample sizes from
// app.stage_dwell_norms() (no new view)"). Core never recomputes the medians: this helper only
// orders the DB rows by stage and adds words that carry the sample size.
import { DEAL_STAGES, type StageDwellNorm, type VelocityRow } from './types.js';
import { plural } from './money.js';

const stageRank = (s: string): number => {
  const i = (DEAL_STAGES as readonly string[]).indexOf(s);
  return i < 0 ? DEAL_STAGES.length : i;
};

/** The DB rows unchanged (median and n), in pipeline order (unknown stages last, by name). */
export function velocityRows(norms: readonly StageDwellNorm[]): VelocityRow[] {
  return [...norms]
    .sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0))
    .map((r) => ({
      stage: r.stage,
      medianDays: r.medianDays,
      sampleSize: r.sampleSize,
      words: `median ${plural(r.medianDays, 'day', 'days')} (n=${r.sampleSize})`,
    }));
}
