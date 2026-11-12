// milestones.reconcile and milestones.date_changed (PHASE2_3_PLAN §5.4 #31; R-OWN-27, R-TXN-2, R-TXN-4, R-TXN-5, E96).
//
// milestones.reconcile, per tenant every 5 minutes, as the system, bounded per pass and idempotent:
//   (a) repair: a confirmed, uncompleted date with no due_at (a legacy Phase 1 row, or a move whose writer did not
//       recompute) gets core repairInstants' instants, preferring the zone in its basis (R-OWN-27). It never moves a
//       date or its version (the UPDATE is fenced on due_on and due_version; the DB guard allows the system exactly
//       this on an unmoved confirmed date).
//   (b) reminders: a date whose stored reminder_at is due, that still drives updates (core drivesUpdates), on an open
//       deal (stage not closed or lost: the deals 18a's milestoneFacts reads), becomes ONE deal_date_upcoming fact
//       (at = reminder_at, dueAt = due_at) recorded through module 26's recordFactInTx for the deal's contacts, with
//       their deal roles, restricted to the approved team `transaction_updates` playbook (finding 3). The firing key
//       deal_date:{date}:v{due_version}:{step}:{contact} makes a re-confirm or a second pass a no-op. In the same
//       transaction the date's reminder_at is set to NULL, fenced on the due_version read, so each (date, version)
//       reminder is turned into firings once. With no approved playbook nothing is planned and nothing is retried;
//       basis.reminderPass records it for the deal screen.
//   Every contact lock of the pass is taken first, once, in id order (as nurture.anniversary_scan does).
//
// milestones.date_changed {dealDateId}: enqueued by a person's move, completion or waive (their transaction cannot
// write trigger runs). It skips the date's scheduled firings that no longer match (DATE_COMPLETED for a completed
// date, DATE_CHANGED for another version, DATE_UNCONFIRMED for a date that is no longer confirmed) and cancels their
// queued messages (cancelStepMessages). Runs already handed to dispatch are left to dispatch.
import type { ContactId, Instant } from '@realty/core/foundation';
import { repairInstants } from '@realty/core/transactions';
import { type Tx, lockContacts } from '@realty/db';
import { sql } from 'kysely';
import { cancelStepMessages } from '../assistant/repos/playbooks.js';
import { recordFactInTx } from '../nurture/detect.js';
import { approvedTriggerPlaybooks, skipRun } from '../nurture/repos.js';
import type { NurtureDeps } from '../nurture/types.js';
import * as R from './repos.js';
import { reminderFact, staleRuns } from './decide.js';
import { RECONCILE_LIMIT, TRANSACTION_UPDATES } from './types.js';

const iso = (t: number) => new Date(t).toISOString();

export interface ReconcileResult {
  repaired: number;
  reminders: number;
  firings: number;
}

/** (a) Repair: confirmed, uncompleted dates with no stored due_at. */
export async function repairInTx(tx: Tx, now: Instant, limit = RECONCILE_LIMIT): Promise<number> {
  const s = await R.txnSettings(tx);
  const r = await sql<R.DateRow>`
    SELECT ${R.DATE_COLS} FROM deal_dates dd
     WHERE dd.tenant_id = app.tenant_id() AND dd.status = 'confirmed' AND dd.completed_at IS NULL AND dd.due_at IS NULL
     ORDER BY dd.id LIMIT ${limit}`.execute(tx);
  let n = 0;
  for (const row of r.rows) {
    const fix = repairInstants(R.coreDate(row), s.zone, now);
    if (fix === null) continue;
    const u = await sql`
      UPDATE deal_dates SET due_at = ${iso(fix.dueAt)}::timestamptz, reminder_at = ${fix.reminderAt === null ? null : iso(fix.reminderAt)}::timestamptz,
             basis = ${JSON.stringify(fix.basis)}::jsonb, updated_at = now()
       WHERE tenant_id = app.tenant_id() AND id = ${row.id} AND due_on = ${row.due_on}::date AND due_version = ${row.due_version}
         AND status = 'confirmed' AND completed_at IS NULL AND due_at IS NULL`.execute(tx);
    n += Number(u.numAffectedRows ?? 0n);
  }
  return n;
}

interface DueReminder extends R.DateRow {
  stage: string;
}

