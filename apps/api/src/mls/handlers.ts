// Job handlers of api/mls (registered in worker/handlers/index.ts, one line; R-OWN-27).
//
//   mls.sync              per-tenant reconcile, every 60 s, standalone (it commits between the claim, the
//                         read outside any transaction and the fenced write): every live mls_feed connection
//                         whose stored next_sync_at is due runs once (sync.ts).
//   mls.compliance_sweep  per-tenant, every 5 min, one transaction: stale feeds degrade, queued alerts with
//                         MLS data that may no longer reach a client are canceled, mirrors are linked (sweep.ts).
import { type z } from 'zod';
import { loadConfig } from '../config.js';
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { complianceSweepInTx } from './sweep.js';
import { type MlsDeps, syncDueConnections } from './sync.js';

export const MLS_JOBS = { sync: 'mls.sync', complianceSweep: 'mls.compliance_sweep' } as const;
export const MLS_SYNC_EVERY_MS = 60_000;
export const MLS_SWEEP_EVERY_MS = 5 * 60_000;

type DepsFor = (providers: Providers) => MlsDeps;
let mlsConfig: MlsDeps['mls'] | null = null;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers, mls: (mlsConfig ??= loadConfig().mls) });
const Empty = jobPayload({});

export function makeMlsHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const sync: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: MLS_JOBS.sync,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: MLS_SYNC_EVERY_MS },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await syncDueConnections(depsFor(ctx.providers), ctx.actor.tenantId, ctx.log);
      if (r.length > 0) ctx.log.info('mls.sync pass', { jobId: ctx.job.id.toString(), outcomes: r.map((x) => x.outcome) });
    },
  };
  const sweep: TxJobHandler<z.infer<typeof Empty>> = {
    kind: MLS_JOBS.complianceSweep,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: MLS_SWEEP_EVERY_MS, offsetMs: 30_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await complianceSweepInTx(ctx.tx, ctx.actor, ctx.now);
      if (r.degraded.length + r.canceledAlerts + r.canceledCmaShares + r.mirrorsLinked + r.canceledHomeValueNotes > 0) ctx.log.info('mls.compliance_sweep', { jobId: ctx.job.id.toString(), degraded: r.degraded.length, canceledAlerts: r.canceledAlerts, canceledCmaShares: r.canceledCmaShares, mirrorsLinked: r.mirrorsLinked, canceledHomeValueNotes: r.canceledHomeValueNotes });
    },
  };
  return [sync, sweep] as unknown as JobHandler<unknown>[];
}

/** Everything api/mls registers with the worker (CONVENTIONS §3). */
export const mlsHandlers: JobHandler<unknown>[] = makeMlsHandlers();
