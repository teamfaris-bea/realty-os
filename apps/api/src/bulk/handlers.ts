// Job handlers of parity module 63 (registered through worker/handlers/index.ts):
//   bulk.run   (standalone) runBulkAction: one item per transaction as the creator; idempotent across a crash
//              (derived send keys and command ids; processed items are final), so a re-run after a lease
//              expiry continues where the last run stopped and never re-sends.
import type { Providers } from '../providers/index.js';
import { commsRuntime } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { BULK_RUN, type BulkRunPayload } from './contract.js';
import { runBulkAction } from './run.js';

type DepsFor = (providers: Providers) => CommsDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

export function bulkRunHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<BulkRunPayload> {
  return {
    kind: BULK_RUN.kind,
    queue: BULK_RUN.queue,
    priority: BULK_RUN.priority,
    mode: 'standalone',
    via: 'worker',
    schema: BULK_RUN.schema,
    maxAttempts: 20,
    async run(ctx, p) {
      const r = await runBulkAction(p.actionId, depsFor(ctx.providers), ctx.actor.tenantId);
      if (r.kind === 'retry') return { retryAt: r.at };
      ctx.log.info('bulk.run', { kind: BULK_RUN.kind, jobId: ctx.job.id.toString(), code: r.kind === 'finished' ? r.status : r.kind });
    },
  };
}

export function makeBulkHandlers(depsFor?: DepsFor): JobHandler<unknown>[] {
  return [bulkRunHandler(depsFor) as JobHandler<unknown>];
}

export const bulkHandlers: JobHandler<unknown>[] = makeBulkHandlers();