/** (b) Reminders: due reminder_at on open deals → deal_date_upcoming firings of the approved transaction_updates playbook. */
export async function remindersInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant, limit = RECONCILE_LIMIT): Promise<{ reminders: number; firings: number }> {
  const r = await sql<DueReminder>`
    SELECT ${R.DATE_COLS}, d.stage FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
     WHERE dd.tenant_id = app.tenant_id() AND dd.reminder_at IS NOT NULL AND dd.reminder_at <= ${iso(now)}::timestamptz
       AND d.stage NOT IN ('closed','lost')
     ORDER BY dd.reminder_at, dd.id LIMIT ${limit}`.execute(tx);
  if (r.rows.length === 0) return { reminders: 0, firings: 0 };
  const recipients = await R.dealRecipients(tx, [...new Set(r.rows.map((x) => x.deal_id))]);
  // every contact lock of the pass, once, in id order, before any firing is written (no lock cycle with other paths)
  await lockContacts(tx, r.rows.flatMap((x) => (recipients.get(x.deal_id) ?? []).map((c) => c.contactId as ContactId)));
  const approved = (await approvedTriggerPlaybooks(tx)).some((p) => p.templateKey === TRANSACTION_UPDATES.templateKey && p.ref.scope === TRANSACTION_UPDATES.scope);
  let firings = 0;
  let reminders = 0;
  for (const row of r.rows) {
    const decision = reminderFact({ ...R.coreDate(row), dealId: row.deal_id }, recipients.get(row.deal_id) ?? [], now);
    let planned = 0;
    let reason: string | null = null;
    if (!decision.fire) reason = decision.reason;
    else if (!approved) reason = 'NO_APPROVED_PLAYBOOK';
    else {
      planned = await recordFactInTx(tx, deps, decision.fact, decision.rels, { only: TRANSACTION_UPDATES });
      firings += planned;
    }
    // read once per (date, version): reminder_at cleared, fenced on the version read (the guard allows the system this
    // on an unmoved date); a later confirm or move sets it again and the firing key prevents a duplicate
    const pass = { at: iso(now), dueVersion: row.due_version, planned, reason };
    const u = await sql`
      UPDATE deal_dates SET reminder_at = NULL, basis = basis || jsonb_build_object('reminderPass', ${JSON.stringify(pass)}::jsonb), updated_at = now()
       WHERE tenant_id = app.tenant_id() AND id = ${row.id} AND due_version = ${row.due_version} AND due_on = ${row.due_on}::date
         AND reminder_at IS NOT NULL`.execute(tx);
    reminders += Number(u.numAffectedRows ?? 0n);
  }
  return { reminders, firings };
}

export async function milestonesReconcileInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant, limit = RECONCILE_LIMIT): Promise<ReconcileResult> {
  const repaired = await repairInTx(tx, now, limit);
  const { reminders, firings } = await remindersInTx(tx, deps, now, limit);
  return { repaired, reminders, firings };
}

/** milestones.date_changed: the date's scheduled firings that no longer match are skipped visibly; their queued messages canceled. */
export async function dateChangedInTx(tx: Tx, dealDateId: string): Promise<{ skipped: number; canceled: number }> {
  const date = await R.dateById(tx, dealDateId);
  const find = () =>
    sql<{ id: string; contact_id: string; message_id: string | null; v: string | null }>`
      SELECT r.id, r.contact_id, r.message_id, r.trigger_ref->'ref'->>'dueVersion' AS v FROM playbook_step_runs r
       WHERE r.tenant_id = app.tenant_id() AND r.enrollment_id IS NULL AND r.status = 'scheduled'
         AND r.trigger_ref->>'trigger' = 'deal_date_upcoming' AND r.trigger_ref->'ref'->>'dealDateId' = ${dealDateId}
       ORDER BY r.contact_id, r.id`.execute(tx);
  const first = await find();
  if (first.rows.length === 0) return { skipped: 0, canceled: 0 };
  // the same lock executeTriggerRun takes before it reads a run: a firing is either built already or skipped here
  await lockContacts(tx, first.rows.map((x) => x.contact_id as ContactId));
  const runs = (await find()).rows;
  const stale = staleRuns(date === null ? null : R.coreDate(date), runs.map((x) => ({ ...x, dueVersion: Number(x.v) })));
  if (stale.length === 0) return { skipped: 0, canceled: 0 };
  const completed = stale.some((x) => x.reason === 'DATE_COMPLETED');
  const canceled = await cancelStepMessages(tx, stale.map((x) => x.run.id), completed ? 'deal date completed' : 'deal date changed');
  const cancelledSet = new Set(canceled);
  // a run whose message already left the queue (dispatch owns it now) is not touched here
  const msgStatus = await sql<{ id: string; status: string }>`SELECT id, status FROM messages WHERE tenant_id = app.tenant_id() AND id = ANY (${stale.map((x) => x.run.message_id).filter((x): x is string => x !== null)}::uuid[])`.execute(tx);
  const statusOf = new Map(msgStatus.rows.map((m) => [m.id, m.status]));
  let skipped = 0;
  for (const { run, reason } of stale) {
    if (run.message_id !== null && !cancelledSet.has(run.message_id) && statusOf.get(run.message_id) !== 'canceled') continue;
    await skipRun(tx, run.id, reason);
    skipped += 1;
  }
  return { skipped, canceled: canceled.length };
}
