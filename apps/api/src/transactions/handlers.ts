// Job handlers of api/transactions (registered in worker/handlers/index.ts, one line; R-OWN-27).
//
//   milestones.reconcile     per tenant, every 5 min, tx, as the system: repairs missing instants and turns due
//                            reminders into deal_date_upcoming firings (module 26 executes them)
//   milestones.date_changed  default, tx, as the system: a person moved, completed or waived a date; its stale
//                            firings are skipped visibly and their queued messages canceled
// Nothing here sends: module 26 builds the message and comms/dispatch.ts gates it at send time.
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import type { NurtureDeps } from '../nurture/types.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { dateChangedInTx, milestonesReconcileInTx } from './reconcile.js';
import { MILESTONES_RECONCILE_EVERY_MS, TRANSACTION_JOBS } from './types.js';

type DepsFor = (providers: Providers) => Pick<NurtureDeps, 'ids'>;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

const Empty = jobPayload({});
const DateChangedPayload = jobPayload({ dealDateId: zId });

export function makeTransactionHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: TxJobHandler<Record<string, never>> = {
    kind: TRANSACTION_JOBS.reconcile,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: MILESTONES_RECONCILE_EVERY_MS, offsetMs: 45_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await milestonesReconcileInTx(ctx.tx, depsFor(ctx.providers), ctx.now);
      if (r.repaired + r.reminders > 0) ctx.log.info('milestones.reconcile', { jobId: ctx.job.id.toString(), repaired: r.repaired, reminders: r.reminders, firings: r.firings });
    },
  };
  const dateChanged: TxJobHandler<{ dealDateId: string }> = {
    kind: TRANSACTION_JOBS.dateChanged,
    queue: 'default',
    via: 'worker',
    schema: DateChangedPayload,
    async run(ctx, p) {
      const r = await dateChangedInTx(ctx.tx, p.dealDateId);
      if (r.skipped > 0) ctx.log.info('milestones.date_changed', { jobId: ctx.job.id.toString(), skipped: r.skipped, canceled: r.canceled });
    },
  };
  return [reconcile, dateChanged] as unknown as JobHandler<unknown>[];
}

/** Everything api/transactions registers with the worker (CONVENTIONS §3). */
export const transactionHandlers: JobHandler<unknown>[] = makeTransactionHandlers();
