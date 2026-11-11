// Notes, mentions and logged outside activity (PARITY_PLAN module 57; R-PAR-1…5, R-PAR-30…32, E162…E164,
// E192, E193).
//
//   GET    /contacts/:id/notes                 pinned first, newest first          contact.view_detail
//   POST   /contacts/:id/notes                 body with @mention tokens            note.write
//   GET    /contacts/:id/mention-candidates    members, and whether each sees the person   note.write
//   PATCH  /notes/:id                          author only (body; a logged time/direction/outcome)  note.write
//   POST   /notes/:id/pin                      author, or Owner/Admin              note.write
//   DELETE /notes/:id                          author (manual/logged), or Owner/Admin (audited)  note.delete
//   POST   /contacts/:id/activities            log an outside call/text/email (+ "remind me" task)  activity.log
//
// Mentions (R-PAR-2/3): each mentioned active member is checked AS THAT MEMBER, in a read-only transaction
// in their own RLS context (no definer re-implements visibility for another user). Only those who see the
// person get a notification, written in the author's transaction, with no note text: the title holds at most
// the person's first name and initial, deduped per note per user. Those who cannot see the person are named
// back to the author as `no_access` (the UI offers Share, which is the audited collaborator add). A mention
// never grants access. A logged activity is never a messages/calls row and never a touch (R-PAR-5, R-PAR-32).
import { type Actor, type UserActor, instantFromDate, instantFromIso, toIso } from '@realty/core/foundation';
import { DAY_MS, plusMs } from '@realty/core/foundation';
import { addedMentions, followUpTitle, mentionTokens, mentionDedupeKey, mentionTitle, parseMentions, suggestsDoNotContact, validateLoggedActivity } from '@realty/core/parity/people';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { factsOf } from '../leads/contacts.js';
import * as leads from '../leads/repos/contacts.js';
import { authorize } from '../rbac.js';
import { createTask } from '../workspace/tasks.js';
import { decodeCursor, detailFacts, liveDetailFacts, encodeCursor, peopleTx, platformOf } from './common.js';
import * as repo from './repos/people.js';
import * as S from './schemas.js';
import { noteView } from './views.js';

const contactAuth = (req: FastifyRequest) => detailFacts(req);
const writeAuth = (req: FastifyRequest) => liveDetailFacts(req);

/** Facts for a note route: the note's person (detail visible) + `own` = the caller wrote the note. */
function noteFacts(req: FastifyRequest, ownMeansAuthor: boolean) {
  return peopleTx(req, async (tx, _now, actor) => {
    const n = await repo.note(tx, (req.params as { id: string }).id);
    if (!n || !n.contact_id) return null;
    const row = await leads.getContact(tx, n.contact_id);
    if (!row || !row.detail_visible) return null;
    return ownMeansAuthor ? { own: n.author_user_id === actor.userId } : factsOf(row);
  });
}

/**
 * R-PAR-2: does `member` see the person's detail, decided by THEIR OWN RLS? A separate read-only
 * transaction as that user (their real role comes from their membership via app.my_role()).
 */
export async function memberSeesPerson(req: FastifyRequest, author: UserActor, member: repo.MemberRow, contactId: string): Promise<boolean> {
  const asMember: Actor = { kind: 'user', userId: member.user_id as never, tenantId: author.tenantId, role: member.role, sessionId: 'mention-check' };
  return withTenantTx(
    asMember,
    async (tx) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      return repo.seesDetail(tx, contactId);
    },
    { db: platformOf(req).db },
  );
}

interface MentionPlan {
  userIds: string[];
  members: Map<string, repo.MemberRow>;
  sees: Map<string, boolean>;
}

/** Parses mentions against the active members and checks each as that member (before the write). */
async function planMentions(req: FastifyRequest, contactId: string, body: string, already: readonly string[] = []): Promise<MentionPlan & { added: string[] }> {
  const actor = req.actor as UserActor;
  const members = await peopleTx(req, (tx) => repo.activeMembers(tx));
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const parsed = parseMentions(body, { members: byId.keys(), self: actor.userId });
  if (!parsed.ok) throw new AppError('MENTION_LIMIT', { count: parsed.count });
  const added = addedMentions(already, parsed.userIds);
  const sees = new Map<string, boolean>();
  for (const id of added) sees.set(id, await memberSeesPerson(req, actor, byId.get(id)!, contactId));
  return { userIds: parsed.userIds, members: byId, sees, added };
}

