// The minute-three backup alert (b19 team-queue lane, step 2; owner decisions 1 and 2 of 2026-11-19; DATA_MODEL
// R-TEAMQ-14 to R-TEAMQ-17, E946 to E956).
//
//   job `leads.backup_alert` { inquiryId }   queue realtime, as the system actor (via timer), one transaction
//
// QUEUED at intake (leads/intake.ts), in the intake's own transaction, for every inbound inquiry that is an arrival
// (new_contact, attached, reinquiry; never an ignored duplicate) of a source whose coverage switch is on. Due three
// minutes of STAFFED time after the arrival (core backupAlertDueAt: an off-hours arrival counts from opening).
//
// WHEN IT RUNS it decides once per inquiry and writes ONE lead_backup_alerts row saying what it decided and why:
//   lead_closed          the person was closed, deleted or merged away since
//   source_not_covered   the source's coverage was switched off in between
//   human_attempt        a person has called, texted, emailed or replied in chat since the arrival: exactly the team
//                        work queue's predicate (step 1). An automated reply never counts, and neither does a send
//                        the provider has already reported as failed (R-TEAMQ-27: the alert then says it was tried).
//   answered_call        a person answered the lead's own call since the arrival, or the call that is the inquiry
//                        itself (R-TEAMQ-22: matched by the inquiry's own reference)
//   alerted              otherwise someone OTHER than the person holding the lead is alerted (core
//                        backupAlertRecipients; owner decision 2; R-TEAMQ-21, review fix M2), by the existing
//                        critical notification path (in-app, push, and a text to the member's verified alert phone):
//                          the source's named backup, when an active member and not the person holding the lead;
//                          else the team lead of whoever has the lead (recorded as team_lead, with why: the backup is
//                          unavailable, or the backup IS the holder);
//                          else the team's Owners and Admins (recorded as admins, with their number): a lead in a
//                          pond or unassigned, or a holder on no team, has no team lead to tell
//   no_recipient         the team has nobody but the person holding the lead
//
// A run that loses the claim on the inquiry to a concurrent run commits nothing (repos claimAlert: a savepoint).
// A LOST job (its row gone) is re-issued by the periodic `leads.backup_alert_sweep` below (R-TEAMQ-28).
//
// WHAT IT NEVER DOES: it never changes the owner, the offer or the pond (no ownership command is issued here), never
// sends, drafts or queues anything for the client (it does not import the send path at all), never decides twice for
// one inquiry (lead_backup_alerts_inquiry_once), and does nothing for a source that is not covered when it runs.
//
// ACCESS: a backup is usually neither the owner nor a collaborator, so the alert would name a lead they cannot open.
// The alerted backup therefore gets a `backup` collaborator row on that one lead, for 24 hours (core
// BACKUP_GRANT_MS) or until the owner's own human attempt ends it (core decide.ts, endBackupAccess). It is the
// existing collaborator mechanism: that one person, that one lead, nothing once it has expired, audited. It works on
// a lead still on offer, in a pond or unassigned too (a collaborator row does not need an owner); there, a call or a
// text by the backup is made and stored under the backup's own id, and no first touch is written to the ownership
// ledger, because a first touch belongs to an ownership period and nobody owns the lead yet. A team lead, an Owner or
// an Admin alerted in the backup's place gets no grant: they already reach the leads they are told about.
import type { IdGenerator, Instant, SystemActor } from '@realty/core/foundation';
import { businessMsBetween, instantFromDate } from '@realty/core/foundation';
import { coverageNow } from '@realty/core/ownership';
import { type AlertHolder, BACKUP_GRANT_MS, backupAlertDueAt, backupAlertRecipients, backupAlertText } from '@realty/core/priority';
import { type Tx, defaultIds, enqueueJob, loadTenantFacts } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import { contactLabel, notifyUser } from '../comms/repos/notify.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { TxJobHandler } from '../worker/types.js';
import { backupAlertNotice } from './backupAlertNotice.js';
import * as repo from './repos/backupAlert.js';

