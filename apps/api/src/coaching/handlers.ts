// Job handlers of api/coaching (registered through worker/handlers/index.ts, CONVENTIONS §3).
//
//   coaching.call_review   default  standalone        one call: transcript → rubric claims → call_scores (review.ts)
//   coaching.review_scan   default  tx, every 5 min   finds reviewable calls without a review (empty while off)
//   coaching.daily_fix     default  tx, hourly        one coaching_fix:{user}:{date} card per member per local day
// The model call runs in the standalone handler only (never inside a transaction). Every handler is
// idempotent (the call_scores key, the action's dedupe key, one card per user and date). Payloads hold ids only.
import { enqueueJob } from '@realty/db';
import type { z } from 'zod';
import type { AssistantDeps } from '../assistant/types.js';
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { reconcileDailyFixes } from './fix.js';
import { callsAwaitingReview } from './repos/coaching.js';
import { REVIEW_JOB_DEDUPE, reviewCall } from './review.js';

export const COACHING_JOBS = {
  callReview: 'coaching.call_review',
  reviewScan: 'coaching.review_scan',
  dailyFix: 'coaching.daily_fix',
} as const;

type DepsFor = (providers: Providers) => AssistantDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

const CallPayload = jobPayload({ callId: zId });
const Empty = jobPayload({});

export function makeCoachingHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const review: StandaloneJobHandler<z.infer<typeof CallPayload>> = {
    kind: COACHING_JOBS.callReview,
    queue: 'default',
    mode: 'standalone',
    via: 'assistant',
    schema: CallPayload,
    async run(ctx, p) {
      const r = await reviewCall(ctx.actor, p.callId, depsFor(ctx.providers));
      ctx.log.info('call_review', { jobId: ctx.job.id.toString(), code: r.kind === 'skipped' ? r.reason : r.kind });
    },
  };
  const scan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: COACHING_JOBS.reviewScan,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 5 * 60_000, offsetMs: 90_000 },
    periodicPayload: {},
    async run(ctx) {
      for (const callId of await callsAwaitingReview(ctx.tx, ctx.now)) {
        await enqueueJob(ctx.tx, { queue: 'default', kind: COACHING_JOBS.callReview, payload: { callId }, dedupeKey: REVIEW_JOB_DEDUPE(callId) });
      }
    },
  };
  const daily: TxJobHandler<z.infer<typeof Empty>> = {
    kind: COACHING_JOBS.dailyFix,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: 60 * 60_000, offsetMs: 7 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await reconcileDailyFixes(ctx.tx, depsFor(ctx.providers).ids, ctx.now);
      ctx.log.info('daily_fix', { jobId: ctx.job.id.toString(), code: r.off ? 'off' : 'ready', written: r.written, closed: r.closed });
    },
  };
  return [review, scan, daily] as unknown as JobHandler<unknown>[];
}

/** Everything api/coaching registers with the worker (CONVENTIONS §3). */
export const coachingHandlers: JobHandler<unknown>[] = makeCoachingHandlers();
