// E142 (R-TXN-5, R-TXN-4): a draft whose trigger runs cite a deal date is stale once that date moved, was completed,
// waived or is gone (core boundVersionStale). module 22's approveAction (assistant/drafts.ts, flagged edit) runs this
// in the approval transaction, in the resume of an approved but never-queued approval, and again in the queue
// transaction, so a move that lands between the tap and the queue still stops the send. A re-review re-tap
// (reviewedInboundSeq) answers R-AST-6's inbound staleness only; it never clears this.
import { boundVersionStale } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import * as R from './repos.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DealDateStale {
  dealDateId: string;
  boundVersion: number;
  currentVersion: number | null;
  reason: 'DATE_MOVED' | 'DATE_NO_LONGER_DRIVES' | 'DATE_GONE';
}

/**
 * The first deal date the action's trigger runs cite that is stale, or null. The action's trigger_ref names its lead
 * run ({kind:'trigger_run', stepRunId}); every run attached to the action is read (a digest covers several), and each
 * run's trigger_ref.ref carries dealDateId and dueVersion. Reads under the caller's RLS: a date the caller can no
 * longer see counts as gone (fail closed).
 */
export async function dealDateStaleness(tx: Tx, actionId: string): Promise<DealDateStale | null> {
  const a = await sql<{ lead: string | null }>`
    SELECT CASE WHEN trigger_ref->>'kind' = 'trigger_run' THEN trigger_ref->>'stepRunId' END AS lead FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  const lead = a.rows[0]?.lead ?? null;
  if (lead === null || !UUID.test(lead)) return null; // not built from a trigger run: nothing cites a deal date
  // the lead run and every run attached to the action (same contact: index playbook_step_runs_trigger_contact)
  const r = await sql<{ date_id: string | null; v: string | null }>`
    SELECT DISTINCT r.trigger_ref->'ref'->>'dealDateId' AS date_id, r.trigger_ref->'ref'->>'dueVersion' AS v
      FROM playbook_step_runs l
      JOIN playbook_step_runs r ON r.tenant_id = l.tenant_id AND r.enrollment_id IS NULL AND r.contact_id = l.contact_id AND (r.id = l.id OR r.assistant_action_id = ${actionId})
     WHERE l.tenant_id = app.tenant_id() AND l.id = ${lead}::uuid AND l.enrollment_id IS NULL AND r.trigger_ref->>'trigger' = 'deal_date_upcoming'`.execute(tx);
  for (const x of r.rows) {
    const bound = Number(x.v);
    if (x.date_id === null || !Number.isInteger(bound)) return { dealDateId: x.date_id ?? '', boundVersion: bound, currentVersion: null, reason: 'DATE_GONE' };
    const row = await R.dateById(tx, x.date_id);
    const cur = row === null ? null : R.coreDate(row);
    if (!boundVersionStale({ dueVersion: bound }, cur)) continue;
    return {
      dealDateId: x.date_id,
      boundVersion: bound,
      currentVersion: cur?.dueVersion ?? null,
      reason: cur === null ? 'DATE_GONE' : cur.dueVersion !== bound ? 'DATE_MOVED' : 'DATE_NO_LONGER_DRIVES',
    };
  }
  return null;
}
