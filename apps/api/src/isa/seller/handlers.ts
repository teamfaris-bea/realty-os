// The seller part's jobs (ISA-3; registered in worker/handlers/index.ts, flagged). Every job runs as the system via
// 'assistant' (ai_isa.seller_facts).
//   ai_isa.seller_watch       hourly: enqueues one ai_isa.seller_watch_one per live seller assignment and local day
//   ai_isa.seller_watch_one   one assignment's watch run (watch.ts), in its own transaction
//   ai_isa.seller_rerender    after TX1 found a fact changed (H3, E537): one model-free re-render per turn, through
//                             STUB(ISA-2) queueFactsMessageInTx (not delivered until ISA-2 builds it)
import type { Instant } from '@realty/core/foundation';
import { enqueueJob } from '@realty/db';
import { z } from 'zod';
import { commsRuntime } from '../../comms/runtime.js';
import type { CommsDeps } from '../../comms/types.js';
import type { Providers } from '../../providers/index.js';
import type { JobHandler, TxJobHandler } from '../../worker/types.js';
import { composeMessage } from './isa1Seam.js';
import { type IsaDeps, assignmentById, contextFor, queueFactsMessageInTx } from './isa2Seam.js';
import { renderSellerFactsInTx } from './index.js';
import { runSellerWatchInTx, sellerWatchSweepInTx } from './watch.js';

export const SELLER_WATCH_EVERY_MS = 60 * 60_000;

const Empty = z.strictObject({});
const One = z.strictObject({ assignmentId: z.uuid(), day: z.string().optional() });
const Rerender = z.strictObject({ assignmentId: z.uuid(), messageId: z.uuid() });

type DepsFor = (providers: Providers) => CommsDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

export function makeSellerHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const deps = (ctx: { providers: Providers }): IsaDeps => depsFor(ctx.providers) as IsaDeps;
  const sweep: TxJobHandler<z.infer<typeof Empty>> = {
    kind: 'ai_isa.seller_watch', queue: 'default', via: 'assistant', schema: Empty,
    async run(ctx) {
      await sellerWatchSweepInTx(ctx.tx, (assignmentId, day) => enqueueJob(ctx.tx, { queue: 'default', kind: 'ai_isa.seller_watch_one', payload: { assignmentId, day }, dedupeKey: `ai_isa.seller_watch:${assignmentId}:${day}` }).then(() => undefined), ctx.now as Instant);
    },
  };
  const one: TxJobHandler<z.infer<typeof One>> = {
    kind: 'ai_isa.seller_watch_one', queue: 'default', via: 'assistant', schema: One,
    async run(ctx, p) {
      await runSellerWatchInTx(ctx.tx, deps(ctx), ctx.actor, p.assignmentId, ctx.now as Instant);
    },
  };
  const rerender: TxJobHandler<z.infer<typeof Rerender>> = {
    kind: 'ai_isa.seller_rerender', queue: 'default', via: 'assistant', schema: Rerender,
    async run(ctx, p) {
      const a = await assignmentById(ctx.tx, p.assignmentId);
      if (a === null || a.endedAt !== null) return;
      const c = await contextFor(ctx.tx, a, ctx.now as Instant);
      const f = await renderSellerFactsInTx(ctx.tx, ctx.actor, a, ctx.now as Instant, { messageKind: 'facts', handles: ['comps'] }, {
        channels: c.channels, compose: (core, ch) => composeMessage({ body: core, who: c.who, firstInThread: true, optOutHint: true, channel: ch }),
      });
      if (f !== null && f.ok) await queueFactsMessageInTx(ctx.tx, { assignmentId: a.id, channel: f.channel, body: f.body });
    },
  };
  return [{ ...sweep, every: { ms: SELLER_WATCH_EVERY_MS, offsetMs: 50_000 }, periodicPayload: {} } as JobHandler<unknown>, one as JobHandler<unknown>, rerender as JobHandler<unknown>];
}

export const sellerHandlers: JobHandler<unknown>[] = makeSellerHandlers();
