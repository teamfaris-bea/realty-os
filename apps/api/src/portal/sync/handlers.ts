// Job handlers of module 45 (registered in worker/handlers/index.ts, one line). Both run as the system of the job's
// tenant in one transaction (TxJobHandler; R-TEN-6). The system publisher is spelled in SQL (published_by_kind), never
// as a constructed actor here (worker/systemActor.test.ts).
import { commsRuntime } from '../../comms/runtime.js';
import type { JobHandler, TxJobHandler } from '../../worker/types.js';
import { linkExpireInTx } from '../signin/links.js';
import type { CardDeps } from '../staff/display.js';
import { PORTAL_LINK_EXPIRE, PORTAL_SYNC_EVERY_MS, PORTAL_SYNC_KIND, SyncPayload } from './jobs.js';
import { portalSyncInTx } from './sync.js';

type DepsFor = () => CardDeps;
const defaultDeps: DepsFor = () => {
  const r = commsRuntime();
  return { linkSecret: r.linkSecret, publicBaseUrl: r.publicBaseUrl };
};

export function makePortalHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const sync: TxJobHandler<Record<string, never>> = {
    kind: PORTAL_SYNC_KIND,
    queue: 'default',
    via: 'worker',
    schema: SyncPayload as never,
    every: { ms: PORTAL_SYNC_EVERY_MS, offsetMs: 75_000 },
    periodicPayload: {},
    async run(ctx) {
      const c = await portalSyncInTx(ctx.tx, ctx.actor, depsFor(), ctx.now);
      if (c.retracted + c.published + c.expired + c.cards + c.links > 0) ctx.log.info('portal.sync', { jobId: ctx.job.id.toString(), ...c });
    },
  };
  const expire: TxJobHandler<{ messageId: string }> = {
    kind: PORTAL_LINK_EXPIRE.kind,
    queue: PORTAL_LINK_EXPIRE.queue,
    via: 'worker',
    schema: PORTAL_LINK_EXPIRE.schema,
    async run(ctx, p) {
      return linkExpireInTx(ctx.tx, p.messageId, ctx.now);
    },
  };
  return [sync, expire] as unknown as JobHandler<unknown>[];
}

/** Everything api/portal registers with the worker (CONVENTIONS §3). */
export const portalHandlers: JobHandler<unknown>[] = makePortalHandlers();
