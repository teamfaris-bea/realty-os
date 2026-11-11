// The incremental Priority Feed equals a full recompute (lane perf-misses; workspace/feed.ts header).
//
// A generated tenant (every input type, real triggers and guards) goes through random event sequences: time
// jumps (also to exactly a stored change instant and 1 ms before it), new client messages and missed calls, a
// person replying, tasks created / re-dated / done / reassigned / moved off their contact, appointments ending
// or getting an outcome, drafts and handbacks approved or dismissed, claims reviewed, contract dates moved or
// completed, opt-outs, the agent's own done / snooze / dismiss taps, and pond leads: a lead released into a pond
// (the real command), claimed or assigned out of it, and a pond's members, cooldown or claims allowance changed
// (journey bug: the feed had no pond leads). After every event, for each member
// under test, the materialized feed (materializeFeed: only dirty and due groups re-scored) is compared with a
// full recompute of the whole book (refreshFeed) run on top of it in a transaction that is rolled back:
//   - the GET /feed view (cards, ids, order, wording, actions, total) is identical;
//   - the full recompute changes no stored card row and no stored change instant.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ContactId, Instant, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import type { OwnershipCommand } from '@realty/core/ownership';
import { type Database, type Tx, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import fc from 'fast-check';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeService } from '../crypto/envelope.js';
import { runOwnershipCommand } from '../leads/ownership.js';
import { addDealContact } from '../workspace/deals.js';
import { type FeedDeps, actOnFeedItem, materializeFeed, readFeed, refreshFeed } from '../workspace/feed.js';
import { createTask } from '../workspace/tasks.js';
import { materializeAll } from './db.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const T = loadUuid('load-big', 'tenant') as TenantId;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: TestDb;
let su: pg.Client;
let app: Database;
let deps: FeedDeps;
let users: { userId: string; role: string }[] = [];
let now = Date.now();
const stats = { events: 0, skipped: 0, compared: 0, cards: 0, incremental: 0 };
const byKind = new Map<string, number>();
/** free text for drafts, including the label template's marker (it must never be read as a token) */
const MARK_TEXT = ['the open house', 'a \uF8F0a123; odd note', '\uF8F0\uF8F0', 'Saturday'];
/** insertable (non-generated) columns of the tables events copy rows of */
const cols = { messages: '', calls: '' };
const seenTypes = new Set<string>();

const actorOf = (u: { userId: string; role: string }): UserActor =>
  ({ kind: 'user', userId: u.userId, tenantId: T, role: u.role, sessionId: 'feed-equivalence' }) as unknown as UserActor;

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

/** Stored state of one member's feed, read as the member (RLS). */
async function storedState(tx: Tx) {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, dedupe_key, state, band, item_type, contact_id, subject_type, subject_id, assistant_action_id, due_at, score, sort_at, card,
           snoozed_until, resolved_at, resolved_by
      FROM priority_feed_items WHERE tenant_id = app.tenant_id() AND user_id = app.user_id() ORDER BY id`.execute(tx);
  const groups = await sql<Record<string, unknown>>`
    SELECT group_key, check_at FROM feed_groups WHERE tenant_id = app.tenant_id() AND user_id = app.user_id() AND group_key <> '~reconcile' ORDER BY group_key`.execute(tx);
  return { rows: rows.rows, groups: groups.rows };
}

/** Materialized (incremental) vs full recompute for one member at `now`. */
async function compare(u: { userId: string; role: string }, label: string): Promise<void> {
  const actor = actorOf(u);
  const at = instant(now) as Instant;
  const inc = await withTenantTx(actor, async (tx) => {
    const r = await materializeFeed(tx, actor, deps, at);
    if (r.mode === 'groups') stats.incremental++;
    return { view: await readFeed(tx, actor, at), state: await storedState(tx) };
  }, { db: app });
  let full: typeof inc | undefined;
  try {
    await withTenantTx(actor, async (tx) => {
      await refreshFeed(tx, actor, deps, at);
      throw new Rollback({ view: await readFeed(tx, actor, at), state: await storedState(tx) });
    }, { db: app });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    full = e.value as typeof inc;
  }
  stats.compared++;
  stats.cards += inc.view.pinned.length + inc.view.scored.length;
  for (const r of inc.state.rows) if (r.state === 'open' && r.card !== null) seenTypes.add(r.item_type as string);
  expect(inc.view, `${label}: view of ${u.role} ${u.userId}`).toEqual(full!.view);
  const diff = (a: Record<string, unknown>[], b: Record<string, unknown>[]) => {
    const key = (r: Record<string, unknown>) => JSON.stringify(r);
    const bs = new Set(b.map(key));
    const as = new Set(a.map(key));
    return { onlyIncremental: a.filter((r) => !bs.has(key(r))), onlyFull: b.filter((r) => !as.has(key(r))) };
  };
  const d = diff(inc.state.rows, full!.state.rows);
  expect(d, `${label}: stored cards of ${u.role} ${u.userId} at ${iso(now)}`).toEqual({ onlyIncremental: [], onlyFull: [] });
  const g = diff(inc.state.groups, full!.state.groups);
  expect(g, `${label}: change instants of ${u.role} ${u.userId} at ${iso(now)}`).toEqual({ onlyIncremental: [], onlyFull: [] });
}

/** Runs owner-connection writes as a person of the tenant (a guard wants a person to move confirmed dates). */
async function asPerson(userId: string, fn: () => Promise<void>): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', 'user', true), set_config('app.principal_type', 'staff', true)`, [T, userId]);
    await fn();
    await su.query('COMMIT');
  } catch (err) {
    await su.query('ROLLBACK');
    throw err;
  }
}

const one = async <R extends Record<string, unknown>>(q: string, p: unknown[]): Promise<R | undefined> => (await su.query<R>(q, p)).rows[0];
const iso = (t: number) => new Date(t).toISOString();

/** Kinds of random events (apply's switch; pond entries and exits are drawn twice as often as the others). */
const EVENT_KINDS = 20;

