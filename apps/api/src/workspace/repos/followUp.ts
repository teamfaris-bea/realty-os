// What a follow-up card says about its person (batch 19, warm follow-up in Today; R-TODAY-1 to R-TODAY-5): the last
// human contact, the automatic line and the next promise, read for a whole page of cards at once.
//
// Every statement runs in the VIEWER's own transaction, so row-level security decides which messages, calls, notes
// and appointments exist for them (each of those tables shows a row only with the person's detail). The history
// query also starts from the people whose detail the viewer may open, so a person seen only as a pond or offer card,
// or not at all, gives nothing. No definer reads on anyone's behalf.
//
// Bounded: FOLLOW_UP_CONTEXT_QUERIES statements for any number of people (settings, history, tasks), each person's
// history being a handful of single-row index reads. One more statement only when a quoted note mentions a teammate
// (their current name, never the label typed into the token). No per-card query.
//
// The selection itself is core's (priority/followUp.ts): an automated message is never the last thing discussed. As
// defence in depth the automatic branch here does not even select a message body, so an automated text has no way
// into a snippet. A redacted message is quoted as stored, and a sign-in token stored before the redaction existed is
// hidden before the text is cut (portal/shared/redact.ts hideForDisplay), exactly as the person's timeline does.
import type { IanaZone, Instant, UserActor } from '@realty/core/foundation';
import { defaultActivityBody, mentionTokens, renderMentions, stageLabel } from '@realty/core/parity/people';
import { type ContactCandidate, type LastAutomatic, type LastTouch, type NextPromise, type PromiseTask, selectLastContact, selectNextPromise } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { hideForDisplay } from '../../portal/shared/redact.js';

/** The statements one call sends, however many people it is asked about. */
export const FOLLOW_UP_CONTEXT_QUERIES = 3;
/** Characters of a body read from the database (the snippet is cut to 140 after redaction). */
const BODY_READ = 600;
/** Open tasks read for one page of people. */
const TASKS_READ = 2000;

export interface FollowUpContext {
  /** null: the viewer cannot open this person's detail, so nothing about them is said */
  stage: { key: string; label: string } | null;
  lastTouch: LastTouch | null;
  lastAutomatic: LastAutomatic | null;
  importedHistoryAt: Instant | null;
  nextPromise: NextPromise | null;
  /** every open task of the viewer for the person (the daily plan reads them) */
  tasks: PromiseTask[];
}

export interface FollowUpContexts {
  zone: IanaZone;
  stageLabels: Record<string, string>;
  byContact: Map<string, FollowUpContext>;
}