export const BACKUP_ALERT_JOB = {
  kind: 'leads.backup_alert' as const,
  queue: 'realtime' as const,
  priority: 15,
  dedupeKey: (inquiryId: string) => `leads.backup_alert:${inquiryId}`,
};
export const BackupAlertPayload = jobPayload({ inquiryId: zId });
export type BackupAlertPayload = { inquiryId: string };

/** notifications.dedupe_key of an inquiry's backup alert (one per inquiry and member). */
export const backupAlertNoteKey = (inquiryId: string) => `backup_alert:${inquiryId}`;

/**
 * Queues the one job of an inquiry, in the caller's (intake) transaction. `receivedAt` is the time the source claims,
 * `reachedAt` the moment the lead reached the team: their one arrival instant (core arrivalInstant, R-TEAMQ-19)
 * starts the three staffed minutes.
 */
export async function queueBackupAlert(tx: Tx, a: { inquiryId: string; receivedAt: Instant; reachedAt: Instant }): Promise<void> {
  const facts = await loadTenantFacts(tx);
  const runAt = backupAlertDueAt(a.receivedAt, a.reachedAt, facts.calendar);
  await enqueueJob(tx, { queue: BACKUP_ALERT_JOB.queue, kind: BACKUP_ALERT_JOB.kind, priority: BACKUP_ALERT_JOB.priority, payload: { inquiryId: a.inquiryId }, dedupeKey: BACKUP_ALERT_JOB.dedupeKey(a.inquiryId), runAt });
}

export type BackupAlertOutcome = repo.AlertInsert['outcome'];
export type BackupAlertResult =
  | { outcome: BackupAlertOutcome; alertedUserId: string | null }
  /** the inquiry does not exist for this tenant (or is an ignored duplicate): nothing is written */
  | { outcome: 'no_inquiry' }
  /** an earlier run decided this inquiry: nothing is written */
  | { outcome: 'already_decided' }
  /** woken before three staffed minutes have passed (the staffed hours changed, a job run by hand): nothing is written */
  | { outcome: 'not_due'; dueAt: Instant };

