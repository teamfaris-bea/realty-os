// The one deal-date writer (PHASE2_3_PLAN §5.4 #31; R-TXN-1, R-TXN-2, R-TXN-5, R-OWN-27, E96, E143).
//
// Every confirm, entry and move of a date (POST /deal-dates/:id/confirm, and the Phase 1 POST /deals/:id/dates and
// PATCH /deal-dates/:id through workspace/deals.ts) goes through confirmInTx:
//   1. core confirmDate with tenant_settings.default_timezone (recorded in basis): due_at = local end of the due
//      day, reminder_at = N local days before at 09:00, due_version bumped on a move;
//   2. ONE INSERT or UPDATE writes status confirmed, confirmed_by_user_id (the person, as themselves),
//      confirmed_at, due_at, reminder_at, due_version and basis together, so the DB guard deal_dates_confirm_guard
//      and the CHECKs deal_dates_confirmed_by_human / deal_dates_reminder_confirmed agree with what we wrote;
//   3. a move, a completion or a waive enqueues one system job (milestones.date_changed): a person's transaction
//      cannot write trigger runs (policy step_runs_trigger WITH CHECK is_tenant_wide), so the job skips the date's
//      stale firings with a visible reason and cancels their queued messages (finding 6).
// A label edit keeps the version; completion is completed_at alone (the guard clears reminder_at). The system
// never confirms, enters or moves a date (core refuses with DATE_HUMAN_CONFIRMATION; the DB guard agrees).
import type { Actor, IdGenerator, Instant, LocalDate } from '@realty/core/foundation';
import { type MilestoneKind, type ProposalBasis, type Responsible, confirmDate, proposalBasisOf } from '@realty/core/transactions';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { AppError, type ErrorCode } from '../errors.js';
import * as R from './repos.js';
import { TRANSACTION_JOBS } from './types.js';

const iso = (t: Instant | null) => (t === null ? null : new Date(t).toISOString());

/** Keys a basis carries that are not part of the proposal: the reconcile's note about the last reminder pass. */
function cleanBasis(b: ProposalBasis): ProposalBasis {
  const { reminderPass: _p, ...rest } = b as ProposalBasis & { reminderPass?: unknown };
  return rest as ProposalBasis;
}

/** The reminder a confirm uses when the caller does not say: the rule the person saw on the proposal, else the last one. */
export function storedReminderDays(basis: Record<string, unknown>): number | null {
  const rule = basis['reminderRule'] as { daysBefore?: unknown } | null | undefined;
  if (rule && typeof rule.daysBefore === 'number') return rule.daysBefore;
  const proposed = basis['reminderDaysBefore'];
  return typeof proposed === 'number' ? proposed : null;
}

export interface ConfirmArgs {
  dealId: string;
  /** null: a new date (entered on the deal screen: source manual) */
  dateId: string | null;
  kind?: MilestoneKind;
  label?: string | null;
  /** absent: keep the stored date */
  dueOn?: LocalDate | string;
  /** absent: keep; null: nobody named */
  responsible?: Responsible | null;
  /** absent: the proposal's rule (basis.reminderDaysBefore) or the last confirm's */
  reminderDaysBefore?: number | null;
}

export async function enqueueDateChanged(tx: Tx, dealDateId: string): Promise<void> {
  // a pending job reads the date as it stands when it runs, so one live job per date covers every change
  await enqueueJob(tx, { queue: 'default', kind: TRANSACTION_JOBS.dateChanged, payload: { dealDateId }, dedupeKey: `${TRANSACTION_JOBS.dateChanged}:${dealDateId}` });
}

function fail(code: string): never {
  throw new AppError(code as ErrorCode);
}

