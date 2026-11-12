// Job handlers of api/nurture (registered in worker/handlers/index.ts, one line; R-OWN-27, ARCHITECTURE §21.4).
//
//   triggers.reconcile        per tenant, every 60 s, tx: wakes due firings (one trigger.step per batch) and
//                             settles digest members with their batch message's outcome
//   trigger.step              default, tx: executeTriggerRun(stepRunId) under the contact lock
//   nurture.anniversary_scan  per tenant, hourly, tx: yearly home anniversaries (a no-op after the first run of
//                             a local day: the firing key anniversary:{deal}:{yyyy}:{contact})
//   nurture.listing_changed   default, tx: a team listing's price-history row or status change → firings
// Nothing here sends: messages are queued for comms.dispatch, which gates them at send time.
import { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { jobPayload, zId, zToken } from '../worker/payload.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { anniversaryScanInTx, recordListingChangeInTx } from './detect.js';
import { executeTriggerRunInTx } from './execute.js';
import { reconcileTriggersInTx } from './reconcile.js';
import { ANNIVERSARY_SCAN_EVERY_MS, NURTURE_JOBS, type NurtureDeps, TRIGGER_RECONCILE_EVERY_MS } from './types.js';

type DepsFor = (providers: Providers) => NurtureDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

const Empty = jobPayload({});
const StepPayload = jobPayload({ stepRunId: zId });
const STATUSES = ['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired'] as const;
const ListingChangedPayload = jobPayload({ listingId: zId, historyId: zId.nullable(), fromStatus: z.enum(STATUSES), priceChanged: z.boolean(), statusKey: zToken.nullable() });

export function makeNurtureHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: TxJobHandler<z.infer<typeof Empty>> = {
    kind: NURTURE_JOBS.reconcile,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: TRIGGER_RECONCILE_EVERY_MS, offsetMs: 15_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await reconcileTriggersInTx(ctx.tx, ctx.now);
      if (r.woken + r.settled > 0) ctx.log.info('triggers.reconcile', { jobId: ctx.job.id.toString(), woken: r.woken, settled: r.settled });
    },
  };
  const step: TxJobHandler<z.infer<typeof StepPayload>> = {
    kind: NURTURE_JOBS.step,
    queue: 'default',
    via: 'assistant',
    schema: StepPayload,
    async run(ctx, p) {
      const r = await executeTriggerRunInTx(ctx.tx, depsFor(ctx.providers), ctx.actor.tenantId, p.stepRunId, ctx.now);
      ctx.log.info('trigger.step', { jobId: ctx.job.id.toString(), code: r.kind === 'noop' ? r.reason : r.kind, runs: 'runIds' in r ? r.runIds.length : 0 });
    },
  };
  const anniversaries: TxJobHandler<z.infer<typeof Empty>> = {
    kind: NURTURE_JOBS.anniversaryScan,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: ANNIVERSARY_SCAN_EVERY_MS, offsetMs: 7 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const n = await anniversaryScanInTx(ctx.tx, depsFor(ctx.providers), ctx.now);
      if (n > 0) ctx.log.info('nurture.anniversary_scan', { jobId: ctx.job.id.toString(), fired: n });
    },
  };
  const listingChanged: TxJobHandler<z.infer<typeof ListingChangedPayload>> = {
    kind: NURTURE_JOBS.listingChanged,
    queue: 'default',
    via: 'assistant',
    schema: ListingChangedPayload,
    async run(ctx, p) {
      const n = await recordListingChangeInTx(ctx.tx, depsFor(ctx.providers), { listingId: p.listingId, before: { status: p.fromStatus, priceCents: null }, priceChanged: p.priceChanged, historyId: p.historyId, statusKey: p.statusKey, now: ctx.now });
      if (n > 0) ctx.log.info('nurture.listing_changed', { jobId: ctx.job.id.toString(), fired: n });
    },
  };
  return [reconcile, step, anniversaries, listingChanged] as unknown as JobHandler<unknown>[];
}

/** Everything api/nurture registers with the worker (CONVENTIONS §3). */
export const nurtureHandlers: JobHandler<unknown>[] = makeNurtureHandlers();