/** The minute-three decision of one inquiry, in `tx` as the system actor of its tenant. Idempotent on the inquiry. */
export async function decideBackupAlert(tx: Tx, ids: IdGenerator, inquiryId: string, now: Instant, actor: SystemActor): Promise<BackupAlertResult> {
  const q = await repo.inquiryForAlert(tx, inquiryId);
  if (!q || q.outcome === 'duplicate_ignored') return { outcome: 'no_inquiry' };
  if (await repo.alreadyDecided(tx, inquiryId)) return { outcome: 'already_decided' };
  const { calendar } = await loadTenantFacts(tx);
  // R-TEAMQ-19: ONE arrival instant: the due time, "an attempt since", the wait in the alert and the row all read it
  const arrivedAt = instantFromDate(q.arrived_at);
  const dueAt = backupAlertDueAt(instantFromDate(q.received_at), instantFromDate(q.created_at), calendar);
  if (now < dueAt) return { outcome: 'not_due', dueAt };

  const person = await repo.personNow(tx, q.contact_id);
  const live = person !== null && !person.deleted && person.ownership_state !== 'closed';
  const holder: repo.AlertInsert['holder'] = !live ? null : person.ownership_state === 'owned' ? 'owner' : person.ownership_state === 'offered' ? 'on_offer' : person.ownership_state === 'in_pond' ? 'pond' : 'unassigned';
  const holderUserId = holder === 'owner' ? person!.owner_user_id : holder === 'on_offer' ? person!.offered_to_user_id : null;
  const row = (outcome: BackupAlertOutcome, o: Partial<repo.AlertInsert> = {}): repo.AlertInsert => ({
    id: ids.next<'BackupAlertId'>(),
    inquiryId,
    leadSourceId: q.lead_source_id,
    arrivedAt: q.arrived_at,
    dueAt: new Date(dueAt),
    decidedAt: new Date(now),
    outcome,
    alertedUserId: null,
    recipient: null,
    fallbackReason: null,
    alertedCount: 0,
    holder,
    holderUserId,
    holderPondId: holder === 'pond' ? person!.pond_id : null,
    grantExpiresAt: null,
    ...o,
  });
  const record = async (outcome: Exclude<BackupAlertOutcome, 'alerted'>): Promise<BackupAlertResult> => ((await repo.insertAlert(tx, row(outcome))) ? { outcome, alertedUserId: null } : { outcome: 'already_decided' });

  if (!live) return record('lead_closed');
  // R-TEAMQ-24: the ONE definition of covered now (core coverageNow), which the card and the auto-release read too.
  // The switch was turned off in between: nothing happens (R-TEAMQ-14). While it is on the alert ALWAYS tells someone:
  // the backup when they are active, else the fallback, also when the source's own owner is unavailable (the card
  // says so in words); the auto-release is what resumes for a source that is not covered now.
  const coverage = coverageNow({ setting: q.covered && q.backup_user_id !== null, ownerStatus: q.owner_status, backupStatus: q.backup_status });
  if (coverage.alert === 'off') return record('source_not_covered');
  if (await repo.humanAttemptSince(tx, person.id, q.arrived_at)) return record('human_attempt');
  if (await repo.answeredCallSince(tx, person.id, inquiryId)) return record('answered_call');

  // owner decision 2 and R-TEAMQ-21: the named backup; when absent, suspended or the person HOLDING the lead, the
  // team lead of whoever has it; with no team lead to tell, the team's Owners and Admins. Never the holder themself.
  const to = backupAlertRecipients({
    backupUserId: q.backup_user_id,
    backupActive: coverage.alert === 'backup',
    holderUserId,
    holderTeamLeads: holderUserId === null ? [] : (await repo.teamLeadsOf(tx, holderUserId)).map((l) => l.user_id),
    admins: await repo.ownersAndAdmins(tx),
  });
  if (to === null) return record('no_recipient');
  const first = to.userIds[0] as string;

  // The row is the claim on this inquiry, written together with the backup's grant (R-TEAMQ-17, review fix L2): a
  // concurrent run that loses the claim stops here having committed nothing: no grant, no audit row, no notification.
  const grantUntil = to.recipient === 'backup' ? new Date(now + BACKUP_GRANT_MS) : null;
  const claim = await repo.claimAlert(
    tx,
    row('alerted', { alertedUserId: first, recipient: to.recipient, fallbackReason: to.why, alertedCount: to.userIds.length }),
    grantUntil === null ? null : { contactId: person.id, userId: first, expiresAt: grantUntil },
  );
  if (!claim.won) return { outcome: 'already_decided' };
  const granted = claim.granted;
  if (granted !== null) {
    await audit(tx, actor, {
      action: 'collaborator.added',
      entity: { type: 'contact', id: person.id },
      changes: redactSnapshot({ collaborator_user_id: first, role: 'backup', expires_at: granted.toISOString() }, { entity: 'contact_collaborator' }),
      reason: 'BACKUP_ALERT',
    });
  }
  const failedAttempt = await repo.failedAttemptSince(tx, person.id, q.arrived_at);
  const alertHolder: AlertHolder =
    holder === 'owner' ? { kind: 'owner', name: person.owner_name } : holder === 'on_offer' ? { kind: 'on_offer', name: person.offered_to_name } : holder === 'pond' ? { kind: 'pond', name: person.pond_name } : { kind: 'unassigned' };
  const text = backupAlertText({
    person: await contactLabel(tx, person.id),
    sourceName: q.source_name,
    waitedSeconds: Math.max(0, Math.floor((now - arrivedAt) / 1000)),
    staffedSeconds: Math.floor(businessMsBetween(arrivedAt, now, calendar) / 1000),
    holder: alertHolder,
    recipient: to.recipient,
    ...(to.why === null ? {} : { why: to.why }),
    // R-TEAMQ-27: a send a person made that the provider reported as failed is said, not hidden
    ...(failedAttempt === null ? {} : { failedAttempt }),
  });
  // a member's notification, never a message to the client: in-app, push, and (critical) a text to their alert phone.
  // R-PUSH-10: the stored (in-app) title keeps R-TEAMQ-15's detail; the generic push title and alert text are
  // notice.pushTitle / notice.smsText, for the push and text seams (not wired yet: they still read the stored title).
  const notice = backupAlertNotice(text);
  for (const userId of to.userIds) {
    await notifyUser(tx, ids, { userId, kind: 'first_touch_due', priority: 'critical', title: notice.inAppTitle, body: notice.body, subjectType: 'contact', subjectId: person.id, dedupeKey: backupAlertNoteKey(inquiryId) }, now);
  }
  return { outcome: 'alerted', alertedUserId: first };
}

