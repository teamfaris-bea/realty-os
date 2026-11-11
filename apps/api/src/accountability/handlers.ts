// Job handlers of api/accountability (registered through worker/handlers/index.ts, CONVENTIONS §3).
//
//   exception.recompute   default   tx   { scope: 'tenant' }            periodic: every 60 s per tenant (R-ACC-1)
//   scoreboard.rollup     default   standalone  {}                      periodic: every 10 min per tenant (0027 daily rollup)
//                                       { scope: { contactId } }       on a relevant write (requestExceptionRecompute)
//
// The tenant scan is a periodic job: the maintenance pass keeps one live job per tenant (dedupe
// `periodic:exception.recompute`) and each run reschedules itself 60 s later ({ retryAt }), so a condition
// that becomes true only with time (a promise falls due, an appointment ended 2 h ago, a send stayed
// unknown for 10 min / dispatching for 20 min) enters the queue within 60 s with no write at all.
// One job = one transaction = one tenant (R-TEN-6); the payload holds a scope code or one id (R-TEN-7).
import { type ContactId, type Instant, MINUTE_MS, instant } from '@realty/core/foundation';
import { defaultIds, type Tx } from '@realty/db';
import { z } from 'zod';
import { jobPayload, zId } from '../worker/payload.js';
import { enqueueTyped } from '../worker/registry.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { type RecomputeScope, recomputeExceptions } from './exceptions.js';
import { runScoreboardRollup } from './scoreboardRollup.js';

export const EXCEPTION_RECOMPUTE_KIND = 'exception.recompute' as const;
/** R-ACC-1: time-only conditions appear within this long. */
export const RECOMPUTE_EVERY_MS = MINUTE_MS;

export const RecomputePayload = jobPayload({ scope: z.union([z.literal('tenant'), z.strictObject({ contactId: zId })]) });
export type RecomputePayload = { scope: 'tenant' | { contactId: ContactId } };

export const contactRecomputeKey = (contactId: string) => `exception.recompute:${contactId}`;

/** BUILD_PLAN interface: derive/clear the exception queue for a tenant or one contact. */
export const exceptionRecompute: TxJobHandler<RecomputePayload> = {
  kind: EXCEPTION_RECOMPUTE_KIND,
  queue: 'default',
  via: 'worker',
  priority: 80,
  schema: RecomputePayload as unknown as z.ZodType<RecomputePayload>,
  every: { ms: RECOMPUTE_EVERY_MS },
  periodicPayload: { scope: 'tenant' },
  async run(ctx, p) {
    const scope: RecomputeScope = p.scope === 'tenant' ? 'tenant' : { contactId: p.scope.contactId };
    const r = await recomputeExceptions(ctx.tx, scope, ctx.now, defaultIds());
    ctx.log.debug('exception.recompute', { jobId: ctx.job.id.toString(), code: p.scope === 'tenant' ? 'tenant' : 'contact', upserted: r.upserted, cleared: r.cleared });
    // the tenant scan keeps itself alive every 60 s (the periodic dedupe key stays with this job)
    if (p.scope === 'tenant') return { retryAt: instant(ctx.now + RECOMPUTE_EVERY_MS) as Instant };
  },
};

/**
 * Asks for a contact-scoped recompute after a relevant write (a send failed, a promise task changed, an
 * outcome was logged, an ownership period started or ended). Call it inside the writing transaction;
 * repeated calls before the job runs collapse into one (dedupe key per contact).
 */
export async function requestExceptionRecompute(tx: Tx, contactId: string): Promise<boolean> {
  return enqueueTyped(tx, exceptionRecompute, { scope: { contactId: contactId as ContactId } }, { dedupeKey: contactRecomputeKey(contactId) });
}

export const SCOREBOARD_ROLLUP_KIND = 'scoreboard.rollup' as const;
/** How often the rollup job runs per tenant: a closed day is rolled within about two runs of midnight. */
export const SCOREBOARD_ROLLUP_EVERY_MS = 10 * MINUTE_MS;
export const ScoreboardRollupPayload = jobPayload({});

/**
 * The scoreboard's daily rollup (0027, scoreboardRollup.ts). Standalone: the horizon sample needs a
 * transaction of its own after the roll's. Periodic like the tenant scan above (dedupe
 * `periodic:scoreboard.rollup`, rescheduling itself), so it also backfills a database that has none.
 */
export const scoreboardRollup: StandaloneJobHandler<Record<string, never>> = {
  kind: SCOREBOARD_ROLLUP_KIND,
  queue: 'default',
  mode: 'standalone',
  via: 'worker',
  priority: 120,
  schema: ScoreboardRollupPayload as unknown as z.ZodType<Record<string, never>>,
  every: { ms: SCOREBOARD_ROLLUP_EVERY_MS, offsetMs: 3 * MINUTE_MS },
  periodicPayload: {},
  async run(ctx) {
    const r = await runScoreboardRollup((fn) => ctx.withTx((tx) => fn(tx)));
    ctx.log.debug('scoreboard.rollup', { jobId: ctx.job.id.toString(), calls: r.calls, daysRolled: r.daysRolled, marksCleared: r.marksCleared, sampled: r.sampled });
    return { retryAt: instant(ctx.now + SCOREBOARD_ROLLUP_EVERY_MS) as Instant };
  },
};

/** What api/accountability registers with the worker (CONVENTIONS §3). */
export const accountabilityHandlers: JobHandler<unknown>[] = [exceptionRecompute as unknown as JobHandler<unknown>, scoreboardRollup as unknown as JobHandler<unknown>];
