// triggers.reconcile (R-NURT-1, R-OWN-27; ARCHITECTURE §21.4): the per-tenant 60-second pass that wakes due
// trigger firings from their stored `scheduled_for` into one `trigger.step {stepRunId}` job per batch
// (executeTriggerRun re-checks everything), and lets digest members follow their batch message's outcome.
// Phase 1's sweeper and executePlaybookStep only know enrollments, so trigger runs have their own handler; no
// module edits app.due_work. Idempotent: the job's dedupe key is the run, and a run already built is a no-op.
import type { Instant } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import * as R from './repos.js';
import { NURTURE_JOBS, RECONCILE_BATCH } from './types.js';

export async function reconcileTriggersInTx(tx: Tx, now: Instant, limit = RECONCILE_BATCH): Promise<{ woken: number; settled: number }> {
  const settled = await R.settleBatches(tx);
  const due = await R.dueLeads(tx, now, limit);
  for (const stepRunId of due) {
    await enqueueJob(tx, { queue: 'default', kind: NURTURE_JOBS.step, payload: { stepRunId }, dedupeKey: `${NURTURE_JOBS.step}:${stepRunId}` });
  }
  return { woken: due.length, settled };
}