// ---- the sweep for a lost job (R-TEAMQ-28, review fix L7) ----------------------------------------------------------

export const BACKUP_ALERT_SWEEP_JOB = { kind: 'leads.backup_alert_sweep' as const, queue: 'default' as const, everyMs: 5 * 60_000 };
/** How far back the sweep looks: an inquiry still undecided after two days is no longer a "minute-three" matter. */
export const BACKUP_ALERT_SWEEP_WINDOW_MS = 2 * 24 * 60 * 60_000;
/** A job this late is taken to be lost (the worker runs a due job within seconds). */
export const BACKUP_ALERT_SWEEP_GRACE_MS = 60_000;
const SWEEP_PER_SOURCE = 500;

/**
 * Re-issues the minute-three job of every inquiry of a covered source whose job should have run and left no decision
 * row: the job row was lost (a purge, a failed deploy, a dead job). The one job of an inquiry is keyed on the inquiry
 * (BACKUP_ALERT_JOB.dedupeKey), so an inquiry whose job is still alive gets no second one, and a re-issued job that
 * finds a row decides nothing twice. It alerts nobody itself. Idempotent.
 */
export async function sweepLostBackupAlerts(tx: Tx, now: Instant): Promise<{ undecided: number; reissued: number }> {
  const rows = await repo.undecidedInquiries(tx, new Date(now - BACKUP_ALERT_SWEEP_WINDOW_MS), new Date(now), SWEEP_PER_SOURCE);
  if (rows.length === 0) return { undecided: 0, reissued: 0 };
  const { calendar } = await loadTenantFacts(tx);
  let reissued = 0;
  for (const q of rows) {
    const dueAt = backupAlertDueAt(instantFromDate(q.received_at), instantFromDate(q.created_at), calendar);
    if (now < dueAt + BACKUP_ALERT_SWEEP_GRACE_MS) continue; // not due yet, or due just now: its own job has it
    const queued = await enqueueJob(tx, { queue: BACKUP_ALERT_JOB.queue, kind: BACKUP_ALERT_JOB.kind, priority: BACKUP_ALERT_JOB.priority, payload: { inquiryId: q.id }, dedupeKey: BACKUP_ALERT_JOB.dedupeKey(q.id), runAt: now });
    if (queued) reissued++;
  }
  return { undecided: rows.length, reissued };
}

/** The periodic `leads.backup_alert_sweep` job: one per team, every five minutes (worker maintenance keeps it alive). */
export function backupAlertSweepHandler(): TxJobHandler<Record<string, never>> {
  return {
    kind: BACKUP_ALERT_SWEEP_JOB.kind,
    queue: BACKUP_ALERT_SWEEP_JOB.queue,
    via: 'worker',
    schema: jobPayload({}),
    every: { ms: BACKUP_ALERT_SWEEP_JOB.everyMs, offsetMs: 70_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await sweepLostBackupAlerts(ctx.tx, ctx.now);
      if (r.reissued > 0) ctx.log.info('backup alert jobs re-issued', { reissued: r.reissued, undecided: r.undecided });
      return undefined;
    },
  };
}

/** The `leads.backup_alert` job. An early wake goes back to sleep until the inquiry's stored due time. */
export function backupAlertHandler(): TxJobHandler<BackupAlertPayload> {
  const ids = defaultIds();
  return {
    kind: BACKUP_ALERT_JOB.kind,
    queue: BACKUP_ALERT_JOB.queue,
    via: 'timer',
    priority: BACKUP_ALERT_JOB.priority,
    schema: BackupAlertPayload,
    async run(ctx, p) {
      const r = await decideBackupAlert(ctx.tx, ids, p.inquiryId, ctx.now, ctx.actor);
      if (r.outcome === 'not_due') return { retryAt: r.dueAt };
      ctx.log.info('backup alert decided', { inquiryId: p.inquiryId, outcome: r.outcome });
      return undefined;
    },
  };
}
