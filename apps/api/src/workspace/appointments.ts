// Appointments and consult outcomes (BUILD_PLAN module 14; A5 missing_outcome; R-ACC-2).
//
//   GET   /appointments                the caller's (or a visible contact's) appointments          self (RLS)
//   POST  /appointments                schedule (organizer: self; Owner/Admin anyone; TL team)     self (RLS)
//   PATCH /appointments/:id            move / cancel / mark rescheduled                            self (RLS)
//   POST  /appointments/:id/outcome    log how it went (one tap + optional note)                   self (RLS)
//
// Logging an outcome stamps outcome_logged_at/by in the same row (DB CHECK: outcome ⇒ logged), which
// clears the missing_outcome exception condition (api/accountability derives it) and closes the feed's
// "log outcome" card at once. E14: an outcome write needs the appointment to be visible to the caller at
// write time; after a reassignment the previous owner gets NOT_FOUND, never a write on a lead they lost.
import type { IdGenerator, Instant, UserActor } from '@realty/core/foundation';
import { apptOutcomeFeedKey } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { enqueueCalendarPush } from '../calendar/hooks.js';
import { AppError } from '../errors.js';
import { assertAssignable, iso, isoOrNull } from './common.js';
import { closeFeedKey } from './feed.js';
import type { AppointmentSchema, AppointmentsQuery, CreateAppointmentBody, OutcomeBody, UpdateAppointmentBody } from './schemas.js';
import { assertRefsVisible } from './tasks.js';

export type AppointmentView = z.infer<typeof AppointmentSchema>;

interface ApptRow {
  id: string;
  kind: AppointmentView['kind'];
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  status: AppointmentView['status'];
  outcome: AppointmentView['outcome'];
  outcome_note: string | null;
  outcome_logged_at: Date | null;
  user_id: string;
  contact_id: string | null;
  contact_name: string | null;
  deal_id: string | null;
  created_by_kind: AppointmentView['createdByKind'];
  now: Date;
}

const SELECT = sql`
  SELECT a.id, a.kind, a.starts_at, a.ends_at, a.location, a.status, a.outcome, a.outcome_note, a.outcome_logged_at, a.user_id,
         a.contact_id, c.display_name AS contact_name, a.deal_id, a.created_by_kind, clock_timestamp() AS now
    FROM appointments a LEFT JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id`;

function view(r: ApptRow): AppointmentView {
  return {
    id: r.id,
    kind: r.kind,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    location: r.location,
    status: r.status,
    outcome: r.outcome,
    outcomeNote: r.outcome_note,
    outcomeLoggedAt: isoOrNull(r.outcome_logged_at),
    userId: r.user_id,
    contact: r.contact_id && r.contact_name ? { id: r.contact_id, name: r.contact_name } : null,
    dealId: r.deal_id,
    awaitingOutcome: (r.status === 'scheduled' || r.status === 'held') && r.outcome_logged_at === null && r.ends_at <= r.now && r.created_by_kind !== 'import',
    createdByKind: r.created_by_kind,
  };
}

