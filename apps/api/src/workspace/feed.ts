// The Priority Feed (BUILD_PLAN module 14; ARCHITECTURE §1 "See what's due: 0 taps"; R-ACC-4 feed parts,
// R-PERM-4, R-AST-12).
//
//   GET  /feed                     → { pinned, scored } (top 50; reasons on tap)                    self
//   POST /feed/:id/done            the agent handled the card                                       self
//   POST /feed/:id/snooze {until}  hide until an instant (≤ 7 days)                                  self
//   POST /feed/:id/dismiss         not relevant                                                      self
//
// Incremental feed (lane perf-misses; docs/PERFORMANCE.md "Priority Feed"). GET /feed no longer recomputes
// the whole book. The cards are MATERIALIZED in priority_feed_items and GET reads the top 50 by index:
//   - writes mark the groups they touch dirty: DB triggers (migration feed_incremental) add a feed_dirty row
//     (user, group) for every user whose feed a changed row can affect; a group is a contact, or a task /
//     appointment without a contact, or a deal date (core/priority incremental.ts);
//   - time moves a group only at instants core.nextFeedChange and loadFeedInputsScoped name; each group's
//     next such instant is stored in feed_groups.check_at;
//   - materializeFeed (run by GET first, and by the feed.materialize job in the background) re-scores only
//     the dirty and due groups of one user, under that user's own RLS, and reconciles their cards;
//   - card wording with relative times is stored as a template (scoreFeed labels: 'template') and rendered
//     for the instant of the read, so the words are what a full recompute would say;
//   - a full recompute (refreshFeed) runs for a user with no materialized state yet and, as the periodic
//     reconcile that repairs any drift, at most once per RECONCILE_EVERY_MS from the job.
// Equivalence: feed_incremental.test.ts applies random event sequences and checks after each step that
// the materialized feed equals a full recompute.
//
// The reconcile of one set of groups (applyCards) is the Phase 1 refresh, restricted to those groups:
//   - a computed card updates its open/snoozed row (a snooze that ran out reopens), else
//   - reopens a row the recompute itself had closed (resolved_by = 'condition'), else
//   - is inserted, unless the agent closed that occurrence (resolved_by = 'user') or another module
//     closed it because its subject was handled (resolved_by NULL): both are final for that key;
//   - an open card the scorer manages but no longer produces is closed with resolved_by = 'condition'.
// Rows written by other modules under keys the scorer does not produce (call summaries, a new reply
// address ...) are left alone and shown as they are. Refreshes of one user serialize on a transaction
// advisory lock, so two tabs cannot insert the same card twice.
//
// Phase 2/3 cards (module 18a; PHASE2_3_PLAN §5.3): the owning module adds a card by writing ONE
// priority_feed_items row under its key family (core/priority keys.ts):
//   seller_update     seller_update:{listing}:{period}   module 28   → Open listing
//   marketing_review  marketing:{piece}                  module 29   → Open listing (the piece's listing)
//   weekly_plan       weekly_plan:{user}:{week}          module 33   → See the plan (module 40's /plan/{week} page)
//   coaching_fix      coaching_fix:{user}:{date}         module 36   → See the tip (module 36's /coaching page)
//   likely_to_move    likely:{contact}:{model}           module 50   → Open contact
// The scorer never produces those keys, so it never updates or closes them; foreignActions() gives each
// its one-tap action from the ids in its key. Deep links go only to pages that exist today (the listing and
// contact pages, module 40's weekly plan page and module 36's daily tip page). A marketing_review card whose
// piece has no listing the viewer can open is the one that opens its own details in place (show_details).
//
// R-PRED-5 (read path): a likely_to_move card is shown only while ITS model (the one in its key) is
// approved and that model's prediction for the contact is still a likely/watch band. The RESTRICTIVE
// policy likely_to_move_model_live (0018) already hides the card when no approved model predicts the
// contact; this read is narrower (a card made with a withdrawn model stays hidden even if another
// approved model also flags the contact).
//
// Visibility (R-PERM-4): feed rows are readable only while their contact is visible to the user (RLS
// feed_select), and core keeps only inputs owned by the user, so after a reassignment the previous
// owner's stale cards disappear at once, and the new owner's appear on their next refresh.
//
// Pond leads (R-OWN-16, R-PERM-6; journey bug "agents never saw a pond lead"): a "New in the pond" card for each
// lead that entered, within 24 h, a pond the member may claim from, unless they are in claim cooldown on it
// (repos/feedInputs.ts; migration pond_leads_feed marks every such member when a lead enters or leaves a pond).
// The member's own running totals (claims today, uncontacted leads) hide the cards of the ponds they block when
// the feed is READ (leads/claimable.ts): they change with the member's other leads and the day, so they are never
// stored. A pond card names the lead by first name and last initial, like the Pond page.
//
// The response carries no score: the reasons explain the order (A2 honesty; no numbers that pretend
// precision). Pinned cards are live deadlines and close only by acting on them (FEED_ITEM_PINNED).
import {
  type FeedItem,
  type FeedReason,
  type OneTapAction,
  feedGroupOfItem,
  parseForeignFeedKey,
  reasonFromCode,
  renderFeedItem,
  renderFeedLabel,
  scoreFeed,
} from '@realty/core/priority';
import type { IdGenerator, Instant, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { blockedPondIds, claimStatus } from '../leads/claimable.js';
import { maskLastName } from '../leads/views.js';
import { type FeedScope, loadFeedInputsScoped } from './repos/feedInputs.js';

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
  /^pond_new:[^:]+:\d+$/,
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
  /** a task or promise card: the task's own title (the card is about it, not only its person) */
  task: { id: string; title: string } | null;
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

/** The periodic full reconcile of one user's feed (repairs drift from a missed mark; the job runs it). */
export const RECONCILE_EVERY_MS = 3_600_000;
/** feed_groups key holding the instant of a user's next full reconcile; its presence means "materialized". */
export const RECONCILE_KEY = '~reconcile';

/** What a stored, materialized card keeps for the read path (priority_feed_items.card). */
interface StoredCard {
  reasons: FeedReason[];
  primaryAction: OneTapAction;
  alternatives: OneTapAction[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The groups to re-score as a FeedScope (malformed group keys are ignored). */
function scopeOf(groups: Iterable<string>): FeedScope {
  const scope = { contactIds: [] as string[], taskIds: [] as string[], appointmentIds: [] as string[], dealDateIds: [] as string[] };
  for (const g of groups) {
    const id = g.slice(2);
    if (g[1] !== ':' || !UUID.test(id)) continue;
    if (g[0] === 'c') scope.contactIds.push(id);
    else if (g[0] === 't') scope.taskIds.push(id);
    else if (g[0] === 'a') scope.appointmentIds.push(id);
    else if (g[0] === 'd') scope.dealDateIds.push(id);
  }
  return scope;
}

/** The group of a stored row (as core.feedGroupOfItem; contactless rows by their key family). */
function groupOfRow(r: { contact_id: string | null; dedupe_key: string; subject_type: string; subject_id: string }): string {
  if (r.contact_id !== null) return `c:${r.contact_id}`;
  if (r.dedupe_key.startsWith('task:')) return `t:${r.dedupe_key.slice(5)}`;
  if (r.dedupe_key.startsWith('appt_outcome:')) return `a:${r.dedupe_key.slice(13)}`;
  if (r.dedupe_key.startsWith('deal_date:')) return `d:${r.dedupe_key.slice(10)}`;
  return feedGroupOfItem({ contactId: null, subjectType: r.subject_type as never, subjectId: r.subject_id });
}

/**
 * Reconciles priority_feed_items with the computed (templated) cards of a set of groups (`scope`), or of the
 * whole book (`scope` null). Returns the instants at which snoozed cards of the scope wake.
 */
async function applyCards(tx: Tx, userId: string, deps: FeedDeps, items: readonly FeedItem[], now: Instant, scope: FeedScope | null): Promise<Map<string, number>> {
  const rows = items.map((i) => {
    const rendered = renderFeedItem(i, now);
    const card: StoredCard = { reasons: i.reasons, primaryAction: i.primaryAction, alternatives: i.alternatives };
    return {
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
      // `reasons` keeps plain words as of this refresh (for any other reader); the card holds the template
      reasons: rendered.reasons.map((r) => ({ code: r.code, label: r.label, ...(r.points === undefined ? {} : { points: r.points }) })),
      sort_at: iso(i.createdAt),
      card,
    };
  });
  const input = JSON.stringify(rows);
  const keys = rows.map((r) => r.dedupe_key);
  const nowIso = iso(now);
  // The computed cards, parsed once per statement (scale-250k): as a bare function scan the planner put the
  // recordset on the inner side of a nested loop and re-parsed the whole JSON for every stored card.
  // A card is written only while its contact is visible to the member (RLS would hide it anyway, and the
  // new row of an INSERT ... ON CONFLICT / UPDATE must pass the SELECT policy: writing it raised, and the
  // member's every GET /feed failed). Cards whose inputs were read through `contacts` are visible by
  // construction; tasks, appointments and assistant actions name a contact the member may not see (e.g. a
  // task handed to a member outside the contact's team).
  const withX = sql`WITH x AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS r(id uuid, dedupe_key text, item_type text, band text, contact_id uuid, subject_type text,
                          subject_id uuid, assistant_action_id uuid, due_at timestamptz, score int, score_version int, reasons jsonb,
                          sort_at timestamptz, card jsonb)
       WHERE r.contact_id IS NULL OR r.item_type NOT IN ('task_due','promise_due','appointment_outcome','handback','assistant_draft')
          OR app.contact_visible(app.tenant_id(), r.contact_id))`;

  if (rows.length > 0) {
    // 1. live rows (open / snoozed) of computed keys: refresh content; a snooze that ran out reopens. Wording
    //    alone never rewrites a row (the card's template already says it); structure or an expired snooze do.
    await sql`${withX}
      UPDATE priority_feed_items f SET item_type = x.item_type, band = x.band, contact_id = x.contact_id, subject_type = x.subject_type,
             subject_id = x.subject_id, assistant_action_id = x.assistant_action_id, due_at = x.due_at, score = x.score,
             score_version = x.score_version, reasons = x.reasons, sort_at = x.sort_at, card = x.card,
             state = CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN 'open' ELSE f.state END,
             snoozed_until = CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN NULL ELSE f.snoozed_until END,
             updated_at = now()
        FROM x
       WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${userId} AND f.dedupe_key = x.dedupe_key AND f.state IN ('open','snoozed')
         AND f.dedupe_key = ANY (${keys}::text[])
         AND (f.item_type, f.band, f.contact_id, f.subject_type, f.subject_id, f.assistant_action_id, f.due_at, f.score, f.sort_at, f.card, f.state)
             IS DISTINCT FROM (x.item_type, x.band, x.contact_id, x.subject_type, x.subject_id, x.assistant_action_id, x.due_at, x.score, x.sort_at, x.card,
                               CASE WHEN f.state = 'snoozed' AND f.snoozed_until <= ${nowIso}::timestamptz THEN 'open' ELSE f.state END)`.execute(tx);

    // 2. occurrences the recompute closed earlier and that are due again: reopen the latest such row
    await sql`${withX}
      UPDATE priority_feed_items f SET state = 'open', resolved_at = NULL, resolved_by = NULL, snoozed_until = NULL,
             item_type = x.item_type, band = x.band, contact_id = x.contact_id, subject_type = x.subject_type, subject_id = x.subject_id,
             assistant_action_id = x.assistant_action_id, due_at = x.due_at, score = x.score, score_version = x.score_version,
             reasons = x.reasons, sort_at = x.sort_at, card = x.card, updated_at = now()
        FROM x
       WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${userId} AND f.dedupe_key = x.dedupe_key AND f.dedupe_key = ANY (${keys}::text[])
         AND f.id = (SELECT g.id FROM priority_feed_items g
                      WHERE g.tenant_id = f.tenant_id AND g.user_id = f.user_id AND g.dedupe_key = x.dedupe_key AND g.resolved_by = 'condition'
                      ORDER BY g.resolved_at DESC, g.id DESC LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM priority_feed_items o WHERE o.tenant_id = f.tenant_id AND o.user_id = f.user_id AND o.dedupe_key = x.dedupe_key
                           AND (o.state IN ('open','snoozed') OR (o.state IN ('done','dismissed') AND o.resolved_by IS DISTINCT FROM 'condition')))`.execute(tx);

    // 3. new occurrences: insert (never over a final close of the same key)
    await sql`${withX}
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, due_at,
                                       score, score_version, reasons, dedupe_key, sort_at, card)
      SELECT app.tenant_id(), x.id, ${userId}, x.item_type, x.band, x.contact_id, x.subject_type, x.subject_id, x.assistant_action_id,
             x.due_at, x.score, x.score_version, x.reasons, x.dedupe_key, x.sort_at, x.card
        FROM x
       WHERE NOT EXISTS (SELECT 1 FROM priority_feed_items o WHERE o.tenant_id = app.tenant_id() AND o.user_id = ${userId} AND o.dedupe_key = x.dedupe_key)
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO NOTHING`.execute(tx);
  }

  // 4. managed cards of the scope the scorer no longer produces: their condition stopped holding
  // (each part of the scope is its own index-driven read: an OR of the two would make Postgres read, and check
  // RLS on, every live card of the member)
  type LiveRow = { id: string; dedupe_key: string; state: string; snoozed_until: Date | null; contact_id: string | null; subject_type: string; subject_id: string };
  const liveCols = sql`SELECT id, dedupe_key, state, snoozed_until, contact_id, subject_type, subject_id FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND state IN ('open','snoozed')`;
  const live = scope
    ? {
        rows: [
          ...(await sql<LiveRow>`${liveCols} AND contact_id = ANY (${[...scope.contactIds]}::uuid[])`.execute(tx)).rows,
          ...(await sql<LiveRow>`${liveCols} AND contact_id IS NULL AND dedupe_key = ANY (${scopeKeys(scope)}::text[])`.execute(tx)).rows,
        ],
      }
    : await sql<LiveRow>`${liveCols}`.execute(tx);
  const computed = new Set(items.map((i) => i.dedupeKey));
  const stale = live.rows.filter((r) => !computed.has(r.dedupe_key) && isManagedKey(r.dedupe_key)).map((r) => r.id);
  if (stale.length > 0) {
    await sql`
      UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${nowIso}::timestamptz, resolved_by = 'condition', updated_at = now()
       WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND id = ANY (${stale}::uuid[])`.execute(tx);
  }
  // a snoozed card of a computed key reopens at its instant (step 1 of a later refresh)
  const wakes = new Map<string, number>();
  for (const r of live.rows) {
    if (r.state !== 'snoozed' || r.snoozed_until === null || !computed.has(r.dedupe_key)) continue;
    const g = groupOfRow(r);
    const t = r.snoozed_until.getTime();
    if (t > now && t < (wakes.get(g) ?? Infinity)) wakes.set(g, t);
  }
  return wakes;
}

/** Stores each group's next change instant (null: only a write can change it); `scope` null = the whole book. */
async function storeGroups(tx: Tx, userId: string, groups: Iterable<string>, next: Map<string, number>, wakes: Map<string, number>, shown: Map<string, number>, now: Instant, scope: 'all' | 'some'): Promise<void> {
  const keys: string[] = [];
  const at: (string | null)[] = [];
  const counts: number[] = [];
  for (const g of new Set([...groups, ...shown.keys()])) {
    if (!/^[ctad]:/.test(g)) continue;
    const t = Math.min(next.get(g) ?? Infinity, wakes.get(g) ?? Infinity);
    keys.push(g);
    at.push(t === Infinity ? null : iso(t));
    counts.push(shown.get(g) ?? 0);
  }
  if (scope === 'all') {
    await sql`DELETE FROM feed_groups WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
    keys.push(RECONCILE_KEY);
    at.push(iso(now + RECONCILE_EVERY_MS));
    counts.push(0);
  } else {
    await sql`DELETE FROM feed_groups WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND group_key = ANY (${keys}::text[])`.execute(tx);
  }
  await sql`
    INSERT INTO feed_groups (tenant_id, user_id, group_key, check_at, n_open)
    SELECT app.tenant_id(), ${userId}, k, a, n FROM unnest(${keys}::text[], ${at}::timestamptz[], ${counts}::int[]) AS u(k, a, n)
     WHERE a IS NOT NULL OR n > 0`.execute(tx);
}

/**
 * Full recompute (BUILD_PLAN interface): core.scoreFeed over the caller's whole RLS-visible book, persisted
 * into priority_feed_items in the caller's transaction, with every group's next change instant. The
 * periodic reconcile and a user's first materialization run this. Returns the cards (feed order, words
 * for `now`).
 */
export async function refreshFeed(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant): Promise<FeedItem[]> {
  await lockUserFeed(tx, actor.userId);
  // marks written before this point are covered by this recompute (see materializeFeed on ordering)
  await sql`DELETE FROM feed_dirty WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}`.execute(tx);
  return fullRefresh(tx, actor, deps, now);
}

async function fullRefresh(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant): Promise<FeedItem[]> {
  const loaded = await loadFeedInputsScoped(tx, actor, deps.envelope, now);
  const items = scoreFeed(loaded.inputs, { labels: 'template' });
  const wakes = await applyCards(tx, actor.userId, deps, items, now, null);
  const groups = new Set([...loaded.nextChange.keys(), ...wakes.keys()]);
  await storeGroups(tx, actor.userId, groups, loaded.nextChange, wakes, await countShown(tx, actor.userId, null), now, 'all');
  return items.map((i) => renderFeedItem(i, now));
}

export interface MaterializeResult {
  mode: 'none' | 'groups' | 'full';
  groups: number;
}

/**
 * Brings one user's materialized feed up to `now` (GET /feed runs it first; the feed.materialize job runs it
 * in the background so GET usually finds nothing to do): re-scores the groups marked dirty since the last
 * run and the groups whose next change instant has come; a user with no materialized state, or whose
 * reconcile is due and `reconcile` is set, gets a full recompute.
 *
 * Ordering: the dirty marks are DELETEd before any input is read, in the same transaction. A write that
 * commits before an input query of this run is seen by it; a write that commits later has its mark
 * inserted after the DELETE (or still uncommitted at the DELETE), so the mark survives for the next run.
 */
export async function materializeFeed(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant, opts: { reconcile?: boolean } = {}): Promise<MaterializeResult> {
  const userId = actor.userId;
  await lockUserFeed(tx, userId);
  const dirty = await sql<{ group_key: string }>`
    DELETE FROM feed_dirty WHERE tenant_id = app.tenant_id() AND user_id = ${userId} RETURNING group_key`.execute(tx);
  const due = await sql<{ group_key: string; check_at: Date }>`
    SELECT group_key, check_at FROM feed_groups
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND (check_at <= ${iso(now)}::timestamptz OR group_key = ${RECONCILE_KEY})`.execute(tx);
  // snoozes that ran out (also when snoozed_until was moved by hand): their groups reopen the card
  const woke = await sql<{ contact_id: string | null; dedupe_key: string; subject_type: string; subject_id: string }>`
    SELECT contact_id, dedupe_key, subject_type, subject_id FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND state = 'snoozed' AND snoozed_until <= ${iso(now)}::timestamptz`.execute(tx);
  const reconcileRow = due.rows.find((r) => r.group_key === RECONCILE_KEY);
  const full = dirty.rows.some((r) => r.group_key === '!full') || reconcileRow === undefined || (opts.reconcile === true && reconcileRow.check_at.getTime() <= now);
  if (full) {
    const items = await fullRefresh(tx, actor, deps, now);
    return { mode: 'full', groups: items.length };
  }
  const groups = new Set<string>();
  for (const r of dirty.rows) groups.add(r.group_key);
  for (const r of due.rows) if (r.group_key !== RECONCILE_KEY) groups.add(r.group_key);
  for (const r of woke.rows) groups.add(groupOfRow(r));
  if (groups.size === 0) return { mode: 'none', groups: 0 };
  const scope = scopeOf(groups);
  const loaded = await loadFeedInputsScoped(tx, actor, deps.envelope, now, scope);
  const items = scoreFeed(loaded.inputs, { labels: 'template' });
  // a row read by id may belong to a group outside the scope (its contact changed in the same write):
  // its card is complete on its own, and that group's own mark brings its other inputs
  const wakes = await applyCards(tx, userId, deps, items, now, scope);
  // groups outside the scope that rows read by id belong to: rescored too (their counts and instants)
  const touched = new Set([...groups, ...loaded.nextChange.keys(), ...wakes.keys(), ...items.map(feedGroupOfItem)]);
  const counted = scopeOf(touched);
  await storeGroups(tx, userId, touched, loaded.nextChange, wakes, await countShown(tx, userId, counted), now, 'some');
  return { mode: 'groups', groups: groups.size };
}

/** The caller's own tap changed a card of `group`: re-score it (its shown count) on the next materialization. */
async function markOwnGroup(tx: Tx, userId: string, group: string): Promise<void> {
  if (!/^[ctad]:/.test(group)) return; // other modules' contactless cards are counted live
  await sql`INSERT INTO feed_dirty (tenant_id, user_id, group_key) VALUES (app.tenant_id(), ${userId}, ${group})`.execute(tx);
}

/** A snoozed card's group wakes when the snooze ends (so the card reopens on time). */
async function wakeGroupAt(tx: Tx, userId: string, group: string, at: Instant): Promise<void> {
  if (!/^[ctad]:/.test(group)) return; // other modules' contactless cards never reopen by the scorer
  await sql`
    INSERT INTO feed_groups (tenant_id, user_id, group_key, check_at) VALUES (app.tenant_id(), ${userId}, ${group}, ${iso(at)}::timestamptz)
    ON CONFLICT (tenant_id, user_id, group_key) DO UPDATE SET check_at = LEAST(COALESCE(feed_groups.check_at, EXCLUDED.check_at), EXCLUDED.check_at)`.execute(tx);
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

/** A stored row as foreignActions reads it: plus the listing of a marketing piece the caller can see. */
export type ForeignRow = Pick<StoredRow, 'item_type' | 'contact_id' | 'subject_type' | 'subject_id' | 'assistant_action_id' | 'dedupe_key'> & {
  /** marketing_review: marketing_pieces.listing_id of the piece in the key (null when not visible) */
  piece_listing_id?: string | null;
};

/**
 * Actions for a card another module wrote under its own key (no scorer item to take them from). The five
 * Phase 2/3 card types get their label and one-tap action from the ids in their key family; any other
 * foreign row (a call summary, a reply-address card ...) keeps the Phase 1 behaviour.
 */
export function foreignActions(r: ForeignRow): { primaryAction: OneTapAction; alternatives: OneTapAction[] } {
  const open: OneTapAction[] = r.contact_id ? [{ kind: 'open_contact', label: 'Open', contactId: r.contact_id as never }] : [];
  const key = parseForeignFeedKey(r.dedupe_key);
  if (key !== null && key.itemType === r.item_type) {
    switch (key.itemType) {
      case 'seller_update':
        return { primaryAction: { kind: 'open_listing', label: 'Open listing', listingId: key.listingId }, alternatives: open };
      case 'marketing_review':
        return r.piece_listing_id
          ? { primaryAction: { kind: 'open_listing', label: 'Open listing', listingId: r.piece_listing_id as never }, alternatives: open }
          : { primaryAction: { kind: 'show_details', label: 'See details' }, alternatives: open };
      case 'weekly_plan':
        return { primaryAction: { kind: 'open_plan', label: 'See the plan', week: key.week }, alternatives: open };
      case 'coaching_fix':
        return { primaryAction: { kind: 'open_coaching_fix', label: 'See the tip' }, alternatives: open };
      case 'likely_to_move':
        return { primaryAction: { kind: 'open_contact', label: 'Open contact', contactId: (r.contact_id ?? key.contactId) as never }, alternatives: [] };
    }
  }
  if (r.assistant_action_id) return { primaryAction: { kind: 'edit_draft', label: 'Review', actionId: r.assistant_action_id as never }, alternatives: open };
  if (r.subject_type === 'task') return { primaryAction: { kind: 'open_task', label: 'Open task', taskId: r.subject_id as never }, alternatives: open };
  if (open[0]) return { primaryAction: open[0], alternatives: [] };
  return { primaryAction: { kind: 'open_contact', label: 'Open', contactId: r.subject_id as never }, alternatives: [] };
}

/** The managed key families as one SQL regular expression (the read path skips managed rows not yet materialized). */
const MANAGED_KEY_SQL = `^(?:${MANAGED_KEY.map((re) => re.source.replace(/^\^/, '').replace(/\$$/, '')).join('|')})$`;

type ReadRow = StoredRow & {
  contact_name: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  piece_listing_id: string | null;
  task_title: string | null;
  card: StoredCard | null;
};

/**
 * GET /feed: bring the materialized feed up to `now` (materializeFeed), then read the top cards in feed order
 * straight from priority_feed_items (core.compareFeedItems as an index order: pinned by due instant, scored by
 * score; ties score / due, then the card's own instant and key), pinned first.
 */
export async function getFeed(tx: Tx, actor: UserActor, deps: FeedDeps, now: Instant): Promise<FeedView> {
  await materializeFeed(tx, actor, deps, now);
  return readFeed(tx, actor, now);
}

/** FROM/WHERE of the cards GET shows (the Phase 1 read's filters), for user `userId`. */
function shownCards(userId: string) {
  return sql`
      FROM priority_feed_items f
      LEFT JOIN contacts c ON c.tenant_id = f.tenant_id AND c.id = f.contact_id
     WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${userId} AND f.state = 'open'
       AND (f.contact_id IS NULL OR (c.id IS NOT NULL AND c.deleted_at IS NULL))
       -- a managed key the materializer has not scored yet is not a card (as the Phase 1 refresh skipped it)
       AND (f.card IS NOT NULL OR f.dedupe_key !~ ${MANAGED_KEY_SQL})
       -- R-PRED-5: only while the card's own model is approved and still flags the contact (RLS: contact detail)
       -- R-PRED-6 (module 50): a person-level do-not-contact contact shows no likely_to_move card, at once (merges: 0018 dnc_follow_merge)
       AND (f.item_type <> 'likely_to_move' OR c.do_not_contact_at IS NULL)
       AND (f.item_type <> 'likely_to_move' OR EXISTS (
             SELECT 1 FROM contact_predictions p JOIN prediction_models m ON m.version = p.model_version
              WHERE p.tenant_id = f.tenant_id AND p.contact_id = f.contact_id AND p.model_version = split_part(f.dedupe_key, ':', 3)
                AND p.band IN ('likely_90d','watch') AND m.status = 'approved'))`;
}

/** The group of a stored row, in SQL (groupOfRow). */
const ROW_GROUP = sql`CASE WHEN f.contact_id IS NOT NULL THEN 'c:' || f.contact_id
                           WHEN f.dedupe_key LIKE 'task:%' THEN 't:' || substr(f.dedupe_key, 6)
                           WHEN f.dedupe_key LIKE 'appt_outcome:%' THEN 'a:' || substr(f.dedupe_key, 14)
                           WHEN f.dedupe_key LIKE 'deal_date:%' THEN 'd:' || substr(f.dedupe_key, 11) END`;

/** Per group of the scope (or the whole book): the materialized cards GET would show (RLS-visible, open). */
async function countShown(tx: Tx, userId: string, scope: FeedScope | null): Promise<Map<string, number>> {
  const count = (part: ReturnType<typeof sql>) => sql<{ g: string | null; n: number }>`SELECT ${ROW_GROUP} AS g, count(*)::int AS n ${shownCards(userId)} AND f.card IS NOT NULL ${part} GROUP BY 1`.execute(tx);
  const rows = scope
    ? [
        ...(await count(sql`AND f.contact_id = ANY (${[...scope.contactIds]}::uuid[])`)).rows,
        ...(await count(sql`AND f.contact_id IS NULL AND f.dedupe_key = ANY (${scopeKeys(scope)}::text[])`)).rows,
      ]
    : (await count(sql``)).rows;
  return new Map(rows.filter((x) => x.g !== null).map((x) => [x.g as string, x.n]));
}

/** The dedupe keys of a scope's contactless groups. */
function scopeKeys(scope: FeedScope): string[] {
  return [...scope.taskIds.map((id) => `task:${id}`), ...scope.appointmentIds.map((id) => `appt_outcome:${id}`), ...scope.dealDateIds.map((id) => `deal_date:${id}`)];
}

/**
 * Pond cards (R-OWN-16) the member may not act on now: the cards of the ponds where their own running totals
 * (claims today against the pond's limit, uncontacted leads against the capacity cap) block a claim. Read with the
 * feed, never stored (leads/claimable.ts). Skipped when the member holds no open pond card.
 */
async function hiddenPondIds(tx: Tx, actor: UserActor, now: Instant): Promise<string[]> {
  const open = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND state = 'open' AND item_type = 'pond_new'`.execute(tx);
  if ((open.rows[0]?.n ?? 0) === 0) return [];
  return blockedPondIds(await claimStatus(tx, actor, now));
}

/** The feed as stored: the top cards in feed order with their wording for `now` (no re-scoring). */
export async function readFeed(tx: Tx, actor: UserActor, now: Instant): Promise<FeedView> {
  const base = shownCards(actor.userId);
  const hidden = await hiddenPondIds(tx, actor, now);
  const pondHidden = sql`(f.item_type = 'pond_new' AND (f.card->'primaryAction'->>'pondId') = ANY (${hidden}::text[]))`;
  const shown = hidden.length > 0 ? sql`${base} AND NOT ${pondHidden}` : base;
  const cols = sql`f.id, f.item_type, f.band, f.contact_id, f.subject_type, f.subject_id, f.assistant_action_id, f.due_at, f.score, f.reasons,
           f.dedupe_key, f.created_at, f.card, c.display_name AS contact_name, c.first_name AS contact_first_name, c.last_name AS contact_last_name,
           (SELECT mp.listing_id FROM marketing_pieces mp WHERE f.item_type = 'marketing_review' AND mp.tenant_id = f.tenant_id
                AND mp.id::text = split_part(f.dedupe_key, ':', 2)) AS piece_listing_id,
           (SELECT t.title FROM tasks t WHERE f.subject_type = 'task' AND t.tenant_id = f.tenant_id AND t.id = f.subject_id) AS task_title`;
  // The feed order is an index order (migration feed_incremental): read it and stop at the limit. Under RLS the
  // planner cannot estimate the policy's filter and may prefer reading every open card and sorting them
  // (measured: 4,787 cards, 0.5 s, against 16 ms); sorting is switched off for these two statements only.
  await sql`SELECT set_config('enable_sort', 'off', true)`.execute(tx);
  const pinned = await sql<ReadRow>`SELECT ${cols} ${shown} AND f.band = 'pinned'
     ORDER BY f.due_at ASC NULLS LAST, f.score DESC, f.sort_at, f.dedupe_key COLLATE "C" LIMIT ${FEED_LIMIT}`.execute(tx);
  const room = FEED_LIMIT - pinned.rows.length;
  const scored = room > 0
    ? await sql<ReadRow>`SELECT ${cols} ${shown} AND f.band = 'scored'
       ORDER BY f.score DESC, f.due_at ASC NULLS LAST, f.sort_at, f.dedupe_key COLLATE "C" LIMIT ${room}`.execute(tx)
    : { rows: [] as ReadRow[] };
  await sql`SELECT set_config('enable_sort', 'on', true)`.execute(tx);
  // total: the materialized cards as counted per group when each was last scored (under the member's RLS),
  // plus the few open cards other modules wrote, counted now, less the pond cards the member's totals hide now
  const total = await sql<{ n: number }>`
    SELECT ((SELECT COALESCE(sum(n_open), 0) FROM feed_groups WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId})
          + (SELECT count(*) ${base} AND f.card IS NULL)
          - ${hidden.length > 0 ? sql`(SELECT count(*) ${base} AND f.card IS NOT NULL AND ${pondHidden})` : sql`0`})::int AS n`.execute(tx);
  const card = (row: ReadRow): FeedCard => {
    const actions = row.card ? { primaryAction: row.card.primaryAction, alternatives: row.card.alternatives } : foreignActions(row);
    // R-PERM-6: a pond card names the lead by first name and last initial, whoever reads it (as GET /ponds/:id/cards)
    const name = row.item_type === 'pond_new' && row.contact_name !== null
      ? maskLastName({ first_name: row.contact_first_name, last_name: row.contact_last_name, display_name: row.contact_name })
      : row.contact_name;
    return {
      id: row.id,
      itemType: row.item_type,
      band: row.band,
      dueAt: row.due_at ? iso(row.due_at) : null,
      contact: row.contact_id && name ? { id: row.contact_id, name } : null,
      task: row.subject_type === 'task' && row.task_title !== null ? { id: row.subject_id, title: row.task_title } : null,
      reasons: row.card ? row.card.reasons.map((r) => ({ code: r.code, label: renderFeedLabel(r.label, now) })) : reasonsOf(row.reasons),
      ...actions,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      assistantActionId: row.assistant_action_id,
      createdAt: iso(row.created_at),
    };
  };
  return { pinned: pinned.rows.map(card), scored: scored.rows.map(card), total: total.rows[0]?.n ?? 0, generatedAt: iso(now) };
}

export type FeedVerb = 'done' | 'snooze' | 'dismiss';

/** POST /feed/:id/{done,snooze,dismiss}: the caller's own card (RLS: own and contact still visible). */
export async function actOnFeedItem(tx: Tx, actor: UserActor, id: string, verb: FeedVerb, now: Instant, until?: Instant): Promise<{ id: string; state: string; snoozedUntil: string | null }> {
  const r = await sql<{ id: string; band: string; state: string; snoozed_until: Date | null; contact_id: string | null; dedupe_key: string; subject_type: string; subject_id: string }>`
    SELECT id, band, state, snoozed_until, contact_id, dedupe_key, subject_type, subject_id FROM priority_feed_items
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
    await wakeGroupAt(tx, actor.userId, groupOfRow(row), until);
    await markOwnGroup(tx, actor.userId, groupOfRow(row));
    return { id, state: 'snoozed', snoozedUntil: iso(until) };
  }
  await sql`UPDATE priority_feed_items SET state = ${target}, snoozed_until = NULL, resolved_at = ${iso(now)}::timestamptz, resolved_by = 'user', updated_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  await markOwnGroup(tx, actor.userId, groupOfRow(row));
  return { id, state: target, snoozedUntil: null };
}

/** Closes the caller's open card of one subject occurrence right away (e.g. after an outcome is logged). */
export async function closeFeedKey(tx: Tx, userId: string, dedupeKey: string, now: Instant): Promise<void> {
  await sql`
    UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${iso(now)}::timestamptz, resolved_by = 'condition', updated_at = now()
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND dedupe_key = ${dedupeKey} AND state IN ('open','snoozed')`.execute(tx);
}
