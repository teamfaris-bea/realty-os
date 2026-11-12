// The inquiries a batch's people sent while their owners were still to come (review D8-R1; owner decision D8, R-OWN-20,
// R-IMPORT-7).
//
// Between a batch's contacts commit and its ownership commit, a person is in the import's creation state and their
// Follow Up Boss owner is mapped and approved but not yet imported. Routing them on a new inquiry then (D8) would hand an
// actively worked person to whoever the rotation picked, and the ownership commit could no longer give them their owner.
// So intake only attaches that inquiry (core reinquiryOutcome / decideReinquiry with `ownersPending`), and this job replays
// it once the owners are in: when the ownership stage commits, when it is skipped, and when a revert finishes (the
// contacts undone, or a partly committed ownership stage undone). For each person of the batch whose ledger is still the
// import's alone and who has an attached inquiry, the latest one goes to the engine as the `reinquiry` it would have
// been, as the system worker: an owner the import gave them hears it (REINQUIRY); one in a pond follows its setting; one
// who still has nobody (B4, no owner in the source, the stage skipped) is routed like E341.
//
// Each person in their own transaction (the routing locks, global lock order step 4, are never held across contacts);
// the command id is derived from the inquiry, so a retry or a second run replays the stored outcome, and a person the
// replay has acted on has a non-import ledger event, so it is not selected again.
import type { ContactId } from '@realty/core/foundation';
import { applyOwnershipCommandInTx, derivedCommandId, enqueueJob, setOwnershipCommand, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import type { ImportDeps } from './types.js';

export const REPLAY_JOB = { kind: 'imports.replay_inquiries' as const, queue: 'bulk' as const };

/** Enqueued in the transaction that ends the wait (the ownership commit's last chunk, a skip, the end of a revert). */
export async function enqueueInquiryReplay(tx: Tx, batchId: string): Promise<void> {
  await enqueueJob(tx, { queue: REPLAY_JOB.queue, kind: REPLAY_JOB.kind, payload: { batchId }, dedupeKey: `${REPLAY_JOB.kind}:${batchId}` });
}

interface WaitingRow {
  contact_id: string;
  inquiry_id: string;
}

/**
 * The batch's people whose ledger is the import's alone (the creation state, or the ownership stage's assignment) and
 * who have an inquiry intake only attached, with their latest one. While the ledger is the import's alone, an attached
 * inquiry is one that waited for the owners (an import-owned or pond person's inquiry is a `reinquiry`, R-OWN-20).
 */
async function waiting(tx: Tx, batchId: string): Promise<WaitingRow[]> {
  const r = await sql<WaitingRow>`
    SELECT DISTINCT ON (c.id) c.id::text AS contact_id, i.id::text AS inquiry_id
      FROM contacts c
      JOIN lead_inquiries i ON i.tenant_id = c.tenant_id AND i.contact_id = c.id AND i.outcome = 'attached'
     WHERE c.tenant_id = app.tenant_id() AND c.import_batch_id = ${batchId}::uuid
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM lead_ownership_events e WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.actor_kind <> 'import')
     ORDER BY c.id, i.received_at DESC, i.id DESC`.execute(tx);
  return r.rows;
}

/** The job (imports.replay_inquiries, system actor 'worker'). Returns how many people the engine acted on. */
export async function replayWaitingInquiries(deps: ImportDeps, tenantId: string, batchId: string): Promise<number> {
  const actor = systemActor(tenantId, 'worker');
  const rows = await withTenantTx(actor, (tx) => waiting(tx, batchId), { db: deps.db });
  let acted = 0;
  for (const row of rows) {
    acted += await withTenantTx(
      actor,
      async (tx) => {
        const r = await applyOwnershipCommandInTx(tx, actor, row.contact_id as ContactId, { kind: 'reinquiry', inquiryId: row.inquiry_id }, {
          commandId: derivedCommandId('import.deferred_reinquiry', row.inquiry_id),
          ids: deps.ids,
        });
        await setOwnershipCommand(tx, null);
        // the owners still to come for this person (a stage committing again after a failed dry run): it waits on
        return r.outcome.ok && !r.replayed && r.outcome.events.length > 0 ? 1 : 0;
      },
      { db: deps.db, retries: 3 },
    );
  }
  return acted;
}
