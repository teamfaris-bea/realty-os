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
import { type DealSide, repairInstants } from '@realty/core/transactions';
import { type Tx, lockContacts } from '@realty/db';
import { sql } from 'kysely';
import { cancelStepMessages } from '../assistant/repos/playbooks.js';
import { recordFactInTx } from '../nurture/detect.js';
import { approvedTriggerPlaybooks, skipRun } from '../nurture/repos.js';
import type { NurtureDeps } from '../nurture/types.js';
import * as R from './repos.js';
import { reminderFact, replanFact, staleRuns } from './decide.js';
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
  side: DealSide;
}

/** (b) Reminders: due reminder_at on open deals → deal_date_upcoming firings of the approved transaction_updates playbook. */
export async function remindersInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant, limit = RECONCILE_LIMIT): Promise<{ reminders: number; firings: number }> {
  const r = await sql<DueReminder>`
    SELECT ${R.DATE_COLS}, d.stage, d.side FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
     WHERE dd.tenant_id = app.tenant_id() AND dd.reminder_at IS NOT NULL AND dd.reminder_at <= ${iso(now)}::timestamptz
       AND d.stage NOT IN ('closed','lost')
     ORDER BY dd.reminder_at, dd.id LIMIT ${limit}`.execute(tx);
  if (r.rows.length === 0) return { reminders: 0, firings: 0 };
  const dealIds = [...new Set(r.rows.map((x) => x.deal_id))];
  const first = await R.dealRecipients(tx, dealIds);
  // every contact lock of the pass, once, in id order, before any firing is written (no lock cycle with other paths)
  await lockContacts(tx, r.rows.flatMap((x) => (first.get(x.deal_id) ?? []).map((c) => c.contactId as ContactId)));
  // ownership-data/F3: re-read under the locks: a merge that committed between the first read and the locks moved the
  // loser's deal role to the survivor, who is a recipient now (recordFactInTx locks each firing's contact itself)
  const recipients = await R.dealRecipients(tx, dealIds);
  const approved = (await approvedTriggerPlaybooks(tx)).some((p) => p.templateKey === TRANSACTION_UPDATES.templateKey && p.ref.scope === TRANSACTION_UPDATES.scope);
  let firings = 0;
  let reminders = 0;
  for (const row of r.rows) {
    const decision = reminderFact({ ...R.coreDate(row), dealId: row.deal_id }, recipients.get(row.deal_id) ?? [], now, row.side);
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

interface MergedReminder extends DueReminder {
  pass_at: string;
  survivor_id: string;
  /** the latest run of this (date, version) on another record of the survivor's person that still counts, if any */
  prior_status: string | null;
  prior_at: Date | null;
}

/**
 * (c) Merges (sends/F5, ownership-data/F3; R-OWN-24, R-TXN-4): a date whose reminder pass already ran for its current
 * version, still driving updates, due in the future, on an open deal, where a deal contact (the survivor) is a live
 * record into which another record of the same person was merged AT OR AFTER that pass, and the survivor has no run
 * of this (date, version) and no note of one yet:
 *   - if another record of the person has a run of this (date, version) that sent, failed, is still scheduled or
 *     deferred, or is a draft still waiting, nothing is sent again: the run is noted on the date
 *     (basis.mergedUpdates["{survivor}:v{n}"] = {status, at}) so the deal screen, read under the TC's own RLS, which
 *     no longer shows the merged-away record, says what happened instead of "nothing planned";
 *   - otherwise (the merge skipped the loser's scheduled run as CONTACT_REMOVED, invalidated its draft, or committed
 *     before the loser's firing was written) the same fact is recorded for the survivor: its current roles, the
 *     deal's side and the approved step decide, as at the pass. The firing key keeps a second pass a no-op.
 */
export async function mergeReplanInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant, limit = RECONCILE_LIMIT): Promise<number> {
  const r = await sql<MergedReminder>`
    SELECT ${R.DATE_COLS}, d.stage, d.side, dd.basis->'reminderPass'->>'at' AS pass_at, c.id AS survivor_id, prior.status AS prior_status, prior.updated_at AS prior_at
      FROM deal_dates dd
      JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
      JOIN deal_contacts dc ON dc.tenant_id = dd.tenant_id AND dc.deal_id = dd.deal_id
      JOIN contacts c ON c.tenant_id = dc.tenant_id AND c.id = dc.contact_id AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
      LEFT JOIN LATERAL (
        SELECT CASE WHEN pr.status = 'sent' OR m.status IS NOT NULL THEN 'sent' ELSE pr.status END AS status, pr.updated_at
          FROM playbook_step_runs pr
          -- a message of the run that left for the provider (or arrived) counts as sent whatever the run says: the
          -- merge skips a run whose message is mid-dispatch, and a dispatch_unknown run is never written back
          LEFT JOIN LATERAL (SELECT mm.status FROM messages mm WHERE mm.tenant_id = pr.tenant_id AND mm.playbook_step_run_id = pr.id
                               AND mm.status IN ('dispatching','dispatch_unknown','sent','delivered') LIMIT 1) m ON true
         WHERE pr.tenant_id = dd.tenant_id AND pr.enrollment_id IS NULL AND pr.contact_id <> c.id
           AND pr.contact_id = ANY (app.contact_person_ids(c.tenant_id, c.id))
           AND pr.trigger_ref->>'trigger' = 'deal_date_upcoming' AND pr.trigger_ref->'ref'->>'dealDateId' = dd.id::text
           AND pr.trigger_ref->'ref'->>'dueVersion' = dd.due_version::text
           -- a scheduled or deferred run of a merged-away record never sends (CONTACT_REMOVED, now or in the merge's
           -- follow-up job), so it does not count; a draft counts only while it still waits for review
           AND (pr.status IN ('sent','failed') OR m.status IS NOT NULL
                OR (pr.status = 'converted_to_draft'
                    AND NOT EXISTS (SELECT 1 FROM assistant_actions aa WHERE aa.tenant_id = pr.tenant_id AND aa.id = pr.assistant_action_id AND aa.status = 'invalidated')))
         ORDER BY (pr.status = 'sent' OR m.status IS NOT NULL) DESC, pr.updated_at DESC, pr.id LIMIT 1) prior ON true
     WHERE dd.tenant_id = app.tenant_id() AND dd.status = 'confirmed' AND dd.completed_at IS NULL AND dd.reminder_at IS NULL
       AND dd.due_at > ${iso(now)}::timestamptz AND d.stage NOT IN ('closed','lost')
       AND dd.basis ? 'reminderPass' AND dd.basis->'reminderPass'->>'reason' IS NULL
       AND (dd.basis->'reminderPass'->>'dueVersion')::int = dd.due_version
       AND NOT (COALESCE(dd.basis->'mergedUpdates', '{}'::jsonb) ? (c.id::text || ':v' || dd.due_version::text))
       AND EXISTS (SELECT 1 FROM lead_ownership_events e
                    WHERE e.tenant_id = c.tenant_id AND e.type = 'merged_away' AND e.contact_id <> c.id
                      AND e.contact_id = ANY (app.contact_person_ids(c.tenant_id, c.id))
                      AND e.occurred_at >= (dd.basis->'reminderPass'->>'at')::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM playbook_step_runs own
                        WHERE own.tenant_id = dd.tenant_id AND own.enrollment_id IS NULL AND own.contact_id = c.id
                          AND own.trigger_ref->>'trigger' = 'deal_date_upcoming' AND own.trigger_ref->'ref'->>'dealDateId' = dd.id::text
                          AND own.trigger_ref->'ref'->>'dueVersion' = dd.due_version::text)
     ORDER BY dd.id, c.id LIMIT ${limit}`.execute(tx);
  if (r.rows.length === 0) return 0;
  await lockContacts(tx, r.rows.map((x) => x.survivor_id as ContactId));
  const recipients = await R.dealRecipients(tx, [...new Set(r.rows.map((x) => x.deal_id))]);
  const approved = (await approvedTriggerPlaybooks(tx)).some((p) => p.templateKey === TRANSACTION_UPDATES.templateKey && p.ref.scope === TRANSACTION_UPDATES.scope);
  const noteRun = async (row: MergedReminder, status: string, at: Date | null) => {
    const note = { [`${row.survivor_id}:v${row.due_version}`]: { status, at: at === null ? null : at.toISOString() } };
    await sql`
      UPDATE deal_dates SET basis = basis || jsonb_build_object('mergedUpdates', COALESCE(basis->'mergedUpdates', '{}'::jsonb) || ${JSON.stringify(note)}::jsonb), updated_at = now()
       WHERE tenant_id = app.tenant_id() AND id = ${row.id} AND due_version = ${row.due_version} AND due_on = ${row.due_on}::date`.execute(tx);
  };
  let firings = 0;
  for (const row of r.rows) {
    if (row.prior_status !== null) {
      await noteRun(row, row.prior_status, row.prior_at);
      continue;
    }
    const at = Date.parse(row.pass_at);
    const mine = (recipients.get(row.deal_id) ?? []).filter((c) => c.contactId === row.survivor_id);
    const decision = approved && Number.isFinite(at) ? replanFact({ ...R.coreDate(row), dealId: row.deal_id }, mine, row.side, at as Instant) : null;
    const planned = decision !== null && decision.fire ? await recordFactInTx(tx, deps, decision.fact, decision.rels, { only: TRANSACTION_UPDATES }) : 0;
    firings += planned;
    // nothing to plan (no approved playbook, a role the step or the side rules out, no owner): a terminal note, so the
    // row is never selected again and cannot crowd later re-plans out of the bounded pass (the deal screen gives the
    // current reason, as for any recipient)
    if (planned === 0) await noteRun(row, 'not_planned', null);
  }
  return firings;
}

export async function milestonesReconcileInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant, limit = RECONCILE_LIMIT): Promise<ReconcileResult> {
  const repaired = await repairInTx(tx, now, limit);
  const { reminders, firings } = await remindersInTx(tx, deps, now, limit);
  const replanned = await mergeReplanInTx(tx, deps, now, limit);
  return { repaired, reminders, firings: firings + replanned };
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
