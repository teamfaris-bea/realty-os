// Kill-the-worker harness (BUILD_PLAN module 9 tests). Run as a CHILD PROCESS by crash.test.ts:
//
//   CRASH_DB_URL=… CRASH_MODE=followup|dispatch CRASH_AT=mid_tx|after_tx1|after_send CRASH_LOG=/tmp/x \
//     node --import tsx --conditions=@realty/source crashWorker.ts
//
// The child claims ONE job with a short lease, runs the real handler up to the crash point, prints
// CRASH_POINT and hangs; the parent SIGKILLs it there (no finally blocks, no rollback, no finish_job).
//
// `testDispatchHandler` stands in for api/comms' dispatchOutbound (module 12, not built yet) with the
// exact transaction structure ARCHITECTURE §9 prescribes: TX1 claims ONLY a scheduled/queued message
// (→ dispatching, dispatched_at stamped, send-time gate decision attached), then provider.send, then
// TX2 records the result. "provider.send" appends the message id to a file, so the parent can count
// sends across processes.
import { appendFileSync } from 'node:fs';
import { createDatabase } from '@realty/db';
import { sql } from 'kysely';
import { type z } from 'zod';
import { type FollowupJobPayload, ownershipFollowupHandler } from '../handlers/followup.js';
import { createWorker } from '../loop.js';
import { silentLogger } from '../observability.js';
import { jobPayload, zId } from '../payload.js';
import { HandlerRegistry } from '../registry.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../types.js';

export type CrashAt = 'none' | 'mid_tx' | 'after_tx1' | 'after_send';

export const TestDispatchPayload = jobPayload({ messageId: zId });
export type TestDispatchPayload = z.infer<typeof TestDispatchPayload>;

export function testDispatchHandler(o: { providerLog: string; crash?: (at: CrashAt) => Promise<void> }): StandaloneJobHandler<TestDispatchPayload> {
  const crash = o.crash ?? (async () => {});
  return {
    kind: 'test.dispatch',
    queue: 'realtime',
    mode: 'standalone',
    schema: TestDispatchPayload,
    async run(ctx, p) {
      // TX1: only a scheduled/queued message can be claimed, so a re-run never re-sends
      const claimed = await ctx.withTx(async (tx) => {
        const r = await sql`
          UPDATE messages SET status = 'dispatching', dispatched_at = clock_timestamp()
           WHERE tenant_id = app.tenant_id() AND id = ${p.messageId} AND status IN ('scheduled', 'queued')`.execute(tx);
        return Number(r.numAffectedRows ?? 0n) === 1;
      });
      if (!claimed) return;
      await crash('after_tx1');
      appendFileSync(o.providerLog, `${p.messageId}\n`); // provider.send
      await crash('after_send');
      await ctx.withTx(async (tx) => {
        await sql`UPDATE messages SET status = 'sent', provider = 'fake', provider_message_ref = ${'ref-' + p.messageId}
                   WHERE tenant_id = app.tenant_id() AND id = ${p.messageId} AND status = 'dispatching'`.execute(tx);
      });
    },
  };
}

const hang = (): Promise<never> =>
  new Promise<never>(() => {
    process.stdout.write('CRASH_POINT\n');
    setInterval(() => {}, 1 << 30);
  });

async function main(): Promise<void> {
  const url = process.env.CRASH_DB_URL!;
  const mode = process.env.CRASH_MODE as 'followup' | 'dispatch';
  const at = process.env.CRASH_AT as CrashAt;
  const db = createDatabase({ url, max: 2, applicationName: 'crash-worker' });
  const followup = ownershipFollowupHandler();
  const crashingFollowup: TxJobHandler<FollowupJobPayload> = {
    ...followup,
    // the real handler, then the process dies with its transaction still open (never committed)
    async run(ctx, p) {
      await followup.run(ctx, p);
      if (at === 'mid_tx') await hang();
    },
  };
  const handler: JobHandler<unknown> =
    mode === 'followup'
      ? (crashingFollowup as JobHandler<unknown>)
      : (testDispatchHandler({ providerLog: process.env.CRASH_LOG!, crash: async (point) => (point === at ? hang() : undefined) }) as JobHandler<unknown>);
  const w = createWorker({ queues: ['realtime'], concurrency: 1, worker: 'crash-worker', db, registry: new HandlerRegistry().registerAll([handler]), log: silentLogger, leaseSeconds: 2 });
  for (let i = 0; i < 200; i++) {
    if ((await w.tick()) > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  process.stdout.write('NO_CRASH\n');
  await db.close();
}

if (process.env.CRASH_MODE) {
  main().catch((e: unknown) => {
    process.stdout.write(`CHILD_ERROR ${(e as Error).name}: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
