// Job handlers of api/stage-automation (registered through worker/handlers/index.ts, CONVENTIONS §3).
// Every handler is idempotent: a decision is one row per stage event (read first under the contact lock),
// an enrollment and a reminder task have derived ids.
import { type Instant, plusMs } from '@realty/core/foundation';
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { enqueueTyped } from '../worker/registry.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { createAnnualRemindersInTx } from './annual.js';
import { ANNUAL_KIND, type ReconcilePayload, SCAN_LIMIT, SCAN_WINDOW_MS, STAGE_RECONCILE, STAGE_SCAN_KIND } from './contract.js';
import { type StageAutomationDeps, reconcileWith } from './reconcile.js';
import { pendingStageEvents } from './repos.js';

type DepsFor = () => StageAutomationDeps;
const defaultDeps: DepsFor = () => ({ db: commsRuntime().db });
const Empty = jobPayload({});

export function makeStageAutomationHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: StandaloneJobHandler<ReconcilePayload> = {
    kind: STAGE_RECONCILE.kind,
    queue: STAGE_RECONCILE.queue,
    priority: STAGE_RECONCILE.priority,
    mode: 'standalone',
    via: 'assistant',
    schema: STAGE_RECONCILE.schema,
    async run(ctx, p) {
      // standalone: the stage-changer's visibility check is its own transaction, never nested in the job's
      const r = await reconcileWith(depsFor(), ctx.actor, (fn) => ctx.withTx(fn), p.stageEventId);
      const a = r.automation;
      ctx.log.info('stage_automation.reconcile', { jobId: ctx.job.id.toString(), code: a === null ? 'none' : 'started' in a ? 'started' : a.skipped });
    },
  };
  const scan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: STAGE_SCAN_KIND,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 60_000 },
    periodicPayload: {},
    async run(ctx) {
      for (const id of await pendingStageEvents(ctx.tx, plusMs(ctx.now, -SCAN_WINDOW_MS) as Instant, SCAN_LIMIT)) {
        const p = { stageEventId: id };
        await enqueueTyped(ctx.tx, STAGE_RECONCILE, p, { dedupeKey: STAGE_RECONCILE.dedupeKey(p) });
      }
    },
  };
  const annual: TxJobHandler<z.infer<typeof Empty>> = {
    kind: ANNUAL_KIND,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 6 * 60 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const n = await createAnnualRemindersInTx(ctx.tx, ctx.now);
      ctx.log.info('stage_automation.annual', { jobId: ctx.job.id.toString(), code: `created:${n}` });
    },
  };
  return [reconcile, scan, annual] as unknown as JobHandler<unknown>[];
}

/** Everything api/stage-automation registers with the worker (CONVENTIONS §3). */
export const stageAutomationHandlers: JobHandler<unknown>[] = makeStageAutomationHandlers();
