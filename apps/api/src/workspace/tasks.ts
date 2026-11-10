// Tasks (BUILD_PLAN module 14; A5 promise tasks; R-AST-5).
//
//   GET   /tasks             the caller's tasks (or every visible one: scope=visible)          self (RLS)
//   POST  /tasks             create (assignee: self; Owner/Admin anyone; TL their team)        self (RLS)
//   GET   /tasks/:id         one task, with the evidence of an assistant-made promise          self (RLS)
//   PATCH /tasks/:id         edit / complete / cancel / reassign                                self (RLS)
//
// Visibility is the tasks policy (tenant-wide, assignee, contact detail visible, or deal visible). A task
// about a contact, deal or listing the caller cannot see is refused as NOT_FOUND before the insert, so a
// foreign-key check can never reveal that the row exists (R-PERM-5).
//
// R-AST-5: an assistant-made promise whose date the assistant could not pin (`needs_review`) has no due
// date. Setting one is the agent pinning it: the same update clears needs_review, so a date the agent did
// not choose never becomes a deadline.
import type { Instant, UserActor } from '@realty/core/foundation';
import type { IdGenerator } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { assertAssignable, iso, isoOrNull } from './common.js';
import { taskFeedKey } from '@realty/core/priority';
import { closeFeedKey } from './feed.js';
import { evidenceForClaims } from './repos/evidence.js';
import type { CreateTaskBody, TaskSchema, TasksQuery, UpdateTaskBody } from './schemas.js';

export type TaskView = z.infer<typeof TaskSchema>;

interface TaskRow {
  id: string;
  kind: TaskView['kind'];
  title: string;
  notes: string | null;
  due_at: Date | null;
  due_all_day: boolean;
  due_tz: string | null;
  status: TaskView['status'];
  completed_at: Date | null;
  assignee_user_id: string;
  contact_id: string | null;
  contact_name: string | null;
  deal_id: string | null;
  listing_id: string | null;
  created_by_kind: TaskView['createdByKind'];
  needs_review: boolean;
  source_action_id: string | null;
  source_claim_id: string | null;
  claim_text: string | null;
  created_at: Date;
}

const SELECT = sql`
  SELECT t.id, t.kind, t.title, t.notes, t.due_at, t.due_all_day, t.due_tz, t.status, t.completed_at, t.assignee_user_id, t.contact_id,
         c.display_name AS contact_name, t.deal_id, t.listing_id, t.created_by_kind, t.needs_review, t.source_action_id, t.source_claim_id,
         cl.text AS claim_text, t.created_at
    FROM tasks t
    LEFT JOIN contacts c ON c.tenant_id = t.tenant_id AND c.id = t.contact_id
    LEFT JOIN assistant_claims cl ON cl.tenant_id = t.tenant_id AND cl.id = t.source_claim_id`;

async function views(tx: Tx, actor: UserActor, envelope: EnvelopeService, rows: TaskRow[]): Promise<TaskView[]> {
  const claimIds = rows.map((r) => r.source_claim_id).filter((x): x is string => x !== null);
  const ev = await evidenceForClaims(tx, actor, envelope, claimIds);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    notes: r.notes,
    dueAt: isoOrNull(r.due_at),
    dueAllDay: r.due_all_day,
    dueTz: r.due_tz,
    status: r.status,
    completedAt: isoOrNull(r.completed_at),
    assigneeUserId: r.assignee_user_id,
    // the task may be visible through its assignee while its contact is not: then no name (R-PERM-4)
    contact: r.contact_id && r.contact_name ? { id: r.contact_id, name: r.contact_name } : null,
    dealId: r.deal_id,
    listingId: r.listing_id,
    createdByKind: r.created_by_kind,
    needsReview: r.needs_review && r.status === 'open',
    source: r.created_by_kind === 'assistant' || r.source_claim_id ? { actionId: r.source_action_id, claimText: r.claim_text, evidence: r.source_claim_id ? (ev.get(r.source_claim_id) ?? []) : [] } : null,
    createdAt: iso(r.created_at),
  }));
}

