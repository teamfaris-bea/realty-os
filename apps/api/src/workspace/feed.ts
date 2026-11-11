// The Priority Feed (BUILD_PLAN module 14; ARCHITECTURE §1 "See what's due: 0 taps"; R-ACC-4 feed parts,
// R-PERM-4, R-AST-12).
//
//   GET  /feed                     → { pinned, scored } (top 50; reasons on tap)                    self
//   POST /feed/:id/done            the agent handled the card                                       self
//   POST /feed/:id/snooze {until}  hide until an instant (≤ 7 days)                                  self
//   POST /feed/:id/dismiss         not relevant                                                      self
//
// refreshFeed(tx, userId, now) scores the feed with core.scoreFeed over the caller's RLS-visible inputs
// and reconciles priority_feed_items in the SAME transaction:
//   - a computed card updates its open/snoozed row (a snooze that ran out reopens), else
//   - reopens a row the recompute itself had closed (resolved_by = 'condition'), else
//   - is inserted, unless the agent closed that occurrence (resolved_by = 'user') or another module
//     closed it because its subject was handled (resolved_by NULL): both are final for that key;
//   - an open card the scorer manages but no longer produces is closed with resolved_by = 'condition'.
// Rows written by other modules under keys the scorer does not produce (call summaries, a new reply
// address ...) are left alone and shown as they are. Refreshes of one user serialize on a transaction
// advisory lock, so two tabs cannot insert the same card twice.
//
// Visibility (R-PERM-4): feed rows are readable only while their contact is visible to the user (RLS
// feed_select), and core keeps only inputs owned by the user, so after a reassignment the previous
// owner's stale cards disappear at once, and the new owner's appear on their next refresh.
//
// The response carries no score: the reasons explain the order (A2 honesty; no numbers that pretend
// precision). Pinned cards are live deadlines and close only by acting on them (FEED_ITEM_PINNED).
import {
  type FeedItem,
  type FeedReason,
  type OneTapAction,
  compareFeedItems,
  reasonFromCode,
  scoreFeed,
} from '@realty/core/priority';
import type { IdGenerator, Instant, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { loadFeedInputs } from './repos/feedInputs.js';

/** What a refresh needs besides the transaction: transcript evidence is encrypted; row ids are UUIDv7. */
export interface FeedDeps {
  envelope: EnvelopeService;
  ids: IdGenerator;
}

/** The feed shows this many cards (pinned first). */
export const FEED_LIMIT = 50;
/** The longest snooze. */
export const MAX_SNOOZE_MS = 7 * 86_400_000;

/**
 * Keys whose cards the scorer owns: when the scorer stops producing them they are closed. The first
 * group is core's own key families; the second are older keys other modules wrote for a card core now
 * produces under its own key (one card per conversation / search, never two).
 */
const MANAGED_KEY = [
  /^lead_offer:[^:]+:[^:]+$/,
  /^first_touch:[^:]+:\d+$/,
  /^reinquiry:[^:]+:[^:]+$/,
  /^inactivity:[^:]+:\d+:\d+$/,
  /^inbound:[^:]+:[^:]+$/,
  /^handback:[0-9a-f-]{36}$/,
  /^draft:[0-9a-f-]{36}$/,
  /^task:[0-9a-f-]{36}$/,
  /^deal_date:[0-9a-f-]{36}$/,
  /^appt_outcome:[0-9a-f-]{36}$/,
  /^saved_search:[0-9a-f-]{36}$/,
  // superseded keys of api/comms and api/assistant
  /^inbound:[0-9a-f-]{36}$/,
  /^missed_call:[0-9a-f-]{36}$/,
  /^search:[0-9a-f-]{36}$/,
];

export function isManagedKey(key: string): boolean {
  return MANAGED_KEY.some((re) => re.test(key));
}

export interface FeedCard {
  id: string;
  itemType: string;
  band: 'pinned' | 'scored';
  dueAt: string | null;
  contact: { id: string; name: string } | null;
  reasons: { code: string; label: string }[];
  primaryAction: OneTapAction;
  alternatives: OneTapAction[];
  subjectType: string;
  subjectId: string;
  assistantActionId: string | null;
  createdAt: string;
}

export interface FeedView {
  pinned: FeedCard[];
  scored: FeedCard[];
  /** open cards in total (the response shows at most FEED_LIMIT) */
  total: number;
  generatedAt: string;
}

interface StoredRow {
  id: string;
  item_type: string;
  band: 'pinned' | 'scored';
  contact_id: string | null;
  subject_type: string;
  subject_id: string;
  assistant_action_id: string | null;
  due_at: Date | null;
  score: number;
  reasons: unknown;
  dedupe_key: string;
  created_at: Date;
}

const iso = (t: number | Date) => new Date(t).toISOString();

/** Serializes the advisory lock for one user's feed refresh (transaction-scoped). */
async function lockUserFeed(tx: Tx, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('realty.feed:' || app.tenant_id()::text || ':' || ${userId}::text, 0))`.execute(tx);
}

/**
 * BUILD_PLAN interface: core.scoreFeed over RLS-visible inputs, persisted into priority_feed_items in the
 * caller's transaction. Returns the computed items (in feed order) for the response.
 */
export async function refreshFeed(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant): Promise<FeedItem[]> {
  const userId = actor.userId;
  await lockUserFeed(tx, userId);
  const items = scoreFeed(await loadFeedInputs(tx, actor, deps.envelope, now));
  const rows = items.map((i) => ({
    id: deps.ids.next<'FeedItemId'>(),
    dedupe_key: i.dedupeKey,
    item_type: i.itemType,
    band: i.band,
    contact_id: i.contactId,
    subject_type: i.subjectType,
    subject_id: i.subjectId,
    assistant_action_id: i.assistantActionId,
    due_at: i.dueAt === null ? null : iso(i.dueAt),
    score: i.score,
    score_version: i.scoreVersion,
    reasons: i.reasons.map((r) => ({ code: r.code, label: r.label, ...(r.points === undefined ? {} : { points: r.points }) })),
  }));
  const input = JSON.stringify(rows);
  const nowIso = iso(now);
  // The computed cards, parsed once per statement (scale-250k): as a bare function scan the planner put the
  // recordset on the inner side of a nested loop and re-parsed the whole JSON for every stored card.
  const withX = sql`WITH x AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS r(id uuid, dedupe_key text, item_type text, band text, contact_id uuid, subject_type text,
                          subject_id uuid, assistant_action_id uuid, due_at timestamptz, score int, score_version int, reasons jsonb))`;

  // 1. live rows (open / snoozed) of computed keys: refresh content; a snooze that ran out reopens
  await sql`${withX}
    UPDATE priority_feed_items f SET item_type = x.item_type, band = x.band, contact_id = x.contact_id, subject_type = x.subject_type,
           subject_id = x.subject_id, assistant_action_id = x.assistant_action_id, due_at = x.due_at, score = x.score,
           score_version = x.score_version, reasons = x.reasons,
           state = CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN 'open' ELSE f.state END,
           snoozed_until = CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN NULL ELSE f.snoozed_until END,
           updated_at = now()
      FROM x
     WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${userId} AND f.dedupe_key = x.dedupe_key AND f.state IN ('open','snoozed')
       AND (f.item_type, f.band, f.contact_id, f.subject_id, f.assistant_action_id, f.due_at, f.score, f.reasons, f.state)
           IS DISTINCT FROM (x.item_type, x.band, x.contact_id, x.subject_id, x.assistant_action_id, x.due_at, x.score, x.reasons,
                             CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN 'open' ELSE f.state END)`.execute(tx);

  // 2. occurrences the recompute closed earlier and that are due again: reopen the latest such row
  await sql`${withX}
    UPDATE priority_feed_items f SET state = 'open', resolved_at = NULL, resolved_by = NULL, snoozed_until = NULL,
           item_type = x.item_type, band = x.band, contact_id = x.contact_id, subject_type = x.subject_type, subject_id = x.subject_id,
           assistant_action_id = x.assistant_action_id, due_at = x.due_at, score = x.score, score_version = x.score_version,
           reasons = x.reasons, updated_at = now()
      FROM x
     WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${userId} AND f.dedupe_key = x.dedupe_key
       AND f.id = (SELECT g.id FROM priority_feed_items g
                    WHERE g.tenant_id = f.tenant_id AND g.user_id = f.user_id AND g.dedupe_key = x.dedupe_key AND g.resolved_by = 'condition'
                    ORDER BY g.resolved_at DESC, g.id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM priority_feed_items o WHERE o.tenant_id = f.tenant_id AND o.user_id = f.user_id AND o.dedupe_key = x.dedupe_key
                         AND (o.state IN ('open','snoozed') OR (o.state IN ('done','dismissed') AND o.resolved_by IS DISTINCT FROM 'condition')))`.execute(tx);

  // 3. new occurrences: insert (never over a final close of the same key)
  await sql`${withX}
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, due_at,
                                     score, score_version, reasons, dedupe_key)
    SELECT app.tenant_id(), x.id, ${userId}, x.item_type, x.band, x.contact_id, x.subject_type, x.subject_id, x.assistant_action_id,
           x.due_at, x.score, x.score_version, x.reasons, x.dedupe_key
      FROM x
     WHERE NOT EXISTS (SELECT 1 FROM priority_feed_items o WHERE o.tenant_id = app.tenant_id() AND o.user_id = ${userId} AND o.dedupe_key = x.dedupe_key)
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO NOTHING`.execute(tx);

  // 4. managed cards the scorer no longer produces: their condition stopped holding
  const live = await sql<{ id: string; dedupe_key: string }>`
    SELECT id, dedupe_key FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND state IN ('open','snoozed')`.execute(tx);
  const computed = new Set(items.map((i) => i.dedupeKey));
  const stale = live.rows.filter((r) => !computed.has(r.dedupe_key) && isManagedKey(r.dedupe_key)).map((r) => r.id);
  if (stale.length > 0) {
    await sql`
      UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${nowIso}::timestamptz, resolved_by = 'condition', updated_at = now()
       WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND id = ANY (${stale}::uuid[])`.execute(tx);
  }
  return items;
}

function reasonsOf(stored: unknown): { code: string; label: string }[] {
  const list = Array.isArray(stored) ? stored : [];
  const out: { code: string; label: string }[] = [];
  for (const r of list) {
    if (typeof r === 'string') out.push(strip(reasonFromCode(r)));
    else if (r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string') {
      const x = r as { code: string; label?: unknown; text?: unknown };
      const label = typeof x.label === 'string' ? x.label : typeof x.text === 'string' ? x.text : reasonFromCode(x.code).label;
      out.push({ code: x.code, label });
    }
  }
  return out.length > 0 ? out : [{ code: 'NEEDS_ATTENTION', label: 'Needs your attention' }];
}

const strip = (r: FeedReason) => ({ code: r.code, label: r.label });

/** Actions for a card another module wrote under its own key (no scorer item to take them from). */
function foreignActions(r: StoredRow): { primaryAction: OneTapAction; alternatives: OneTapAction[] } {
  const open: OneTapAction[] = r.contact_id ? [{ kind: 'open_contact', label: 'Open', contactId: r.contact_id as never }] : [];
  if (r.assistant_action_id) return { primaryAction: { kind: 'edit_draft', label: 'Review', actionId: r.assistant_action_id as never }, alternatives: open };
  if (r.subject_type === 'task') return { primaryAction: { kind: 'open_task', label: 'Open task', taskId: r.subject_id as never }, alternatives: open };
  if (open[0]) return { primaryAction: open[0], alternatives: [] };
  return { primaryAction: { kind: 'open_contact', label: 'Open', contactId: r.subject_id as never }, alternatives: [] };
}

/** GET /feed: refresh, then the open cards with their one-tap actions, pinned first. */
export async function getFeed(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant): Promise<FeedView> {
  const items = await refreshFeed(tx, actor, deps, now);
  const byKey = new Map(items.map((i) => [i.dedupeKey, i]));
  const r = await sql<StoredRow & { contact_name: string | null }>`
    SELECT f.id, f.item_type, f.band, f.contact_id, f.subject_type, f.subject_id, f.assistant_action_id, f.due_at, f.score, f.reasons,
           f.dedupe_key, f.created_at, c.display_name AS contact_name
      FROM priority_feed_items f
      LEFT JOIN contacts c ON c.tenant_id = f.tenant_id AND c.id = f.contact_id
     WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${actor.userId} AND f.state = 'open'
       AND (f.contact_id IS NULL OR (c.id IS NOT NULL AND c.deleted_at IS NULL))`.execute(tx);
  const cards: { item: FeedItem; card: FeedCard }[] = [];
  for (const row of r.rows) {
    const computed = byKey.get(row.dedupe_key);
    if (!computed && isManagedKey(row.dedupe_key)) continue; // closed by this refresh in an earlier step
    const actions = computed ? { primaryAction: computed.primaryAction, alternatives: computed.alternatives } : foreignActions(row);
    const sortable: FeedItem = computed ?? {
      itemType: row.item_type as FeedItem['itemType'],
      band: row.band,
      score: row.score,
      scoreVersion: 1,
      reasons: [],
      dueAt: row.due_at ? (row.due_at.getTime() as Instant) : null,
      dedupeKey: row.dedupe_key,
      ...actions,
      contactId: row.contact_id as never,
      subjectType: row.subject_type as FeedItem['subjectType'],
      subjectId: row.subject_id,
      assistantActionId: row.assistant_action_id as never,
      createdAt: row.created_at.getTime() as Instant,
    };
    cards.push({
      item: sortable,
      card: {
        id: row.id,
        itemType: row.item_type,
        band: sortable.band,
        dueAt: row.due_at ? iso(row.due_at) : null,
        contact: row.contact_id && row.contact_name ? { id: row.contact_id, name: row.contact_name } : null,
        reasons: computed ? computed.reasons.map(strip) : reasonsOf(row.reasons),
        ...actions,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        assistantActionId: row.assistant_action_id,
        createdAt: iso(row.created_at),
      },
    });
  }
  cards.sort((a, b) => compareFeedItems(a.item, b.item));
  const shown = cards.slice(0, FEED_LIMIT).map((c) => c.card);
  return { pinned: shown.filter((c) => c.band === 'pinned'), scored: shown.filter((c) => c.band === 'scored'), total: cards.length, generatedAt: iso(now) };
}

export type FeedVerb = 'done' | 'snooze' | 'dismiss';

/** POST /feed/:id/{done,snooze,dismiss}: the caller's own card (RLS: own and contact still visible). */
export async function actOnFeedItem(tx: Tx, actor: UserActor, id: string, verb: FeedVerb, now: Instant, until?: Instant): Promise<{ id: string; state: string; snoozedUntil: string | null }> {
  const r = await sql<{ id: string; band: string; state: string; snoozed_until: Date | null }>`
    SELECT id, band, state, snoozed_until FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND user_id = ${actor.userId} FOR UPDATE`.execute(tx);
  const row = r.rows[0];
  if (!row) throw new AppError('NOT_FOUND');
  if (row.band === 'pinned') throw new AppError('FEED_ITEM_PINNED');
  const target = verb === 'done' ? 'done' : verb === 'dismiss' ? 'dismissed' : 'snoozed';
  // idempotent repeat of the same close
  if ((row.state === 'done' || row.state === 'dismissed') && row.state === target) return { id, state: row.state, snoozedUntil: null };
  if (row.state !== 'open' && row.state !== 'snoozed') throw new AppError('FEED_ITEM_NOT_OPEN', { state: row.state });
  if (verb === 'snooze') {
    if (until === undefined || until <= now || until - now > MAX_SNOOZE_MS) throw new AppError('VALIDATION_FAILED', { reason: 'SNOOZE_RANGE' });
    await sql`UPDATE priority_feed_items SET state = 'snoozed', snoozed_until = ${iso(until)}::timestamptz, updated_at = now()
               WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
    return { id, state: 'snoozed', snoozedUntil: iso(until) };
  }
  await sql`UPDATE priority_feed_items SET state = ${target}, snoozed_until = NULL, resolved_at = ${iso(now)}::timestamptz, resolved_by = 'user', updated_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return { id, state: target, snoozedUntil: null };
}

/** Closes the caller's open card of one subject occurrence right away (e.g. after an outcome is logged). */
export async function closeFeedKey(tx: Tx, userId: string, dedupeKey: string, now: Instant): Promise<void> {
  await sql`
    UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${iso(now)}::timestamptz, resolved_by = 'condition', updated_at = now()
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND dedupe_key = ${dedupeKey} AND state IN ('open','snoozed')`.execute(tx);
}
