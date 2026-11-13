// Job handlers of module 53 (registered in worker/handlers/index.ts by one additive line).
//
//   gbp.reconcile   per tenant, every 5 minutes, as the system via 'provider' (R-OWN-27: each location is woken by its
//                   own stored next_sync_at). The review sync (sync.ts), which also settles replies in flight (E465).
//                   While platform:gbp is uncleared or the adapter is not configured it does nothing and calls nothing.
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobContext, StandaloneJobHandler } from '../worker/types.js';
import { GBP_SYNC_EVERY_MS, type GbpSyncDeps, syncReviews } from './sync.js';

export const GBP_RECONCILE_KIND = 'gbp.reconcile' as const;

const Empty = jobPayload({});
type DepsFor = (ctx: StandaloneJobContext) => GbpSyncDeps;

const defaultDeps: DepsFor = (ctx) => {
  const r = commsRuntime();
  return { envelope: r.envelope, ids: r.ids, gbp: ctx.providers.gbp };
};

export function makeGbpHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: GBP_RECONCILE_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: GBP_SYNC_EVERY_MS, offsetMs: 41_000 },
    periodicPayload: {},
    async run(ctx) {
      const s = await syncReviews(ctx, depsFor(ctx));
      if (s.locations > 0) {
        ctx.log.info('gbp.reconcile', { jobId: ctx.job.id.toString(), code: `locations:${s.locations}:pages:${s.pages}:new:${s.inserted}:edited:${s.updated}:removed:${s.removed}:settled:${s.settled}:errors:${s.errors}` });
      }
    },
  };
  return [reconcile] as unknown as JobHandler<unknown>[];
}

export const gbpHandlers: JobHandler<unknown>[] = makeGbpHandlers();