/** Confirms, enters or moves a date as `actor` (a person). Returns the date id. */
export async function confirmInTx(tx: Tx, actor: Actor, ids: IdGenerator, a: ConfirmArgs, now: Instant): Promise<string> {
  const s = await R.txnSettings(tx);
  const prev = a.dateId === null ? null : await R.dateById(tx, a.dateId, { lock: true });
  if (a.dateId !== null && (prev === null || prev.deal_id !== a.dealId)) throw new AppError('NOT_FOUND');
  const dueOn = (a.dueOn ?? prev?.due_on) as LocalDate | undefined;
  if (dueOn === undefined) throw new AppError('VALIDATION_FAILED', { reason: 'DUE_ON_REQUIRED' });
  const reminderDaysBefore = a.reminderDaysBefore !== undefined ? a.reminderDaysBefore : prev === null ? null : storedReminderDays(prev.basis);
  const source = prev?.source ?? 'manual';
  const basis = cleanBasis(prev === null ? { kind: 'manual' } : proposalBasisOf(R.coreDate(prev).basis));
  // R-TXN-1: only a person confirms, enters or moves a date (core and the DB guard refuse anyone else too)
  if (actor.kind !== 'user') fail('DATE_HUMAN_CONFIRMATION');
  const dateActor = { kind: 'user', userId: actor.userId } as const;
  let res: ReturnType<typeof confirmDate>;
  try {
    res = confirmDate(prev === null ? null : R.coreDate(prev), { actor: dateActor, dueOn: dueOn as LocalDate, source, reminderDaysBefore, basis, now }, s.zone);
  } catch {
    throw new AppError('VALIDATION_FAILED', { reason: 'INVALID_DATE' });
  }
  if (!res.ok) fail(res.code);
  const v = res;
  const responsible = a.responsible !== undefined ? a.responsible : (prev?.responsible ?? null);
  const nowIso = new Date(now).toISOString();
  if (prev === null) {
    const id = ids.next<'DealDateId'>();
    await sql`
      INSERT INTO deal_dates (tenant_id, id, deal_id, kind, label, due_on, source, status, confirmed_by_user_id, confirmed_at, responsible,
                              due_at, reminder_at, due_version, basis)
      VALUES (app.tenant_id(), ${id}, ${a.dealId}, ${a.kind ?? 'custom'}, ${a.label ?? null}, ${dueOn}::date, 'manual', 'confirmed', ${actor.userId},
              ${nowIso}::timestamptz, ${responsible}, ${iso(v.dueAt)}::timestamptz, ${iso(v.reminderAt)}::timestamptz, ${v.dueVersion}, ${JSON.stringify(v.basis)}::jsonb)`.execute(tx);
    return id;
  }
  const moved = prev.status === 'confirmed' && prev.due_on !== dueOn;
  await sql`
    UPDATE deal_dates SET due_on = ${dueOn}::date, status = 'confirmed', confirmed_by_user_id = ${actor.userId}, confirmed_at = ${nowIso}::timestamptz,
           responsible = ${responsible}, label = CASE WHEN ${a.label !== undefined} THEN ${a.label ?? null} ELSE label END,
           due_at = ${iso(v.dueAt)}::timestamptz, reminder_at = ${iso(v.reminderAt)}::timestamptz, due_version = ${v.dueVersion},
           basis = ${JSON.stringify(v.basis)}::jsonb, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${prev.id}`.execute(tx);
  if (moved) await enqueueDateChanged(tx, prev.id);
  return prev.id;
}

/** Phase 1 PATCH /deal-dates/:id: a move goes through confirmInTx; a label edit keeps the version; completion is completed_at alone. */
export async function updateDateInTx(
  tx: Tx,
  actor: Actor,
  ids: IdGenerator,
  dateId: string,
  b: { dueOn?: string | undefined; label?: string | null | undefined; completed?: boolean | undefined },
  now: Instant,
): Promise<void> {
  const cur = await R.dateById(tx, dateId, { lock: true });
  if (!cur) throw new AppError('NOT_FOUND');
  if (b.dueOn !== undefined && b.dueOn !== cur.due_on) {
    // a date the person types is a person's fact: entering it confirms it as them (R-TXN-1)
    if (cur.completed_at !== null && b.completed !== false) fail('DATE_COMPLETED');
    if (b.completed === false) await sql`UPDATE deal_dates SET completed_at = NULL, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${dateId}`.execute(tx);
    await confirmInTx(tx, actor, ids, { dealId: cur.deal_id, dateId, dueOn: b.dueOn, ...(b.label !== undefined ? { label: b.label } : {}) }, now);
  } else if (b.label !== undefined) {
    await sql`UPDATE deal_dates SET label = ${b.label}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${dateId}`.execute(tx);
  }
  if (b.completed !== undefined && !(b.completed === false && b.dueOn !== undefined && b.dueOn !== cur.due_on)) {
    const wasDone = cur.completed_at !== null;
    await sql`
      UPDATE deal_dates SET completed_at = CASE WHEN ${b.completed} THEN COALESCE(completed_at, ${new Date(now).toISOString()}::timestamptz) ELSE NULL END, updated_at = now()
       WHERE tenant_id = app.tenant_id() AND id = ${dateId}`.execute(tx);
    if (b.completed && !wasDone) await enqueueDateChanged(tx, dateId);
  }
}
