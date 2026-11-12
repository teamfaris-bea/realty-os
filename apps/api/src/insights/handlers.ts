// Job handlers of api/insights (registered in worker/handlers/index.ts, one line; R-OWN-27).
//
//   insights.weekly_plan   per-tenant reconcile, hourly, one transaction as the system actor: every active member
//                          (not TCs) whose local day is Monday gets this ISO week's plan and one feed card, once
//                          (plan.ts; Tuesday/Wednesday repair a missed Monday).
import { HOUR_MS, type IdGenerator } from '@realty/core/foundation';
import { defaultIds } from '@realty/db';
import { type z } from 'zod';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { reconcileWeeklyPlans } from './plan.js';

export const INSIGHTS_JOBS = { weeklyPlan: 'insights.weekly_plan' } as const;
export const WEEKLY_PLAN_EVERY_MS = HOUR_MS;

const Empty = jobPayload({});

export function makeInsightsHandlers(ids: IdGenerator = defaultIds()): JobHandler<unknown>[] {
  const weeklyPlan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: INSIGHTS_JOBS.weeklyPlan,
    queue: 'default',
    via: 'timer',
    schema: Empty,
    every: { ms: WEEKLY_PLAN_EVERY_MS, offsetMs: 7 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await reconcileWeeklyPlans(ctx.tx, ctx.actor, ids, ctx.now);
      if (r.built > 0) ctx.log.info('insights.weekly_plan', { jobId: ctx.job.id.toString(), week: r.week, built: r.built, existing: r.existing });
    },
  };
  return [weeklyPlan] as unknown as JobHandler<unknown>[];
}

/** Everything api/insights registers with the worker (CONVENTIONS §3). */
export const insightsHandlers: JobHandler<unknown>[] = makeInsightsHandlers();