export async function appointmentById(tx: Tx, id: string): Promise<AppointmentView> {
  const r = await sql<ApptRow>`${SELECT} WHERE a.tenant_id = app.tenant_id() AND a.id = ${id}`.execute(tx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND');
  return view(r.rows[0]);
}

export async function listAppointments(tx: Tx, actor: UserActor, q: z.infer<typeof AppointmentsQuery>): Promise<AppointmentView[]> {
  const awaiting = q.awaitingOutcome === 'true';
  const r = await sql<ApptRow>`${SELECT}
     WHERE a.tenant_id = app.tenant_id()
       AND (${q.contactId ?? null}::uuid IS NOT NULL OR a.user_id = ${actor.userId})
       AND (${q.contactId ?? null}::uuid IS NULL OR a.contact_id = ${q.contactId ?? null}::uuid)
       AND (${q.from ?? null}::timestamptz IS NULL OR a.ends_at >= ${q.from ?? null}::timestamptz)
       AND (${q.to ?? null}::timestamptz IS NULL OR a.starts_at < ${q.to ?? null}::timestamptz)
       AND (NOT ${awaiting} OR (a.status IN ('scheduled','held') AND a.outcome_logged_at IS NULL AND a.ends_at <= clock_timestamp()))
     ORDER BY a.starts_at, a.id LIMIT 200`.execute(tx);
  return r.rows.map(view);
}

export async function createAppointment(tx: Tx, actor: UserActor, ids: IdGenerator, b: z.infer<typeof CreateAppointmentBody>): Promise<string> {
  await assertRefsVisible(tx, { contactId: b.contactId ?? null, dealId: b.dealId ?? null });
  const organizer = b.userId ?? actor.userId;
  await assertAssignable(tx, actor, organizer);
  const id = ids.next<'AppointmentId'>();
  await sql`
    INSERT INTO appointments (tenant_id, id, contact_id, deal_id, user_id, set_by_user_id, kind, starts_at, ends_at, location, created_by_kind)
    VALUES (app.tenant_id(), ${id}, ${b.contactId ?? null}, ${b.dealId ?? null}, ${organizer}, ${actor.userId}, ${b.kind}, ${b.startsAt}::timestamptz,
            ${b.endsAt}::timestamptz, ${b.location ?? null}, 'user')`.execute(tx);
  await enqueueCalendarPush(tx, id); // module 34: one-way calendar push (R-CAL-2)
  return id;
}

export async function updateAppointment(tx: Tx, id: string, b: z.infer<typeof UpdateAppointmentBody>): Promise<void> {
  const r = await sql<{ starts_at: Date; ends_at: Date; outcome_logged_at: Date | null }>`
    SELECT starts_at, ends_at, outcome_logged_at FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  const a = r.rows[0];
  if (!a) throw new AppError('NOT_FOUND');
  const starts = b.startsAt ?? a.starts_at.toISOString();
  const ends = b.endsAt ?? a.ends_at.toISOString();
  if (Date.parse(ends) <= Date.parse(starts)) throw new AppError('VALIDATION_FAILED', { reason: 'ENDS_BEFORE_STARTS' });
  await sql`
    UPDATE appointments SET starts_at = ${starts}::timestamptz, ends_at = ${ends}::timestamptz,
           location = CASE WHEN ${b.location !== undefined} THEN ${b.location ?? null} ELSE location END,
           status = COALESCE(${b.status ?? null}, status), updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  await enqueueCalendarPush(tx, id); // module 34: one-way calendar push (R-CAL-2)
}

/** POST /appointments/:id/outcome: one tap. A no-show is an outcome too (logged, so nothing stays missing). */
export async function logOutcome(tx: Tx, actor: UserActor, id: string, b: z.infer<typeof OutcomeBody>, now: Instant): Promise<void> {
  const r = await sql<{ status: string; user_id: string; starts_at: Date }>`
    SELECT status, user_id, starts_at FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  const a = r.rows[0];
  if (!a) throw new AppError('NOT_FOUND');
  if (a.status === 'canceled' || a.status === 'rescheduled') throw new AppError('VALIDATION_FAILED', { reason: 'APPOINTMENT_NOT_HELD', status: a.status });
  if (a.starts_at.getTime() > now) throw new AppError('VALIDATION_FAILED', { reason: 'APPOINTMENT_NOT_STARTED' });
  const noShow = b.result === 'no_show';
  const nowIso = new Date(now).toISOString();
  const u = await sql`
    UPDATE appointments SET status = ${noShow ? 'no_show' : 'held'}, outcome = ${noShow ? null : b.result}, outcome_note = ${b.note ?? null},
           outcome_logged_at = ${nowIso}::timestamptz, outcome_logged_by_user_id = ${actor.userId}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (Number(u.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await closeFeedKey(tx, a.user_id, apptOutcomeFeedKey(id as never), now);
}