/**
 * Dates the event that put `contactId` in its pond at the feed's clock. The command ran at the database's clock and
 * wrote its marks; the append-only ledger row is rewritten with triggers off (it marks nothing new), so the card's
 * 24 h window and the releaser's cooldown are measured on the clock the comparisons use.
 */
async function entryAtFeedClock(contactId: string): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query(`SET LOCAL session_replication_role = replica`);
    await su.query(`UPDATE lead_ownership_events SET occurred_at = $3 WHERE tenant_id = $1 AND contact_id = $2
                     AND seq = (SELECT ownership_seq FROM contacts WHERE tenant_id = $1 AND id = $2)`, [T, contactId, iso(now)]);
    await su.query('COMMIT');
  } catch (err) {
    await su.query('ROLLBACK');
    throw err;
  }
}

/** One random event, applied as the database owner (every trigger and guard runs). Returns false when skipped. */
async function apply(e: { kind: number; pick: number; size: number; user: number }): Promise<string> {
  // the agents own the books; contract dates go to their deal's owner and members (the TC among them)
  const u = users[e.user % 3]!;
  const off = (e.pick % 997) + 1;
  const rnd = (n: number) => (e.size * 7919 + e.pick) % n;
  switch (e.kind % EVENT_KINDS) {
    case 0: {
      // time passes: minutes, hours, days; or exactly to a stored change instant (or 1 ms before it)
      const next = await one<{ t: Date }>(`SELECT min(check_at) AS t FROM feed_groups WHERE tenant_id = $1 AND check_at > $2 AND group_key <> '~reconcile'`, [T, iso(now)]);
      const choice = rnd(6);
      if (choice < 2 && next?.t) now = next.t.getTime() - (choice === 0 ? 1 : 0);
      else now += [61_000, HOUR + 1, 4 * HOUR + 7, DAY + 3, 3 * DAY][rnd(5)]!;
      return 'time';
    }
    case 1: {
      // a client texts or emails again (an existing inbound message of one of the member's contacts, copied)
      const src = await one<{ id: string }>(`SELECT m.id FROM messages m JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
         WHERE m.tenant_id = $1 AND m.direction = 'inbound' AND NOT m.imported AND c.owner_user_id = $2 ORDER BY md5(m.id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!src) return 'skip';
      await su.query(`INSERT INTO messages (${cols.messages}) SELECT ${cols.messages.split(', ').map((c) => `(r).${c}`).join(', ')}
                        FROM (SELECT jsonb_populate_record(m, jsonb_build_object('id', gen_random_uuid(), 'occurred_at', $2::timestamptz,
                        'created_at', $2::timestamptz, 'provider_message_ref', NULL, 'idempotency_key', NULL)) AS r FROM messages m WHERE m.id = $1) x`, [src.id, iso(now - rnd(5) * HOUR)]);
      return 'inbound';
    }
    case 2: {
      // a missed call (an existing inbound call copied)
      const src = await one<{ id: string }>(`SELECT k.id FROM calls k JOIN contacts c ON c.tenant_id = k.tenant_id AND c.id = k.contact_id
         WHERE k.tenant_id = $1 AND k.direction = 'inbound' AND c.owner_user_id = $2 ORDER BY md5(k.id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!src) return 'skip';
      await su.query(`INSERT INTO calls (${cols.calls}) SELECT ${cols.calls.split(', ').map((c) => `(r).${c}`).join(', ')}
                        FROM (SELECT jsonb_populate_record(k, jsonb_build_object('id', gen_random_uuid(), 'started_at', $2::timestamptz,
                        'answered_at', NULL, 'status', 'no_answer', 'provider_call_ref', NULL)) AS r FROM calls k WHERE k.id = $1) x`, [src.id, iso(now - rnd(3) * HOUR)]);
      return 'missed_call';
    }
    case 3: {
      // a person replies (the contact's last human touch moves)
      const c = await one<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND owner_user_id = $2 ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!c) return 'skip';
      await su.query(`UPDATE contacts SET last_human_touch_at = $2 WHERE tenant_id = $1 AND id = $3`, [T, iso(now - rnd(4) * 60_000), c.id]);
      return 'touch';
    }
    case 4: {
      // a task is re-dated (around now, so it crosses the 24 h / 1 h / due / overdue-a-day edges)
      const t = await one<{ id: string }>(`SELECT id FROM tasks WHERE tenant_id = $1 AND assignee_user_id = $2 ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!t) return 'skip';
      await su.query(`UPDATE tasks SET due_at = $2, status = 'open', completed_at = NULL WHERE tenant_id = $1 AND id = $3`, [T, iso(now + (rnd(9) - 4) * 13 * HOUR + rnd(7) * 60_000), t.id]);
      return 'task_due';
    }
    case 5: {
      // a task is done, or reopened, or handed to another member, or moved off its contact
      const t = await one<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE tenant_id = $1 AND assignee_user_id = $2 ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!t) return 'skip';
      const v = rnd(3);
      if (v === 0) await su.query(`UPDATE tasks SET status = CASE WHEN status = 'open' THEN 'done' ELSE 'open' END, completed_at = CASE WHEN status = 'open' THEN $2::timestamptz END WHERE tenant_id = $1 AND id = $3`, [T, iso(now), t.id]);
      else if (v === 1) await su.query(`UPDATE tasks SET assignee_user_id = $2 WHERE tenant_id = $1 AND id = $3`, [T, users[(e.user + 1) % users.length]!.userId, t.id]);
      else await su.query(`UPDATE tasks SET contact_id = NULL WHERE tenant_id = $1 AND id = $2`, [T, t.id]);
      return 'task_change';
    }
    case 6: {
      // an appointment ends now-ish, or gets its outcome
      const a = await one<{ id: string }>(`SELECT id FROM appointments WHERE tenant_id = $1 AND user_id = $2 ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!a) return 'skip';
      if (rnd(3) === 0) await su.query(`UPDATE appointments SET outcome_logged_at = $2, outcome_logged_by_user_id = $4 WHERE tenant_id = $1 AND id = $3`, [T, iso(now), a.id, u.userId]);
      else await su.query(`UPDATE appointments SET starts_at = $2::timestamptz - interval '1 hour', ends_at = $2, status = 'scheduled', outcome = NULL, outcome_logged_at = NULL, outcome_logged_by_user_id = NULL WHERE tenant_id = $1 AND id = $3`, [T, iso(now + (rnd(5) - 3) * HOUR), a.id]);
      return 'appointment';
    }
    case 7: {
      // the assistant's proposal is handled (draft or handback leaves 'proposed')
      const a = await one<{ id: string }>(`SELECT id FROM assistant_actions WHERE tenant_id = $1 AND owner_user_id = $2 AND status = 'proposed' ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!a) return 'skip';
      if (rnd(2) === 0) await su.query(`UPDATE assistant_actions SET status = 'rejected', decided_at = $2, decided_by_user_id = $3, decided_by_role = 'agent' WHERE tenant_id = $1 AND id = $4`, [T, iso(now), u.userId, a.id]);
      else await su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = $1 AND id = $2`, [T, a.id]);
      return 'action';
    }
    case 8: {
      // a claim gets reviewed (a draft's "check this", a promise's evidence)
      const c = await one<{ id: string }>(`SELECT cl.id FROM assistant_claims cl JOIN assistant_actions a ON a.tenant_id = cl.tenant_id AND a.id = cl.action_id
         WHERE cl.tenant_id = $1 AND a.owner_user_id = $2 AND cl.review_status = 'unreviewed' ORDER BY md5(cl.id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!c) return 'skip';
      await su.query(`UPDATE assistant_claims SET review_status = 'confirmed', reviewed_at = $2, reviewed_by_user_id = $3 WHERE tenant_id = $1 AND id = $4`, [T, iso(now), u.userId, c.id]);
      return 'claim';
    }
    case 9: {
      // a contract date moves (around today in the tenant's zone) or is completed, by the deal's owner
      const d = await one<{ id: string; owner: string }>(`SELECT dd.id, d.owner_user_id AS owner FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
         WHERE dd.tenant_id = $1 ORDER BY md5(dd.id::text || $2) LIMIT 1`, [T, String(off)]);
      if (!d) return 'skip';
      await asPerson(d.owner, async () => {
        if (rnd(4) === 0) await su.query(`UPDATE deal_dates SET completed_at = $2 WHERE tenant_id = $1 AND id = $3`, [T, iso(now), d.id]);
        else await su.query(`UPDATE deal_dates SET due_on = (($2::timestamptz AT TIME ZONE 'America/New_York')::date + $3::int), completed_at = NULL WHERE tenant_id = $1 AND id = $4`, [T, iso(now), rnd(8) - 3, d.id]);
      });
      return 'deal_date';
    }
    case 10: {
      // an opt-out on one of the member's contacts' addresses (the channel hint of the card changes)
      const p = await one<{ address_hmac: Buffer; kind: string }>(`SELECT p.address_hmac, p.kind FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
         WHERE p.tenant_id = $1 AND c.owner_user_id = $2 AND p.removed_at IS NULL ORDER BY md5(p.id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!p) return 'skip';
      await su.query(`INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref)
                      VALUES ($1, gen_random_uuid(), $2, $3, 'x', 'all', 'internal_dnc', '{}'::jsonb)`, [T, p.kind, p.address_hmac]);
      return 'suppression';
    }
    case 11:
    case 12: {
      // the member taps done / dismiss / snooze on one of their cards (as themselves, through the API's code)
      const actor = actorOf(u);
      const card = await withTenantTx(actor, async (tx) => {
        const v = await readFeed(tx, actor, instant(now) as Instant);
        const all = [...v.pinned, ...v.scored].filter((c) => c.band === 'scored');
        return all[off % Math.max(1, all.length)];
      }, { db: app });
      if (!card) return 'skip';
      const verb = (['done', 'dismiss', 'snooze'] as const)[rnd(3)]!;
      await withTenantTx(actor, (tx) => actOnFeedItem(tx, actor, card.id, verb, instant(now) as Instant, verb === 'snooze' ? (instant(now + (rnd(4) + 1) * HOUR) as Instant) : undefined), { db: app });
      return `tap_${verb}`;
    }
    case 13: {
      // the assistant proposes: a reply draft (sometimes with a detail to check) or a handback with its reply
      const c = await one<{ id: string; m: string | null }>(`SELECT c.id, (SELECT m.id FROM messages m WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND m.direction = 'inbound'
           ORDER BY m.occurred_at DESC LIMIT 1) AS m FROM contacts c WHERE c.tenant_id = $1 AND c.owner_user_id = $2 ORDER BY md5(c.id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!c) return 'skip';
      const handback = rnd(3) === 0 && c.m !== null;
      const id = (await one<{ id: string }>(`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, created_at)
        VALUES ($1, gen_random_uuid(), $2, $3, 'novel_message', 'requires_approval', 'proposed', $4, $5, $6::jsonb, $7) RETURNING id`,
        [T, c.id, handback ? 'handback' : 'message_draft', u.userId, `They asked about ${MARK_TEXT[rnd(MARK_TEXT.length)]}`,
         JSON.stringify(handback ? { inboundMessageId: c.m, draft: { body: 'Happy to help' } } : { channel: rnd(2) === 0 ? 'sms' : 'email' }), iso(now - rnd(90) * 60_000)]))!.id;
      if (!handback && rnd(2) === 0) await su.query(`INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review, review_status) VALUES ($1, gen_random_uuid(), $2, 0, 'fact', 'They want 3 beds', true, 'unreviewed')`, [T, id]);
      return handback ? 'handback' : 'draft';
    }
    case 15:
    case 18: {
      // a lead goes to a pond: its owner releases it (the real command), to the default pond or a team pond they may
      // use; the entry is then dated at the feed's clock (the ledger is append-only: rewritten with triggers off,
      // after the command's own marks were written), so the card's 24 h window and cooldown live on that clock
      const c = await one<{ id: string; owner: string; role: string }>(`SELECT c.id, c.owner_user_id AS owner, m.role FROM contacts c
         JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id
        WHERE c.tenant_id = $1 AND c.ownership_state = 'owned' AND c.deleted_at IS NULL AND m.role IN ('agent','team_lead') AND m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id)
        ORDER BY md5(c.id::text || $2) LIMIT 1`, [T, String(off)]);
      if (!c) return 'skip';
      // a pond the owner may release into: the default pond, or a team pond that names them
      const ponds = (await su.query<{ id: string; is_default: boolean }>(`SELECT p.id, p.is_default FROM ponds p WHERE p.tenant_id = $1 AND p.archived_at IS NULL
          AND (p.is_default OR EXISTS (SELECT 1 FROM pond_members pm WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id AND pm.user_id = $2))
        ORDER BY p.is_default DESC, p.id`, [T, c.owner])).rows;
      const pond = ponds[rnd(ponds.length)]!;
      const r = await runOwnershipCommand(actorOf({ userId: c.owner, role: c.role }), c.id as ContactId, { kind: 'release', reason: 'not_a_fit', ...(pond.is_default ? {} : { toPondId: pond.id as never }) }, randomUUID(), undefined, { db: app, ids: deps.ids });
      if (!r.ok) return 'skip';
      await entryAtFeedClock(c.id);
      return 'pond_release';
    }
    case 16:
    case 19: {
      // a pond lead leaves its pond: a member under test claims it (the claim rules read the database's clock; a
      // refusal changes nothing), else the Owner assigns it; recent entries first, so live cards are in play
      const c = await one<{ id: string; pond: string }>(`SELECT c.id, c.pond_id AS pond FROM contacts c
          JOIN lead_ownership_events e ON e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.seq = c.ownership_seq
         WHERE c.tenant_id = $1 AND c.ownership_state = 'in_pond' AND c.deleted_at IS NULL
         ORDER BY e.occurred_at > $2::timestamptz DESC, md5(c.id::text || $3) LIMIT 1`, [T, iso(now - DAY), String(off)]);
      if (!c) return 'skip';
      const claimer = users[e.user % users.length]!;
      if (claimer.role !== 'tc' && rnd(3) > 0) {
        const r = await runOwnershipCommand(actorOf(claimer), c.id as ContactId, { kind: 'claim', pondId: c.pond as never }, randomUUID(), undefined, { db: app, ids: deps.ids });
        if (r.ok) return 'pond_claim';
      }
      const owner = (await su.query<{ userId: string; role: string }>(`SELECT user_id AS "userId", role FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [T])).rows[0]!;
      const to = users.filter((u) => u.role === 'agent')[rnd(3)]!;
      const r = await runOwnershipCommand(actorOf(owner), c.id as ContactId, { kind: 'assign', toUserId: to.userId as UserId, reason: 'MANUAL_ASSIGN' }, randomUUID(), undefined, { db: app, ids: deps.ids });
      return r.ok ? 'pond_assign' : 'skip';
    }
    case 17: {
      // who may claim from a pond changes (as the Owner would): a member under test joins or leaves a team pond, a
      // pond's cooldown moves between 0 and 2 h, or a pond stops or starts allowing claims
      const ponds = (await su.query<{ id: string; is_default: boolean; claims_per_day: number; claim_cooldown_hours: number }>(
        `SELECT id, is_default, claims_per_day, claim_cooldown_hours FROM ponds WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY is_default DESC, id`, [T])).rows;
      const pond = ponds[rnd(ponds.length)]!;
      const v = rnd(3);
      if (v === 0 && !pond.is_default) {
        const u = users[e.user % users.length]!;
        if (u.role === 'tc') return 'skip';
        const del = await su.query(`DELETE FROM pond_members WHERE tenant_id = $1 AND pond_id = $2 AND user_id = $3`, [T, pond.id, u.userId]);
        if (del.rowCount === 0) await su.query(`INSERT INTO pond_members (tenant_id, pond_id, user_id) VALUES ($1, $2, $3)`, [T, pond.id, u.userId]);
      } else if (v === 1) {
        await su.query(`UPDATE ponds SET claim_cooldown_hours = $3 WHERE tenant_id = $1 AND id = $2`, [T, pond.id, pond.claim_cooldown_hours === 0 ? 2 : 0]);
      } else {
        await su.query(`UPDATE ponds SET claims_per_day = $3 WHERE tenant_id = $1 AND id = $2`, [T, pond.id, pond.claims_per_day === 0 ? 50 : 0]);
      }
      return 'pond_config';
    }
    default: {
      // a member edits a contact (any contact write marks: updated_at is an offer card's instant)
      const c = await one<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND (owner_user_id = $2 OR offered_to_user_id = $2) ORDER BY md5(id::text || $3) LIMIT 1`, [T, u.userId, String(off)]);
      if (!c) return 'skip';
      await su.query(`UPDATE contacts SET display_name = display_name || '' , updated_at = $2 WHERE tenant_id = $1 AND id = $3`, [T, iso(now), c.id]);
      return 'contact_edit';
    }
  }
}

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(1_500, PH);
  spec.tenants = spec.tenants.slice(0, 1);
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  app = createDatabase({ url: db.appUserUrl, max: 4, applicationName: 'feed-equivalence' });
  const clock = { now: () => instant(Date.now()) };
  deps = { envelope: new EnvelopeService(kekFromEnv()), ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))) };
  // the members under test: the three busiest agents, the TC (contract dates) and a team lead
  users = (await su.query<{ userId: string; role: string }>(`
    (SELECT m.user_id AS "userId", m.role FROM memberships m JOIN contacts c ON c.tenant_id = m.tenant_id AND c.owner_user_id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'agent' GROUP BY m.user_id, m.role ORDER BY count(*) DESC LIMIT 3)
    UNION ALL (SELECT user_id, role FROM memberships WHERE tenant_id = $1 AND role IN ('tc','team_lead') ORDER BY role, user_id LIMIT 2)`, [T])).rows;
  for (const t of ['messages', 'calls'] as const) {
    cols[t] = (await su.query<{ c: string }>(`SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS c FROM pg_attribute
       WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`, [t])).rows[0]!.c;
  }
  // contract dates (the generator makes none): two confirmed dates on each of 40 active deals, entered by the deal's owner
  const deals = (await su.query<{ id: string; owner: string }>(`SELECT id, owner_user_id AS owner FROM deals WHERE tenant_id = $1 AND stage NOT IN ('closed','lost') AND owner_user_id IS NOT NULL ORDER BY id LIMIT 40`, [T])).rows;
  for (const [i, d] of deals.entries()) {
    await asPerson(d.owner, async () => {
      await su.query(`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, status, source, confirmed_by_user_id, confirmed_at)
        SELECT $1, gen_random_uuid(), $2, k, (now() AT TIME ZONE 'America/New_York')::date + $4::int + o, 'confirmed', 'manual', $3, now()
          FROM (VALUES ('inspection', 0), ('closing', 6)) v(k, o)`, [T, d.id, d.owner, (i % 7) - 3]);
    });
  }
  // assistant proposals (the generator makes none): drafts (half with a detail to check) and handbacks per agent
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 6; j++) {
      await apply({ kind: 13, pick: 1_000 * i + j, size: j, user: i }); // event 13: the assistant proposes
    }
  }
  // the worker caught up after the bulk load
  await materializeAll(app, deps.envelope, [T]);
}, 600_000);
afterAll(async () => {
  await app?.close();
  await su?.end();
  await db?.drop();
});

describe('incremental feed equals a full recompute (lane perf-misses)', () => {
  it('the members under test have busy feeds of every kind', async () => {
    expect(users.map((u) => u.role).sort()).toEqual(['agent', 'agent', 'agent', 'tc', 'team_lead']);
    const kinds = (await su.query<{ item_type: string }>(`SELECT DISTINCT item_type FROM priority_feed_items WHERE tenant_id = $1 AND state = 'open'`, [T])).rows.map((r) => r.item_type);
    for (const k of ['unanswered_inbound', 'missed_call', 'task_due', 'appointment_outcome', 'first_touch_due']) expect(kinds, k).toContain(k);
    for (const u of users) await compare(u, 'after the bulk load');
  }, 300_000);

  it('after every event of random event sequences, the materialized feed is what a full recompute gives', async () => {
    const event = fc.record({ kind: fc.nat(1_000), pick: fc.nat(100_000), size: fc.nat(1_000), user: fc.nat(100) });
    await fc.assert(
      fc.asyncProperty(fc.array(event, { minLength: 25, maxLength: 25 }), async (events) => {
        for (const [i, e] of events.entries()) {
          let what: string;
          try {
            what = await apply(e);
          } catch (err) {
            // a guard refused this synthetic write (it would never be issued by the app): nothing changed
            what = `refused: ${(err as Error).message.slice(0, 60)}`;
          }
          if (what === 'skip' || what.startsWith('refused')) stats.skipped++;
          else stats.events++;
          const k = what.startsWith('refused') ? what : `${e.kind % EVENT_KINDS}:${what}`;
          byKind.set(k, (byKind.get(k) ?? 0) + 1);
          for (const u of users) await compare(u, `event ${i} (${what})`);
        }
      }),
      { numRuns: Number(process.env.FEED_EQ_RUNS ?? 4), endOnFailure: true, ...(process.env.FEED_EQ_SEED ? { seed: Number(process.env.FEED_EQ_SEED) } : {}) },
    );
    console.log(JSON.stringify({ stats, byKind: Object.fromEntries(byKind), seenTypes: [...seenTypes] }));
    // the comparison is not vacuous: most events applied, cards of every kind were shown, and groups were re-scored incrementally
    expect(stats.events).toBeGreaterThan(0.6 * 25 * Number(process.env.FEED_EQ_RUNS ?? 4));
    for (const k of ['unanswered_inbound', 'missed_call', 'task_due', 'appointment_outcome', 'first_touch_due', 'deal_date', 'assistant_draft', 'handback', 'pond_new']) expect([...seenTypes], k).toContain(k);
    // pond leads were in play: released into ponds, and claimed or assigned out of them
    expect([...byKind.keys()].filter((k) => /pond_release$/.test(k)).length, JSON.stringify(Object.fromEntries(byKind))).toBeGreaterThan(0);
    expect([...byKind.keys()].filter((k) => /pond_(claim|assign)$/.test(k)).length, JSON.stringify(Object.fromEntries(byKind))).toBeGreaterThan(0);
    expect(stats.cards).toBeGreaterThan(1_000);
    expect(stats.incremental).toBeGreaterThan(50);
  }, 1_800_000);
});

// Writes that change WHO can hold a card on a contact, not only its owner (scale-lane review fixes): a member's own
// task, appointment or assistant action names a contact whatever its owner (feedInputs.ts), and the member's card is
// written and counted only while that contact is visible to them. A reassignment, a merge, a person added to or
// removed from a deal, a deal's primary person and a team move change that visibility for a Team Lead or a TC who
// holds such a card; each must mark them. And two marks that were wrong: a deleted contact point (an import revert)
// marked nothing, and every settings write (stage labels, batch text, Gmail sync) marked every member '!full'.
describe('incremental feed after ownership, deal, team, contact point and settings writes (scale-lane review fixes)', () => {
  type Member = { userId: string; role: string };
  const used: string[] = [];
  const dueIn = (h: number) => new Date(now + h * HOUR).toISOString();
  const marks = async (userId: string, group: string) =>
    Number((await su.query<{ n: string }>(`SELECT count(*) AS n FROM feed_dirty WHERE tenant_id = $1 AND user_id = $2 AND group_key = $3`, [T, userId, group])).rows[0]!.n);
  const asMember = <R>(m: Member, fn: (tx: Tx) => Promise<R>) => withTenantTx(actorOf(m), fn, { db: app });
  /** an owned lead of one of `owners`, on no deal and with no collaborator (visibility only through its owner) */
  const pickLead = async (owners: string[]) => {
    const c = (await su.query<{ id: string; owner: string }>(`
      SELECT c.id, c.owner_user_id AS owner FROM contacts c
       WHERE c.tenant_id = $1 AND c.ownership_state = 'owned' AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
         AND c.owner_user_id = ANY ($2::uuid[]) AND NOT (c.id = ANY ($3::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM contact_collaborators k WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id)
       ORDER BY md5(c.id::text) LIMIT 1`, [T, owners, used])).rows[0]!;
    used.push(c.id);
    return c;
  };
  /** a task of `assignee` on `contactId`, due in 2 h of the feed's clock, created through the API's code by `by` */
  const taskFor = (by: Member, contactId: string, assignee: Member) =>
    asMember(by, (tx) => createTask(tx, actorOf(by), deps.ids, { title: 'Call them back', kind: 'callback', dueAt: dueIn(2), contactId, assigneeUserId: assignee.userId }));
  const command = async (by: Member, contactId: string, cmd: OwnershipCommand) => {
    const r = await runOwnershipCommand(actorOf(by), contactId as ContactId, cmd, randomUUID(), undefined, { db: app, ids: deps.ids });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  };
  const visibleTo = (m: Member, contactId: string) =>
    asMember(m, async (tx) => (await sql<{ v: boolean }>`SELECT EXISTS (SELECT 1 FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}) AS v`.execute(tx)).rows[0]!.v);

  let owner: Member;
  let tl: Member;
  let tc: Member;
  let tlTeam = '';
  let inside: string[] = [];
  let outside: string[] = [];
  beforeAll(async () => {
    owner = (await su.query<Member>(`SELECT user_id AS "userId", role FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [T])).rows[0]!;
    tl = users.find((u) => u.role === 'team_lead')!;
    tc = users.find((u) => u.role === 'tc')!;
    tlTeam = (await su.query<{ team_id: string }>(`SELECT team_id FROM team_members WHERE tenant_id = $1 AND user_id = $2 AND is_lead`, [T, tl.userId])).rows[0]!.team_id;
    const agents = (await su.query<{ user_id: string; mine: boolean }>(`
      SELECT m.user_id, EXISTS (SELECT 1 FROM team_members x WHERE x.tenant_id = m.tenant_id AND x.team_id = $2 AND x.user_id = m.user_id) AS mine
        FROM memberships m WHERE m.tenant_id = $1 AND m.role = 'agent' AND m.status = 'active' ORDER BY m.user_id`, [T, tlTeam])).rows;
    inside = agents.filter((a) => a.mine).map((a) => a.user_id);
    outside = agents.filter((a) => !a.mine).map((a) => a.user_id);
    expect(inside.length).toBeGreaterThan(1);
    expect(outside.length).toBeGreaterThan(1);
  });

  it('a reassignment into or out of a team, and a merge, mark the Team Lead who holds a task on the lead', async () => {
    // into the team: the Owner gave the Team Lead a task on an outside agent's lead (hidden from them until now)
    const x = await pickLead(outside);
    await taskFor(owner, x.id, tl);
    expect(await visibleTo(tl, x.id)).toBe(false);
    await compare(tl, 'a Team Lead task on an outside lead');
    await command(owner, x.id, { kind: 'reassign', toUserId: inside[0] as UserId, reason: 'MANUAL_REASSIGN' });
    expect(await visibleTo(tl, x.id)).toBe(true);
    expect(await marks(tl.userId, `c:${x.id}`)).toBeGreaterThan(0);
    await compare(tl, 'reassigned into the Team Lead\'s team');
    // out of the team: the Team Lead's own task on a team member's lead
    const z = await pickLead([inside[1]!]);
    await taskFor(tl, z.id, tl);
    await compare(tl, 'a Team Lead task on a team lead');
    await command(owner, z.id, { kind: 'reassign', toUserId: outside[0] as UserId, reason: 'MANUAL_REASSIGN' });
    expect(await visibleTo(tl, z.id)).toBe(false);
    expect(await marks(tl.userId, `c:${z.id}`)).toBeGreaterThan(0);
    await compare(tl, 'reassigned out of the Team Lead\'s team');
    // merge: a team lead (with the Team Lead's task) merged into an outside agent's lead; the loser closes, unowned
    const loser = await pickLead([inside[0]!]);
    const survivor = await pickLead([outside[1]!]);
    await taskFor(tl, loser.id, tl);
    await compare(tl, 'a Team Lead task on the lead about to be merged away');
    await command(owner, survivor.id, { kind: 'merge', survivorId: survivor.id as ContactId, loserId: loser.id as ContactId, ownerChoice: survivor.owner as UserId });
    expect(await visibleTo(tl, loser.id)).toBe(false);
    expect(await marks(tl.userId, `c:${loser.id}`)).toBeGreaterThan(0);
    await compare(tl, 'merged into an outside lead');
  }, 300_000);

  it('a person added to or removed from a deal, and a deal\'s primary person, mark the deal\'s TC who holds a task on them', async () => {
    const deals = (await su.query<{ id: string; owner: string; stage: string; primary: string }>(`
      SELECT d.id, d.owner_user_id AS owner, d.stage, d.primary_contact_id AS primary FROM deals d
        JOIN deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id AND dm.user_id = $2
        JOIN memberships m ON m.tenant_id = d.tenant_id AND m.user_id = d.owner_user_id AND m.role = 'agent'
       WHERE d.tenant_id = $1 ORDER BY d.stage = 'closed' DESC, d.id`, [T, tc.userId])).rows;
    const open = deals.find((d) => d.stage !== 'closed')!;
    const closed = deals.find((d) => d.stage === 'closed')!;
    expect(open && closed).toBeTruthy();
    const dealOwner = { userId: open.owner, role: 'agent' };
    // a person added to the deal (POST /deals/:id/contacts), then removed again (the erasure path's removal)
    const y = await pickLead([open.owner]);
    await taskFor(owner, y.id, tc);
    expect(await visibleTo(tc, y.id)).toBe(false);
    await compare(tc, 'a TC task on a lead of the deal owner');
    await asMember(dealOwner, (tx) => addDealContact(tx, open.id, y.id, 'co_buyer'));
    expect(await visibleTo(tc, y.id)).toBe(true);
    expect(await marks(tc.userId, `c:${y.id}`)).toBeGreaterThan(0);
    await compare(tc, 'added to the TC\'s deal');
    await asMember(dealOwner, (tx) => sql`DELETE FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${open.id} AND contact_id = ${y.id}`.execute(tx));
    expect(await visibleTo(tc, y.id)).toBe(false);
    expect(await marks(tc.userId, `c:${y.id}`)).toBeGreaterThan(0);
    await compare(tc, 'removed from the TC\'s deal');
    // the primary person of a closed deal: the Owner removes them (as erasure does), then names another person
    const q = await pickLead([closed.owner]);
    await taskFor(owner, closed.primary, tc);
    await taskFor(owner, q.id, tc);
    await asMember(owner, (tx) => sql`DELETE FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${closed.id} AND contact_id = ${closed.primary}`.execute(tx));
    await compare(tc, 'the primary person stays visible through the deal');
    await asMember(owner, (tx) => sql`UPDATE deals SET primary_contact_id = NULL, row_version = row_version + 1 WHERE tenant_id = app.tenant_id() AND id = ${closed.id}`.execute(tx));
    expect(await visibleTo(tc, closed.primary)).toBe(false);
    expect(await marks(tc.userId, `c:${closed.primary}`)).toBeGreaterThan(0);
    await compare(tc, 'the primary person removed from the deal');
    await asMember(owner, (tx) => sql`UPDATE deals SET primary_contact_id = ${q.id}, row_version = row_version + 1 WHERE tenant_id = app.tenant_id() AND id = ${closed.id}`.execute(tx));
    expect(await visibleTo(tc, q.id)).toBe(true);
    expect(await marks(tc.userId, `c:${q.id}`)).toBeGreaterThan(0);
    await compare(tc, 'a new primary person');
  }, 300_000);

  it('a member leaving or joining a team marks the team\'s lead for a whole-book recompute', async () => {
    const mover = inside.at(-1)!;
    const k = await pickLead([mover]);
    await taskFor(tl, k.id, tl);
    await compare(tl, 'a Team Lead task on a team member\'s lead');
    await asMember(owner, (tx) => sql`DELETE FROM team_members WHERE tenant_id = app.tenant_id() AND team_id = ${tlTeam} AND user_id = ${mover}`.execute(tx));
    expect(await visibleTo(tl, k.id)).toBe(false);
    expect(await marks(tl.userId, '!full')).toBeGreaterThan(0);
    await compare(tl, 'the member left the team');
    await asMember(owner, (tx) => sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (app.tenant_id(), ${tlTeam}, ${mover}, false)`.execute(tx));
    expect(await visibleTo(tl, k.id)).toBe(true);
    expect(await marks(tl.userId, '!full')).toBeGreaterThan(0);
    await compare(tl, 'the member joined the team again');
  }, 300_000);

  it('a lead entering and leaving a pond marks every member who may claim from it, and a pond\'s members or settings mark them for a whole-book recompute (journey bug: no pond leads in the feed)', async () => {
    const agents = users.filter((u) => u.role === 'agent');
    const pondCard = async (m: Member, contactId: string) =>
      (await su.query<{ state: string }>(`SELECT state FROM priority_feed_items WHERE tenant_id = $1 AND user_id = $2 AND contact_id = $3 AND item_type = 'pond_new'
                                          ORDER BY created_at DESC LIMIT 1`, [T, m.userId, contactId])).rows[0]?.state ?? null;
    // the random sequences may have stopped a pond's claims, moved its cooldown or a member: back to the generator's
    // settings (claims allowed, no cooldown), the Team Lead in their team's pond (the marks make it a full recompute)
    const teamPond = (await su.query<{ id: string }>(`SELECT p.id FROM ponds p JOIN pond_members pm ON pm.tenant_id = p.tenant_id AND pm.pond_id = p.id
       WHERE p.tenant_id = $1 AND NOT p.is_default AND pm.user_id = $2 ORDER BY p.id LIMIT 1`, [T, inside.find((id) => !users.some((u) => u.userId === id))!])).rows[0]!.id;
    await asMember(owner, async (tx) => {
      await sql`UPDATE ponds SET claims_per_day = 50, claim_cooldown_hours = 0 WHERE tenant_id = app.tenant_id()`.execute(tx);
      await sql`INSERT INTO pond_members (tenant_id, pond_id, user_id) VALUES (app.tenant_id(), ${teamPond}, ${tl.userId}) ON CONFLICT DO NOTHING`.execute(tx);
    });
    for (const u of users) await compare(u, 'ponds back to the generator\'s settings');
    // a lead of an agent who is not under test, released into the default pond (open to every agent and lead)
    const x = await pickLead(outside.filter((id) => !users.some((u) => u.userId === id)));
    await command({ userId: x.owner, role: 'agent' }, x.id, { kind: 'release', reason: 'not_a_fit' });
    for (const u of [...agents, tl]) expect(await marks(u.userId, `c:${x.id}`), `${u.role} ${u.userId} marked on entry`).toBeGreaterThan(0);
    expect(await marks(tc.userId, `c:${x.id}`), 'a TC never claims').toBe(0);
    await entryAtFeedClock(x.id);
    for (const u of users) await compare(u, 'released into the default pond');
    for (const u of [...agents, tl]) expect(await pondCard(u, x.id), `${u.role} ${u.userId} has the pond card`).toBe('open');
    // assigned out of the pond by the Owner to an agent of the Team Lead's team: everyone who could claim it is marked,
    // and the Team Lead (who still sees the lead) has the card closed, not merely hidden
    await command(owner, x.id, { kind: 'assign', toUserId: inside[0] as UserId, reason: 'MANUAL_ASSIGN' });
    for (const u of [...agents, tl]) expect(await marks(u.userId, `c:${x.id}`), `${u.role} ${u.userId} marked on exit`).toBeGreaterThan(0);
    expect(await visibleTo(tl, x.id)).toBe(true);
    for (const u of users) await compare(u, 'assigned out of the pond');
    expect(await pondCard(tl, x.id)).toBe('done');
    // a team pond: the Team Lead leaving its member list, then the pond allowing no claims
    const y = await pickLead(inside.filter((id) => !users.some((u) => u.userId === id)));
    await command({ userId: y.owner, role: 'agent' }, y.id, { kind: 'release', reason: 'not_a_fit', toPondId: teamPond as never });
    await entryAtFeedClock(y.id);
    for (const u of users) await compare(u, 'released into a team pond');
    expect(await pondCard(tl, y.id)).toBe('open');
    await asMember(owner, (tx) => sql`DELETE FROM pond_members WHERE tenant_id = app.tenant_id() AND pond_id = ${teamPond} AND user_id = ${tl.userId}`.execute(tx));
    expect(await marks(tl.userId, '!full')).toBeGreaterThan(0);
    for (const u of users) await compare(u, 'the Team Lead left the team pond');
    await asMember(owner, (tx) => sql`INSERT INTO pond_members (tenant_id, pond_id, user_id) VALUES (app.tenant_id(), ${teamPond}, ${tl.userId})`.execute(tx));
    expect(await marks(tl.userId, '!full')).toBeGreaterThan(0);
    for (const u of users) await compare(u, 'the Team Lead joined the team pond again');
    expect(await pondCard(tl, y.id)).toBe('open');
    await asMember(owner, (tx) => sql`UPDATE ponds SET claims_per_day = 0 WHERE tenant_id = app.tenant_id() AND id = ${teamPond}`.execute(tx));
    expect(await marks(tl.userId, '!full')).toBeGreaterThan(0);
    for (const u of users) await compare(u, 'the team pond allows no claims');
    expect(await pondCard(tl, y.id)).toBe('done');
    await asMember(owner, (tx) => sql`UPDATE ponds SET claims_per_day = 50 WHERE tenant_id = app.tenant_id() AND id = ${teamPond}`.execute(tx));
    for (const u of users) await compare(u, 'the team pond allows claims again');
  }, 300_000);

  it('a contact point removed by an import revert marks its contact (the card\'s channels change)', async () => {
    const agent = users[0]!;
    // a person of the agent's with a materialized card and no phone; an import adds one, then is reverted
    const c = (await su.query<{ id: string }>(`
      SELECT c.id FROM contacts c WHERE c.tenant_id = $1 AND c.owner_user_id = $2 AND c.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM priority_feed_items f WHERE f.tenant_id = c.tenant_id AND f.user_id = $2 AND f.contact_id = c.id AND f.state = 'open' AND f.card IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.kind = 'phone')
       ORDER BY md5(c.id::text) LIMIT 1`, [T, agent.userId])).rows[0]!;
    expect(c).toBeDefined();
    const batch = randomUUID();
    const stage = randomUUID();
    const point = randomUUID();
    await su.query(`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1, $2, 'csv', 'committed', $3, $4)`,
      [T, batch, owner.userId, 'b'.repeat(64)]);
    await su.query(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'contacts', 1, 'reverting')`, [T, stage, batch]);
    await su.query(`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, line_type, status, is_primary, import_batch_id)
                    VALUES ($1, $2, $3, 'phone', '+14155550142', sha256(convert_to('+14155550142', 'UTF8')), 'mobile', 'mobile', 'active', true, $4)`, [T, point, c.id, batch]);
    await compare(agent, 'an imported phone');
    const card = async () => (await su.query<{ card: unknown }>(`SELECT card FROM priority_feed_items WHERE tenant_id = $1 AND user_id = $2 AND contact_id = $3 AND state = 'open' ORDER BY dedupe_key LIMIT 1`, [T, agent.userId, c.id])).rows[0]!.card;
    const withPhone = JSON.stringify(await card());
    const removed = await asMember(owner, async (tx) => (await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${stage}::uuid, 'contact_points', ${[point]}::uuid[]) AS x`.execute(tx)).rows);
    expect(removed).toEqual([{ id: point }]);
    expect(await marks(agent.userId, `c:${c.id}`)).toBeGreaterThan(0);
    await compare(agent, 'the imported phone reverted');
    expect(JSON.stringify(await card())).not.toBe(withPhone);
  }, 300_000);

  it('a settings write marks no member unless the zone changes; a zone change marks every member \'!full\'', async () => {
    const full = async () => Number((await su.query<{ n: string }>(`SELECT count(*) AS n FROM feed_dirty WHERE tenant_id = $1 AND group_key = '!full'`, [T])).rows[0]!.n);
    const members = Number((await su.query<{ n: string }>(`SELECT count(*) AS n FROM memberships WHERE tenant_id = $1`, [T])).rows[0]!.n);
    const zone = (await su.query<{ z: string }>(`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1`, [T])).rows[0]!.z;
    const before = await full();
    // what the stage-label editor, the batch-text switch and the routing settings write (as the Owner)
    await asMember(owner, (tx) => sql`UPDATE tenant_settings SET stage_labels = '{"active":"Hot"}'::jsonb WHERE tenant_id = app.tenant_id()`.execute(tx));
    await asMember(owner, (tx) => sql`UPDATE tenant_settings SET default_timezone = default_timezone WHERE tenant_id = app.tenant_id()`.execute(tx));
    expect(await full()).toBe(before);
    for (const u of users) await compare(u, 'stage labels renamed');
    const other = zone === 'America/New_York' ? 'America/Chicago' : 'America/New_York';
    await asMember(owner, (tx) => sql`UPDATE tenant_settings SET default_timezone = ${other} WHERE tenant_id = app.tenant_id()`.execute(tx));
    expect(await full()).toBe(before + members);
    for (const u of users) await compare(u, 'the zone changed');
    await asMember(owner, (tx) => sql`UPDATE tenant_settings SET default_timezone = ${zone} WHERE tenant_id = app.tenant_id()`.execute(tx));
    for (const u of users) await compare(u, 'the zone changed back');
  }, 300_000);
});
