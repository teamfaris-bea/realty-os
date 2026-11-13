// Response and request schemas of api/coaching-trends (module 54). Counts only: no score, grade, rank, percentage,
// metRate, quote, call id, contact id, tenant id or confidence (R-COACH-6, R-COACH-7, R-AST-13, R-TEN-3; snapshot test).
import { z } from 'zod';

/** owner question 5's default: one week against the week before */
export const DEFAULT_WEEKS = 1;

export const TrendsQuery = z.object({ weeks: z.coerce.number().int().min(1).max(4).default(DEFAULT_WEEKS) }).strict();

const Counts = z.object({ calls: z.number().int().min(0), scored: z.number().int().min(0), met: z.number().int().min(0).nullable() });
export const TrendItem = z.object({
  key: z.string(),
  label: z.string(),
  before: Counts,
  after: Counts,
  direction: z.enum(['improving', 'slipping', 'steady', 'not_enough_data']),
  sentence: z.string(),
});
const Window = z.object({ from: z.string(), to: z.string() });
const Base = {
  state: z.enum(['not_cleared', 'scoring_off', 'tl_not_allowed', 'ready']),
  sentence: z.string(),
  windows: z.object({ before: Window, after: Window }),
};

export const OwnTrendsResponse = z.object({ trends: z.object({ ...Base, items: z.array(TrendItem) }) });
export const TeamTrendsResponse = z.object({
  trends: z.object({ ...Base, team: z.array(TrendItem), members: z.array(z.object({ userId: z.uuid(), name: z.string(), items: z.array(TrendItem) })).max(200) }),
});
