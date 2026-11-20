// The waiver of a covered source's auto-release is RE-EVALUATED, not one-shot (b19 team-queue lane, review fix M1;
// DATA_MODEL R-TEAMQ-20, E974 to E978).
//
//   job `leads.release_recheck` { changeId }   queue default, as the system actor (via worker), one transaction per lead
//
// R-TEAMQ-13 waives the 30-minute auto-release of a lead whose source is covered (a ledgered `sla_waived` that clears
// the stored release deadline). The waiver holds only while its reason does: the source is covered now AND the lead's
// own owner is an active member (core autoReleaseWaivedNow). QUEUED, in the transaction of the change itself, when
// that can stop being true:
//   - a source's coverage is switched off (leads/coverage.ts setCoverage);
//   - a member stops being active: suspended (admin/members.ts) or put into the staged deactivation
//     (leads/deactivation.ts). They may be a lead's owner, or the named owner or backup of a source.
// WHEN IT RUNS it finds the team's leads that are owned, have had no first touch, and whose release was waived in
// their current ownership period (the ledger's `sla_waived` events by type, then the contact's primary key), and
// asks core for each, under the contact lock (`release_recheck`): a waiver that still holds is left alone; one that
// does not gets a ledgered `sla_restored` with a NEW release deadline, the tenant's release window of staffed time
// counted from that moment, and its `ownership.auto_release` timer. The stored deadline is what the sweeper reads
// (app.due_work), so a lost timer job is re-issued like any other.
//
// WHAT IT NEVER DOES: it moves no lead (the timer decides at the new deadline, and finds the lead covered again if it
// is), notifies nobody, and sends nothing to a client. Idempotent: each lead's command id derives from the change and
// the lead, and a lead whose deadline is stored again is no longer a candidate.
import type { ContactId, IdGenerator } from '@realty/core/foundation';
import { type Tx, applyOwnershipCommandInTx, derivedCommandId, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { jobPayload, zId } from '../worker/payload.js';
import type { StandaloneJobHandler } from '../worker/types.js';

export const RELEASE_RECHECK_JOB = {
  kind: 'leads.release_recheck' as const,
  queue: 'default' as const,
  priority: 40,
  dedupeKey: (changeId: string) => `leads.release_recheck:${changeId}`,
};
export const ReleaseRecheckPayload = jobPayload({ changeId: zId });
export type ReleaseRecheckPayload = { changeId: string };

/** Leads asked per statement; the job pages through all of them. */
const BATCH = 200;

/**
 * Queues one re-check of the team's waived releases, in the caller's transaction (the coverage or membership change
 * commits with it). One job per change: a re-check already running may have read the state before this change.
 */
export async function queueReleaseRecheck(tx: Tx, ids: IdGenerator): Promise<void> {
  const changeId = ids.next<'CommandId'>();
  await enqueueJob(tx, { queue: RELEASE_RECHECK_JOB.queue, kind: RELEASE_RECHECK_JOB.kind, priority: RELEASE_RECHECK_JOB.priority, payload: { changeId }, dedupeKey: RELEASE_RECHECK_JOB.dedupeKey(changeId) });
}

/**
 * The team's leads whose auto-release is waived right now: owned, no first touch, no stored release deadline, and an
 * `sla_waived` of the auto-release in the current ownership period. In id order after `after`, at most `limit`.
 * Index: loe_type_time_idx (tenant_id, type, occurred_at DESC) for the waiver events, then contacts' primary key.
 */
export async function waivedLeads(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT DISTINCT c.id
      FROM lead_ownership_events e
      JOIN contacts c ON c.tenant_id = e.tenant_id AND c.id = e.contact_id
     WHERE e.tenant_id = app.tenant_id() AND e.type = 'sla_waived' AND e.payload->>'waived' = 'auto_release'
       AND c.ownership_state = 'owned' AND c.first_touch_at IS NULL AND c.release_due_at IS NULL
       AND e.seq >= c.ownership_period_seq
       AND (${after}::uuid IS NULL OR c.id > ${after}::uuid)
     ORDER BY c.id
     LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** The `leads.release_recheck` job. */
export function releaseRecheckHandler(): StandaloneJobHandler<ReleaseRecheckPayload> {
  return {
    kind: RELEASE_RECHECK_JOB.kind,
    queue: RELEASE_RECHECK_JOB.queue,
    mode: 'standalone',
    via: 'worker',
    priority: RELEASE_RECHECK_JOB.priority,
    schema: ReleaseRecheckPayload,
    async run(ctx, p) {
      let after: string | null = null;
      let asked = 0;
      let restored = 0;
      for (;;) {
        const cursor: string | null = after;
        const batch: string[] = await ctx.withTx((tx) => waivedLeads(tx, cursor, BATCH));
        for (const contactId of batch) {
          // one transaction per lead, under its contact lock; core decides (a waiver that still holds is a no-op)
          const r = await ctx.withTx((tx) =>
            applyOwnershipCommandInTx(tx, ctx.actor, contactId as ContactId, { kind: 'release_recheck' }, { commandId: derivedCommandId('leads.release_recheck', p.changeId, contactId) }),
          );
          asked++;
          if (r.outcome.ok && r.outcome.events.length > 0) restored++;
        }
        if (batch.length < BATCH) break;
        after = batch[batch.length - 1] as string;
      }
      ctx.log.info('waived releases re-checked', { changeId: p.changeId, asked, restored });
      return undefined;
    },
  };
}
