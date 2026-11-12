// Job handlers of api/seller-updates (registered in worker/handlers/index.ts, one line; R-OWN-27, R-SELL-1).
//
//   seller_updates.reconcile  per-tenant, every 5 min, one system transaction: arms, disarms and wakes the
//                             stored listings.seller_update_next_due_at instants and writes due drafts and their
//                             feed cards (reconcile.ts).
import { type z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { reconcileSellerUpdates } from './reconcile.js';

export const SELLER_UPDATE_JOBS = { reconcile: 'seller_updates.reconcile' } as const;
export const SELLER_UPDATE_RECONCILE_EVERY_MS = 5 * 60_000;

type DepsFor = () => Pick<CommsDeps, 'envelope' | 'ids'>;
const Empty = jobPayload({});

export function makeSellerUpdateHandlers(depsFor: DepsFor = commsRuntime): JobHandler<unknown>[] {
  const reconcile: TxJobHandler<z.infer<typeof Empty>> = {
    kind: SELLER_UPDATE_JOBS.reconcile,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: SELLER_UPDATE_RECONCILE_EVERY_MS, offsetMs: 90_000 },
    periodicPayload: {},
    async run(ctx) {
      const d = depsFor();
      const r = await reconcileSellerUpdates(ctx.tx, { envelope: d.envelope, ids: d.ids, tenantId: ctx.actor.tenantId }, ctx.now);
      if (r.armed + r.disarmed + r.retired + r.drafted + r.resumed > 0) ctx.log.info('seller_updates.reconcile', { jobId: ctx.job.id.toString(), ...r });
    },
  };
  return [reconcile] as unknown as JobHandler<unknown>[];
}

/** Everything api/seller-updates registers with the worker (CONVENTIONS §3). */
export const sellerUpdateHandlers: JobHandler<unknown>[] = makeSellerUpdateHandlers();