interface HistoryRow {
  contact_id: string;
  source: 'stage' | 'message' | 'automatic' | 'call' | 'note' | 'appointment' | 'imported';
  id: string | null;
  at: Date | null;
  by_user: string | null;
  by_name: string | null;
  facts: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function candidateOf(r: HistoryRow): ContactCandidate | null {
  if (r.at === null || r.id === null) return null;
  const base = { id: r.id, at: r.at.getTime() as Instant, byName: r.by_name, byUserId: r.by_user };
  const f = r.facts;
  switch (r.source) {
    case 'message':
    case 'automatic':
      return {
        ...base,
        source: 'message',
        channel: f.channel as never,
        direction: f.direction as never,
        initiator: f.initiator as never,
        imported: f.imported === true,
        bulk: f.bulk === true,
        autoReply: f.autoReply === true,
        status: str(f.status) ?? '',
        // the automatic branch selects no body at all
        body: r.source === 'message' ? hideForDisplay(str(f.body)).text : null,
      };
    case 'call':
      return { ...base, source: 'call', direction: f.direction as never, initiator: f.initiator as never, imported: f.imported === true, status: str(f.status) ?? '', answered: f.answered === true, handledBy: f.handledBy as never, outcome: str(f.outcome), talkSeconds: typeof f.talkSeconds === 'number' ? f.talkSeconds : null };
    case 'note': {
      const kind = str(f.activityKind) as 'call' | 'text' | 'email' | null;
      const direction = str(f.activityDirection) as 'inbound' | 'outbound' | null;
      const outcome = str(f.activityOutcome);
      const body = str(f.body);
      return {
        ...base,
        source: 'note',
        noteSource: str(f.noteSource) ?? '',
        imported: f.imported === true,
        activity: kind ? { kind, direction, outcome } : null,
        bodyIsDefault: kind !== null && body !== null && body === defaultActivityBody(kind, direction ?? 'outbound', outcome as never),
        body,
      };
    }
    case 'appointment':
      return { ...base, source: 'appointment', status: str(f.status) ?? '', outcome: str(f.outcome) };
    default:
      return null;
  }
}

/**
 * The follow-up lines of `contactIds` for the viewer, as of `now`. A person whose detail the viewer may not open has
 * an entry with no stage, no history and only the viewer's own tasks.
 */
export async function loadFollowUpContext(tx: Tx, actor: UserActor, contactIds: readonly string[], now: Instant): Promise<FollowUpContexts> {
  const ids = [...new Set(contactIds)];
  const byContact = new Map<string, FollowUpContext>();
  if (ids.length === 0) return { zone: 'UTC' as IanaZone, stageLabels: {}, byContact };
  const nowIso = new Date(now).toISOString();

  // 1. the team's zone and its own stage labels
  const settings = await sql<{ zone: string; stage_labels: Record<string, string> | null }>`
    SELECT default_timezone AS zone, stage_labels FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const zone = (settings.rows[0]?.zone ?? 'UTC') as IanaZone;
  const stageLabels = settings.rows[0]?.stage_labels ?? {};

  // 2. per person: the stage, and the newest row of each kind that could be what was last discussed
  const history = await sql<HistoryRow>`
    WITH p AS MATERIALIZED (
      SELECT c.tenant_id, c.id, c.stage FROM contacts c
       WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${ids}::uuid[]) AND c.deleted_at IS NULL
         AND app.contact_detail_visible(c.tenant_id, c.id)),
    rows AS (
      SELECT p.id AS contact_id, 'stage'::text AS source, NULL::uuid AS id, NULL::timestamptz AS at, NULL::uuid AS by_user, jsonb_build_object('stage', p.stage) AS facts FROM p
      UNION ALL
      SELECT p.id, 'message', x.id, x.at, x.by_user, x.facts FROM p CROSS JOIN LATERAL (
        SELECT m.id, m.occurred_at AS at, m.initiated_by_user_id AS by_user,
               jsonb_build_object('channel', m.channel, 'direction', m.direction, 'initiator', m.initiator, 'imported', m.imported, 'bulk', false,
                                  'autoReply', m.is_auto_reply, 'status', m.status, 'body', left(m.body, ${BODY_READ})) AS facts
          FROM messages m
         WHERE m.tenant_id = p.tenant_id AND m.contact_id = p.id AND m.occurred_at <= ${nowIso}::timestamptz AND NOT m.imported
           AND m.bulk_action_id IS NULL AND m.marketing_piece_id IS NULL
           AND ((m.direction = 'outbound' AND m.initiator = 'human' AND m.status IN ('sent','delivered'))
                OR (m.direction = 'inbound' AND NOT m.is_auto_reply))
         ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) x
      UNION ALL
      -- an automated message: when and on which channel, never its text
      SELECT p.id, 'automatic', x.id, x.at, NULL::uuid, x.facts FROM p CROSS JOIN LATERAL (
        SELECT m.id, m.occurred_at AS at,
               jsonb_build_object('channel', m.channel, 'direction', m.direction, 'initiator', m.initiator, 'imported', m.imported,
                                  'bulk', (m.bulk_action_id IS NOT NULL OR m.marketing_piece_id IS NOT NULL), 'autoReply', false, 'status', m.status) AS facts
          FROM messages m
         WHERE m.tenant_id = p.tenant_id AND m.contact_id = p.id AND m.occurred_at <= ${nowIso}::timestamptz AND NOT m.imported
           AND m.direction = 'outbound' AND m.status IN ('sent','delivered')
           AND (m.initiator IN ('assistant','system') OR m.bulk_action_id IS NOT NULL OR m.marketing_piece_id IS NOT NULL)
         ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) x
      UNION ALL
      SELECT p.id, 'call', x.id, x.at, x.by_user, x.facts FROM p CROSS JOIN LATERAL (
        SELECT k.id, k.started_at AS at, k.agent_user_id AS by_user,
               jsonb_build_object('direction', k.direction, 'initiator', k.initiator, 'imported', k.imported, 'status', k.status,
                                  'answered', k.answered_at IS NOT NULL, 'handledBy', k.handled_by, 'outcome', k.outcome,
                                  'talkSeconds', CASE WHEN k.answered_at IS NOT NULL AND k.ended_at IS NOT NULL
                                                      THEN GREATEST(0, floor(extract(epoch FROM k.ended_at - k.answered_at)))::int END) AS facts
          FROM calls k
         WHERE k.tenant_id = p.tenant_id AND k.contact_id = p.id AND k.started_at <= ${nowIso}::timestamptz AND NOT k.imported
           AND ((k.direction = 'outbound' AND k.initiator = 'human'
                 AND (k.answered_at IS NOT NULL OR k.outcome IS NOT NULL OR k.status IN ('completed','no_answer','busy','voicemail')))
                OR (k.direction = 'inbound' AND k.answered_at IS NOT NULL AND k.handled_by = 'human'))
         ORDER BY k.started_at DESC, k.id DESC LIMIT 1) x
      UNION ALL
      SELECT p.id, 'note', x.id, x.at, x.by_user, x.facts FROM p CROSS JOIN LATERAL (
        SELECT n.id, COALESCE(n.activity_at, n.created_at) AS at, n.author_user_id AS by_user,
               jsonb_build_object('noteSource', n.source, 'imported', n.imported, 'activityKind', n.activity_kind, 'activityDirection', n.activity_direction,
                                  'activityOutcome', n.activity_outcome, 'body', left(n.body, ${BODY_READ})) AS facts
          FROM notes n
         WHERE n.tenant_id = p.tenant_id AND n.contact_id = p.id AND NOT n.imported AND n.source IN ('manual','logged_activity')
           AND COALESCE(n.activity_at, n.created_at) <= ${nowIso}::timestamptz
         ORDER BY COALESCE(n.activity_at, n.created_at) DESC, n.id DESC LIMIT 1) x
      UNION ALL
      SELECT p.id, 'appointment', x.id, x.at, x.by_user, x.facts FROM p CROSS JOIN LATERAL (
        SELECT a.id, a.starts_at AS at, a.user_id AS by_user, jsonb_build_object('status', a.status, 'outcome', a.outcome) AS facts
          FROM appointments a
         WHERE a.tenant_id = p.tenant_id AND a.contact_id = p.id AND a.status = 'held' AND a.starts_at <= ${nowIso}::timestamptz
         ORDER BY a.starts_at DESC, a.id DESC LIMIT 1) x
      UNION ALL
      -- history another system wrote: only its latest date (nobody can say who or what wrote it)
      SELECT p.id, 'imported', p.id, GREATEST(
               (SELECT max(m.occurred_at) FROM messages m WHERE m.tenant_id = p.tenant_id AND m.contact_id = p.id AND m.imported),
               (SELECT max(k.started_at) FROM calls k WHERE k.tenant_id = p.tenant_id AND k.contact_id = p.id AND k.imported),
               (SELECT max(n.created_at) FROM notes n WHERE n.tenant_id = p.tenant_id AND n.contact_id = p.id AND n.imported)), NULL::uuid, '{}'::jsonb FROM p)
    SELECT r.contact_id, r.source, r.id::text AS id, r.at, r.by_user::text AS by_user, u.display_name AS by_name, r.facts
      FROM rows r LEFT JOIN users u ON u.id = r.by_user`.execute(tx);

  // 3. the viewer's own open tasks for these people
  const tasks = await sql<{ id: string; contact_id: string; kind: PromiseTask['kind']; title: string; due_at: Date | null; due_all_day: boolean; due_tz: string | null; created_at: Date }>`
    SELECT id, contact_id, kind, title, due_at, due_all_day, due_tz, created_at FROM tasks
     WHERE tenant_id = app.tenant_id() AND assignee_user_id = ${actor.userId} AND status = 'open' AND contact_id = ANY (${ids}::uuid[])
     ORDER BY due_at NULLS LAST, created_at, id LIMIT ${TASKS_READ}`.execute(tx);

  const stageOf = new Map<string, string>();
  const candidates = new Map<string, ContactCandidate[]>();
  const importedAt = new Map<string, Instant>();
  for (const r of history.rows) {
    if (r.source === 'stage') {
      const s = str(r.facts.stage);
      if (s) stageOf.set(r.contact_id, s);
      continue;
    }
    if (r.source === 'imported') {
      if (r.at !== null) importedAt.set(r.contact_id, r.at.getTime() as Instant);
      continue;
    }
    const c = candidateOf(r);
    if (!c) continue;
    const list = candidates.get(r.contact_id);
    if (list) list.push(c);
    else candidates.set(r.contact_id, [c]);
  }
  const tasksOf = new Map<string, PromiseTask[]>();
  for (const t of tasks.rows) {
    const p: PromiseTask = { taskId: t.id, title: t.title, kind: t.kind, dueAt: t.due_at ? (t.due_at.getTime() as Instant) : null, dueAllDay: t.due_all_day, dueTz: t.due_tz as IanaZone | null, createdAt: t.created_at.getTime() as Instant };
    const list = tasksOf.get(t.contact_id);
    if (list) list.push(p);
    else tasksOf.set(t.contact_id, [p]);
  }

  // a quoted note that mentions a teammate shows their current name, never the label typed into the token
  const mentioned = new Set<string>();
  for (const list of candidates.values()) for (const c of list) if (c.source === 'note' && c.body) for (const t of mentionTokens(c.body)) mentioned.add(t.userId);
  const names = new Map<string, string | null>();
  if (mentioned.size > 0) {
    const u = await sql<{ user_id: string; display_name: string | null }>`
      SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (${[...mentioned]}::uuid[])`.execute(tx);
    for (const x of u.rows) names.set(x.user_id, x.display_name);
    for (const list of candidates.values()) for (const c of list) if (c.source === 'note' && c.body) c.body = renderMentions(c.body, (id) => names.get(id) ?? 'a teammate');
  }

  for (const id of ids) {
    const stage = stageOf.get(id) ?? null;
    const picked = selectLastContact(candidates.get(id) ?? [], now);
    const mine = tasksOf.get(id) ?? [];
    byContact.set(id, {
      stage: stage === null ? null : { key: stage, label: stageLabel(stage as never, stageLabels) },
      lastTouch: picked.lastTouch,
      lastAutomatic: picked.lastAutomatic,
      // only said when there is no last touch
      importedHistoryAt: picked.lastTouch === null ? (importedAt.get(id) ?? null) : null,
      nextPromise: selectNextPromise(mine, now, zone),
      tasks: mine,
    });
  }
  return { zone, stageLabels, byContact };
}