async function notifyMentions(req: FastifyRequest, tx: Parameters<typeof repo.insertMention>[0], plan: MentionPlan & { added: string[] }, noteId: string, contactId: string) {
  const p = platformOf(req);
  const title = mentionTitle(await repo.personLabel(tx, contactId));
  const out: { userId: string; displayName: string | null; status: 'notified' | 'no_access' | 'already_notified' }[] = [];
  for (const id of plan.userIds) {
    const m = plan.members.get(id)!;
    if (!plan.added.includes(id)) {
      out.push({ userId: id, displayName: m.display_name, status: 'already_notified' });
      continue;
    }
    if (!plan.sees.get(id)) {
      out.push({ userId: id, displayName: m.display_name, status: 'no_access' });
      continue;
    }
    const wrote = await repo.insertMention(tx, { id: p.ids.next(), deliveryId: p.ids.next(), userId: id, title, noteId, contactId, dedupeKey: mentionDedupeKey(noteId) });
    out.push({ userId: id, displayName: m.display_name, status: wrote ? 'notified' : 'already_notified' });
  }
  return out;
}

function namesOf(plan: { members: Map<string, repo.MemberRow> }): Map<string, string | null> {
  return new Map([...plan.members.values()].map((m) => [m.user_id, m.display_name]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// exactly what `created_at::text` prints; anything else used to reach a ::timestamptz cast (a 500, security review)
const AT_TEXT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function isAtText(a: string): boolean {
  const m = AT_TEXT_RE.exec(a);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (y < 1 || h > 23 || mi > 59 || se > 59) return false;
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function isNotesCursor(v: unknown): v is { p: boolean; a: string; i: string } {
  const o = v as { p?: unknown; a?: unknown; i?: unknown };
  return !!o && typeof o.p === 'boolean' && typeof o.a === 'string' && typeof o.i === 'string' && UUID_RE.test(o.i) && isAtText(o.a);
}

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/contacts/:id/notes', { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', contactAuth), schema: { params: S.IdParams, querystring: S.NotesQuery, response: { 200: S.NotesResponse } } }, async (req) => {
    const after = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor, isNotesCursor);
    if (req.query.cursor !== undefined && after === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/cursor', code: 'invalid' }] });
    return peopleTx(req, async (tx, _now, actor) => {
      const rows = await repo.notes(tx, req.params.id, req.query.limit + 1, after ? { pinned: after.p, at: after.a, id: after.i } : null);
      const names = new Map((await repo.activeMembers(tx)).map((m) => [m.user_id, m.display_name]));
      const page = rows.slice(0, req.query.limit);
      const last = page[page.length - 1];
      return {
        notes: page.map((n) => noteView(n, actor, names)),
        nextCursor: rows.length > req.query.limit && last ? encodeCursor({ p: last.pinned, a: last.at_text, i: last.id }) : null,
        // R-PAR-1: there are no private notes
        audience: 'everyone_who_sees_this_person',
      };
    });
  });

  r.get('/contacts/:id/mention-candidates', { config: { auth: 'note.write' }, preHandler: authorize('note.write', contactAuth), schema: { params: S.IdParams, response: { 200: S.MentionCandidatesResponse } } }, async (req) => {
    const actor = req.actor as UserActor;
    const members = (await peopleTx(req, (tx) => repo.activeMembers(tx, 200))).filter((m) => m.user_id !== actor.userId);
    const out = [];
    for (const m of members) out.push({ userId: m.user_id, displayName: m.display_name, role: m.role, canSee: await memberSeesPerson(req, actor, m, req.params.id) });
    return { members: out };
  });

  r.post('/contacts/:id/notes', { config: { auth: 'note.write' }, preHandler: authorize('note.write', writeAuth), schema: { params: S.IdParams, body: S.CreateNoteBody, response: { 201: S.NoteResponse, 200: S.NoteResponse } } }, async (req, reply) => {
    const p = platformOf(req);
    const contactId = req.params.id;
    // idempotent retry: the client's note id, written by the same author on the same person
    if (req.body.noteId) {
      const prior = await peopleTx(req, (tx) => repo.note(tx, req.body.noteId!));
      if (prior) {
        if (prior.author_user_id !== (req.actor as UserActor).userId || prior.contact_id !== contactId) throw new AppError('COMMAND_ID_REUSED');
        const names = await peopleTx(req, async (tx) => new Map((await repo.activeMembers(tx)).map((m) => [m.user_id, m.display_name])));
        reply.status(200);
        return { note: noteView(prior, req.actor as UserActor, names), mentions: [], replayed: true };
      }
    }
    const plan = await planMentions(req, contactId, req.body.body);
    const out = await peopleTx(req, async (tx, _now, actor) => {
      const id = req.body.noteId ?? p.ids.next();
      const pinned = req.body.pinned === true;
      await repo.insertNote(tx, { id, contactId, authorUserId: actor.userId, body: req.body.body, pinned, activity: null });
      const mentions = await notifyMentions(req, tx, plan, id, contactId);
      return { note: noteView((await repo.note(tx, id))!, actor, namesOf(plan)), mentions, replayed: false };
    });
    reply.status(201);
    return out;
  });

  r.patch('/notes/:id', { config: { auth: 'note.write' }, preHandler: authorize('note.write', (req) => noteFacts(req, false)), schema: { params: S.IdParams, body: S.UpdateNoteBody, response: { 200: S.NoteResponse } } }, async (req) => {
    const actor = req.actor as UserActor;
    const before = await peopleTx(req, (tx) => repo.note(tx, req.params.id));
    if (!before || !before.contact_id) throw new AppError('NOT_FOUND');
    if (before.source === 'import' || before.source === 'call_summary') throw new AppError('NOTE_READ_ONLY');
    if (before.author_user_id !== actor.userId) throw new AppError('NOTE_AUTHOR_ONLY');
    const b = req.body;
    if ((b.activityAt !== undefined || b.activityDirection !== undefined || b.activityOutcome !== undefined) && before.source !== 'logged_activity') {
      throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/activityAt', code: 'not_a_logged_activity' }] });
    }
    if (b.activityOutcome != null && before.activity_kind !== 'call') throw new AppError('OUTCOME_CALLS_ONLY');
    if (b.activityAt !== undefined) {
      const at = instantFromIso(b.activityAt);
      // R-PAR-31: the corrected time obeys the same window, measured from when the note was entered
      const v = at === null ? null : validateLoggedActivity({ kind: before.activity_kind ?? 'call', at }, instantFromDate(before.created_at));
      if (!v || !v.ok) throw new AppError(v && !v.ok && (v.code === 'ACTIVITY_IN_FUTURE' || v.code === 'ACTIVITY_TOO_OLD') ? v.code : 'VALIDATION_FAILED');
    }
    // E164: only people newly mentioned by this edit are checked and notified
    const plan = b.body !== undefined ? await planMentions(req, before.contact_id, b.body, mentionTokens(before.body).map((t) => t.userId)) : null;
    return peopleTx(req, async (tx) => {
      const ok = await repo.updateNote(tx, req.params.id, { ...(b.body !== undefined ? { body: b.body } : {}), ...(b.activityAt !== undefined ? { activityAt: b.activityAt } : {}), ...(b.activityDirection !== undefined ? { activityDirection: b.activityDirection } : {}), ...(b.activityOutcome !== undefined ? { activityOutcome: b.activityOutcome } : {}) });
      if (!ok) throw new AppError('NOT_FOUND');
      const mentions = plan ? await notifyMentions(req, tx, plan, req.params.id, before.contact_id!) : [];
      const names = plan ? namesOf(plan) : new Map((await repo.activeMembers(tx)).map((m) => [m.user_id, m.display_name]));
      return { note: noteView((await repo.note(tx, req.params.id))!, actor, names), mentions, replayed: false };
    });
  });

  r.post('/notes/:id/pin', { config: { auth: 'note.write' }, preHandler: authorize('note.write', (req) => noteFacts(req, false)), schema: { params: S.IdParams, body: S.PinBody, response: { 200: S.NoteResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      const n = await repo.note(tx, req.params.id);
      if (!n) throw new AppError('NOT_FOUND');
      if (n.author_user_id !== actor.userId && actor.role !== 'owner' && actor.role !== 'admin') throw new AppError('NOTE_AUTHOR_ONLY');
      if (!(await repo.updateNote(tx, n.id, { pinned: req.body.pinned }))) throw new AppError('NOT_FOUND');
      const names = new Map((await repo.activeMembers(tx)).map((m) => [m.user_id, m.display_name]));
      return { note: noteView((await repo.note(tx, n.id))!, actor, names), mentions: [], replayed: false };
    }),
  );

  r.delete('/notes/:id', { config: { auth: 'note.delete' }, preHandler: authorize('note.delete', (req) => noteFacts(req, true)), schema: { params: S.IdParams, response: { 200: S.OkResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      const n = await repo.note(tx, req.params.id);
      if (!n) throw new AppError('NOT_FOUND');
      if (!(await repo.deleteNote(tx, n.id))) throw new AppError(n.source === 'import' || n.source === 'call_summary' ? 'NOTE_READ_ONLY' : 'NOT_FOUND');
      // R-PAR-4: audited; the note text is never copied into the audit row
      await audit(tx, actor, { action: 'note.delete', entity: { type: 'note', id: n.id }, changes: redactSnapshot({ source: n.source, own: n.author_user_id === actor.userId }, { entity: 'note' }) });
      return { ok: true as const };
    }),
  );

  r.post('/contacts/:id/activities', { config: { auth: 'activity.log' }, preHandler: authorize('activity.log', writeAuth), schema: { params: S.IdParams, body: S.ActivityBody, response: { 201: S.ActivityResponse, 200: S.ActivityResponse } } }, async (req, reply) => {
    const p = platformOf(req);
    const b = req.body;
    const contactId = req.params.id;
    const at = instantFromIso(b.at);
    if (at === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/at', code: 'invalid' }] });
    if (b.noteId) {
      const prior = await peopleTx(req, (tx) => repo.note(tx, b.noteId!));
      if (prior) {
        if (prior.author_user_id !== (req.actor as UserActor).userId || prior.contact_id !== contactId || prior.source !== 'logged_activity') throw new AppError('COMMAND_ID_REUSED');
        reply.status(200);
        return { note: noteView(prior, req.actor as UserActor, new Map()), taskId: null, suggestDoNotContact: suggestsDoNotContact(prior.body), replayed: true };
      }
    }
    const out = await peopleTx(req, async (tx, now, actor) => {
      const v = validateLoggedActivity({ kind: b.kind, direction: b.direction ?? null, at, outcome: b.outcome ?? null, body: b.body ?? null, remindInDays: b.remindInDays ?? null }, now);
      if (!v.ok) throw new AppError(v.code);
      const a = v.activity;
      const id = b.noteId ?? p.ids.next();
      await repo.insertNote(tx, { id, contactId, authorUserId: actor.userId, body: a.body, pinned: false, activity: { kind: a.kind, direction: a.direction, at: toIso(a.at), outcome: a.outcome } });
      let taskId: string | null = null;
      if (a.remindInDays !== null) {
        // "Remind me in N days" is an ordinary task for the author (R-PAR-30)
        taskId = await createTask(tx, actor, p.ids, { title: followUpTitle(a.kind), kind: 'follow_up', contactId, dueAt: toIso(plusMs(now, a.remindInDays * DAY_MS)) });
      }
      return { note: noteView((await repo.note(tx, id))!, actor, new Map()), taskId, suggestDoNotContact: suggestsDoNotContact(a.body), replayed: false };
    });
    reply.status(201);
    return out;
  });
}

