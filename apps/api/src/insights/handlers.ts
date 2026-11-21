// Job handlers of api/insights (registered in worker/handlers/index.ts, one line; R-OWN-27).
//
//   insights.weekly_plan   per-tenant reconcile, hourly, one transaction as the system actor: every active member
//                          (not TCs) whose local day is Monday gets this ISO week's plan and one feed card, once
//                          (plan.ts; Tuesday/Wednesday repair a missed Monday).
//   insights.timing_scan   b20 (R-TCUE-1..8): nightly per tenant at 07:30 UTC (2:30 AM Eastern standard time),
//                          standalone (the LOCAL model is never called inside a transaction): the next notes not yet
//                          read, one timing_cues row each (timing.ts). Off without a local model or with AI off. A run
//                          that leaves notes asks to run again a minute later; a model that is down, an hour later.
import { DAY_MS, HOUR_MS, type IdGenerator, type Instant } from '@realty/core/foundation';
import { defaultIds } from '@realty/db';
import { type z } from 'zod';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { reconcileWeeklyPlans } from './plan.js';
import { TIMING_MODEL_DOWN_RETRY_MS, scanTimingCues } from './timing.js';

export const INSIGHTS_JOBS = { weeklyPlan: 'insights.weekly_plan', timingScan: 'insights.timing_scan' } as const;
export const WEEKLY_PLAN_EVERY_MS = HOUR_MS;
export const TIMING_SCAN_EVERY_MS = DAY_MS;
export const TIMING_SCAN_OFFSET_MS = 7 * HOUR_MS + 30 * 60_000;

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
  const timingScan: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: INSIGHTS_JOBS.timingScan,
    queue: 'default',
    mode: 'standalone',
    via: 'timer',
    schema: Empty,
    every: { ms: TIMING_SCAN_EVERY_MS, offsetMs: TIMING_SCAN_OFFSET_MS },
    periodicPayload: {},
    async run(ctx) {
      const r = await scanTimingCues(ctx, ctx.providers.timingAi, { ids });
      // counts and codes only: never a note's words
      if (r.kind === 'off') {
        ctx.log.info('insights.timing_scan', { jobId: ctx.job.id.toString(), code: r.reason });
        return;
      }
      ctx.log.info('insights.timing_scan', { jobId: ctx.job.id.toString(), code: r.modelDown ? 'MODEL_DOWN' : r.more ? 'MORE' : 'DONE', read: r.read, modelCalls: r.modelCalls, cues: r.cues });
      if (r.modelDown) return { retryAt: (ctx.now + TIMING_MODEL_DOWN_RETRY_MS) as Instant };
      if (r.more) return { retryAt: (ctx.now + 60_000) as Instant };
    },
  };
  return [weeklyPlan, timingScan] as unknown as JobHandler<unknown>[];
}

/** Everything api/insights registers with the worker (CONVENTIONS §3). */
export const insightsHandlers: JobHandler<unknown>[] = makeInsightsHandlers();
