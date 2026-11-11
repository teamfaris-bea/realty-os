// The incremental Priority Feed equals a full recompute (lane perf-misses; workspace/feed.ts header).
//
// A generated tenant (every input type, real triggers and guards) goes through random event sequences: time
// jumps (also to exactly a stored change instant and 1 ms before it), new client messages and missed calls, a
// person replying, tasks created / re-dated / done / reassigned / moved off their contact, appointments ending
// or getting an outcome, drafts and handbacks approved or dismissed, claims reviewed, contract dates moved or
// completed, opt-outs, and the agent's own done / snooze / dismiss taps. After every event, for each member
// under test, the materialized feed (materializeFeed: only dirty and due groups re-scored) is compared with a
// full recompute of the whole book (refreshFeed) run on top of it in a transaction that is rolled back:
//   - the GET /feed view (cards, ids, order, wording, actions, total) is identical;
//   - the full recompute changes no stored card row and no stored change instant.
import { randomBytes } from 'node:crypto';
import type { Instant, TenantId, UserActor } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { type Database, type Tx, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import fc from 'fast-check';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeService } from '../crypto/envelope.js';
import { type FeedDeps, actOnFeedItem, materializeFeed, readFeed, refreshFeed } from '../workspace/feed.js';
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

/** One random event, applied as the database owner (every trigger and guard runs). Returns false when skipped. */
async function apply(e: { kind: number; pick: number; size: number; user: number }): Promise<string> {
  // the agents own the books; contract dates go to their deal's owner and members (the TC among them)
  const u = users[e.user % 3]!;
  const off = (e.pick % 997) + 1;
  const rnd = (n: number) => (e.size * 7919 + e.pick) % n;
  switch (e.kind % 15) {
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
  for (const [i, u] of users.slice(0, 3).entries()) {
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
          const k = what.startsWith('refused') ? what : `${e.kind % 15}:${what}`;
          byKind.set(k, (byKind.get(k) ?? 0) + 1);
          for (const u of users) await compare(u, `event ${i} (${what})`);
        }
      }),
      { numRuns: Number(process.env.FEED_EQ_RUNS ?? 4), endOnFailure: true, ...(process.env.FEED_EQ_SEED ? { seed: Number(process.env.FEED_EQ_SEED) } : {}) },
    );
    console.log(JSON.stringify({ stats, byKind: Object.fromEntries(byKind), seenTypes: [...seenTypes] }));
    // the comparison is not vacuous: most events applied, cards of every kind were shown, and groups were re-scored incrementally
    expect(stats.events).toBeGreaterThan(0.6 * 25 * Number(process.env.FEED_EQ_RUNS ?? 4));
    for (const k of ['unanswered_inbound', 'missed_call', 'task_due', 'appointment_outcome', 'first_touch_due', 'deal_date', 'assistant_draft', 'handback']) expect([...seenTypes], k).toContain(k);
    expect(stats.cards).toBeGreaterThan(1_000);
    expect(stats.incremental).toBeGreaterThan(50);
  }, 1_800_000);
});