export async function taskById(tx: Tx, actor: UserActor, envelope: EnvelopeService, id: string): Promise<TaskView> {
  const r = await sql<TaskRow>`${SELECT} WHERE t.tenant_id = app.tenant_id() AND t.id = ${id}`.execute(tx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND');
  return (await views(tx, actor, envelope, r.rows))[0]!;
}

export async function listTasks(tx: Tx, actor: UserActor, envelope: EnvelopeService, q: z.infer<typeof TasksQuery>): Promise<TaskView[]> {
  const status = q.status ?? 'open';
  const mine = (q.scope ?? (q.contactId || q.dealId ? 'visible' : 'mine')) === 'mine';
  const r = await sql<TaskRow>`${SELECT}
     WHERE t.tenant_id = app.tenant_id()
       AND (${status} = 'all' OR t.status = ${status})
       AND (NOT ${mine} OR t.assignee_user_id = ${actor.userId})
       AND (${q.contactId ?? null}::uuid IS NULL OR t.contact_id = ${q.contactId ?? null}::uuid)
       AND (${q.dealId ?? null}::uuid IS NULL OR t.deal_id = ${q.dealId ?? null}::uuid)
     ORDER BY (t.status = 'open') DESC, t.due_at NULLS LAST, t.created_at DESC, t.id
     LIMIT ${q.limit ?? 100}`.execute(tx);
  return views(tx, actor, envelope, r.rows);
}

/** The referenced contact (detail), deal and listing must be visible to the caller, else NOT_FOUND. */
export async function assertRefsVisible(tx: Tx, refs: { contactId?: string | null; dealId?: string | null; listingId?: string | null }): Promise<void> {
  const r = await sql<{ c: boolean; d: boolean; l: boolean }>`
    SELECT (${refs.contactId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${refs.contactId ?? null}::uuid
                 AND c.deleted_at IS NULL AND app.contact_detail_visible(c.tenant_id, c.id))) AS c,
           (${refs.dealId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ${refs.dealId ?? null}::uuid)) AS d,
           (${refs.listingId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${refs.listingId ?? null}::uuid)) AS l`.execute(tx);
  const x = r.rows[0]!;
  if (!x.c || !x.d || !x.l) throw new AppError('NOT_FOUND');
}

export async function createTask(tx: Tx, actor: UserActor, ids: IdGenerator, b: z.infer<typeof CreateTaskBody>): Promise<string> {
  await assertRefsVisible(tx, b);
  const assignee = b.assigneeUserId ?? actor.userId;
  await assertAssignable(tx, actor, assignee);
  const id = ids.next<'TaskId'>();
  await sql`
    INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, deal_id, listing_id, kind, title, notes, due_at, due_all_day, due_tz, created_by_kind, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, ${assignee}, ${b.contactId ?? null}, ${b.dealId ?? null}, ${b.listingId ?? null}, ${b.kind ?? 'todo'}, ${b.title},
            ${b.notes ?? null}, ${b.dueAt ?? null}::timestamptz, ${b.dueAllDay ?? false}, ${b.dueTz ?? null}, 'user', ${actor.userId})`.execute(tx);
  return id;
}

export async function updateTask(tx: Tx, actor: UserActor, id: string, b: z.infer<typeof UpdateTaskBody>, now: Instant): Promise<void> {
  const r = await sql<{ status: string; kind: string; needs_review: boolean; due_at: Date | null; due_all_day: boolean; due_tz: string | null; assignee_user_id: string }>`
    SELECT status, kind, needs_review, due_at, due_all_day, due_tz, assignee_user_id FROM tasks WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  const t = r.rows[0];
  if (!t) throw new AppError('NOT_FOUND');
  if (b.assigneeUserId !== undefined && b.assigneeUserId !== t.assignee_user_id) await assertAssignable(tx, actor, b.assigneeUserId);
  const allDay = b.dueAllDay ?? t.due_all_day;
  const dueAt = b.dueAt === undefined ? t.due_at : b.dueAt;
  const dueTz = b.dueTz === undefined ? t.due_tz : b.dueTz;
  if (allDay && (dueAt === null || dueTz === null)) throw new AppError('VALIDATION_FAILED', { reason: 'ALL_DAY_NEEDS_DATE_AND_ZONE' });
  // R-AST-5: the agent setting a promise's date pins it (needs_review clears in the same update)
  const pinned = b.dueAt !== undefined && b.dueAt !== null && t.kind === 'promise' && t.needs_review;
  const status = b.status ?? t.status;
  const nowIso = new Date(now).toISOString();
  await sql`
    UPDATE tasks SET
      title = COALESCE(${b.title ?? null}, title),
      notes = CASE WHEN ${b.notes !== undefined} THEN ${b.notes ?? null} ELSE notes END,
      due_at = ${dueAt === null ? null : new Date(dueAt).toISOString()}::timestamptz,
      due_all_day = ${allDay}, due_tz = ${dueTz},
      needs_review = CASE WHEN ${pinned} THEN false ELSE needs_review END,
      status = ${status},
      completed_at = CASE WHEN ${status} = 'done' THEN COALESCE(completed_at, ${nowIso}::timestamptz) ELSE NULL END,
      completed_by_user_id = CASE WHEN ${status} = 'done' THEN COALESCE(completed_by_user_id, ${actor.userId}::uuid) ELSE NULL END,
      assignee_user_id = COALESCE(${b.assigneeUserId ?? null}::uuid, assignee_user_id),
      updated_at = now()
    WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (status !== 'open') await closeFeedKey(tx, t.assignee_user_id, taskFeedKey(id as never), now);
}
