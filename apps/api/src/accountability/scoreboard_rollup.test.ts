// The scoreboard's daily rollup (migration 0027) returns exactly what the all-live computation (the 0012
// functions over the whole range) returns, for every viewer, every range, and every way the base rows can
// change after a day was rolled. Tests first: equivalence, the horizon that keeps in-flight writes out of a
// rolled day, the dirty-day marks, the rollup tables' RLS (equal to app.scoreboard_allowed_users), and the
// job's idempotency.
//
// Data: a generated load tenant (lane scale-250k generator: every role, teams, ponds, a live book with
// SLA periods touched and untouched, calls, texts, appointments) plus fixtures: agreements signed on past
// days, rows moved to exact day boundaries (including the 2026-11-01 DST change), and the edge cases below.
import { randomUUID } from 'node:crypto';
import type { ContactId, PondId, TenantId, UserActor, UserId } from '@realty/core/foundation';
import type { OwnershipCommand } from '@realty/core/ownership';
import { type Database, applyOwnershipCommand, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSpec, generateLoad, loadUuid } from '../load/generate.js';
import { kekFromEnv } from '../load/seed.js';
import { createWorker } from '../worker/loop.js';
import { periodicDedupeKey } from '../worker/maintenance.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry, enqueueTyped } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { SCOREBOARD_ROLLUP_EVERY_MS, scoreboardRollup } from './handlers.js';
import * as repo from './repos/scoreboard.js';
import { type RangeKey, RANGE_KEYS, scoreboardFor, teamScoreboard } from './scoreboard.js';
import { rollScoreboard, runScoreboardRollup, sampleScoreboardHorizon } from './scoreboardRollup.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant') as TenantId;
const T2 = loadUuid('load-small-1', 'tenant') as TenantId;

let db: TestDb;
let database: Database;
let su: pg.Pool;
let members: { userId: string; role: string }[] = [];
let users: UserActor[] = [];

const sys = (t: TenantId = T) => systemActor(t, 'worker');
const actorOf = (m: { userId: string; role: string }, t: TenantId = T): UserActor => ({ kind: 'user', tenantId: t, userId: m.userId as UserId, role: m.role as UserActor['role'], sessionId: 'test' });
const inTx = <R>(a: Parameters<typeof withTenantTx>[0], fn: Parameters<typeof withTenantTx<R>>[1]) => withTenantTx(a, fn, { db: database });
const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await su.query<R>(text, values)).rows;

/** Pretends the horizon has passed (the horizon itself is tested separately): every closed day is safe. */
async function forceSafe(t: TenantId = T): Promise<void> {
  await q(
    `INSERT INTO scoreboard_rollup_state (tenant_id, zone, safe_until)
       SELECT tenant_id, default_timezone, clock_timestamp() FROM tenant_settings WHERE tenant_id = $1
     ON CONFLICT (tenant_id) DO UPDATE SET zone = EXCLUDED.zone, safe_until = EXCLUDED.safe_until, pending_at = NULL, pending_xid = NULL`,
    [t],
  );
}

/** The job's roll step, run to completion as the tenant's system actor (one transaction per chunk). */
async function rollAll(t: TenantId = T): Promise<{ days: number; cleared: number }> {
  const first = await inTx(sys(t), (tx) => rollScoreboard(tx)); // also notices a zone change (resets the horizon)
  await forceSafe(t);
  let days = first.daysRolled;
  let cleared = first.marksCleared;
  for (let i = 0; i < 10; i++) {
    const r = await inTx(sys(t), (tx) => rollScoreboard(tx));
    days += r.daysRolled;
    cleared += r.marksCleared;
    if (r.pendingDays === 0) break;
  }
  return { days, cleared };
}

const marks = async (t: TenantId = T) => (await q<{ day: string }>(`SELECT day::text FROM scoreboard_rollup_dirty WHERE tenant_id = $1 ORDER BY day`, [t])).map((r) => r.day);
const rolledDays = async (t: TenantId = T) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM scoreboard_rollup_days WHERE tenant_id = $1`, [t]))[0]!.n);

/**
 * The core assertion: for every member of the tenant (owner, admin, team leads, agents, ISA, TC) and
 * every range, the team scoreboard and each member's own scoreboard are identical through the rollup and
 * all-live; and as the system actor, the repo rows for every member are identical.
 */
async function expectEquivalent(label: string): Promise<{ rolledUsed: number }> {
  let rolledUsed = 0;
  for (const a of users) {
    for (const key of RANGE_KEYS) {
      const [viaRollup, live, self, selfLive] = await inTx(a, async (tx, now) => [
        await teamScoreboard(tx, a, key, now, 'rollup'),
        await teamScoreboard(tx, a, key, now, 'live'),
        await scoreboardFor(tx, a.userId, key, now, 'rollup'),
        await scoreboardFor(tx, a.userId, key, now, 'live'),
      ]);
      expect(viaRollup, `${label}: team ${a.role} ${a.userId} ${key}`).toEqual(live);
      expect(self, `${label}: self ${a.role} ${a.userId} ${key}`).toEqual(selfLive);
      // another member's board (allowed or not) through both paths
      for (const other of members.filter((_, i) => i % 4 === 1)) {
        const [x, y] = await inTx(a, async (tx, now) => [await scoreboardFor(tx, other.userId, key, now, 'rollup'), await scoreboardFor(tx, other.userId, key, now, 'live')]);
        expect(x, `${label}: ${a.role} asks for ${other.role} ${key}`).toEqual(y);
      }
    }
  }
  const ids = members.map((m) => m.userId);
  for (const key of ['7d', '30d', '90d'] as RangeKey[]) {
    await inTx(sys(), async (tx, now) => {
      const b = await repo.rangeBounds(tx, key, now);
      const [act, actLive, spd, spdLive] = [
        await repo.activityRows(tx, ids, b.from, b.to),
        await repo.liveActivityRows(tx, ids, b.from, b.to),
        await repo.speedRows(tx, ids, b.from, b.to),
        await repo.liveSpeedRows(tx, ids, b.from, b.to),
      ];
      expect([...act.entries()].sort(), `${label}: system activity ${key}`).toEqual([...actLive.entries()].sort());
      const norm = (rows: typeof spd) => rows.map((r) => [r.userId, r.ownedAt, r.firstTouchDueAt, r.firstTouchAt]).sort((p, q2) => JSON.stringify(p).localeCompare(JSON.stringify(q2)));
      expect(norm(spd), `${label}: system speed ${key}`).toEqual(norm(spdLive));
      if (key === '90d') {
        const used = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM scoreboard_rollup_days r JOIN tenant_settings s ON s.tenant_id = r.tenant_id
           WHERE r.tenant_id = app.tenant_id() AND r.zone = s.default_timezone
             AND r.day >= app.scoreboard_day_of(${new Date(b.from).toISOString()}::timestamptz, s.default_timezone)
             AND NOT EXISTS (SELECT 1 FROM scoreboard_rollup_dirty m WHERE m.tenant_id = r.tenant_id AND m.day = r.day)`.execute(tx);
        rolledUsed = used.rows[0]!.n;
      }
    });
  }
  return { rolledUsed };
}

/** Every rolled day holds exactly what the 0012 functions return for that day, per member. */
async function expectRollupRowsExact(): Promise<void> {
  const ids = members.map((m) => m.userId);
  await inTx(sys(), async (tx) => {
    const act = await sql<{ n: number }>`
      WITH z AS (SELECT default_timezone AS zone FROM tenant_settings WHERE tenant_id = app.tenant_id()),
      d AS (SELECT r.day, (r.day::timestamp AT TIME ZONE z.zone) AS lo, ((r.day + 1)::timestamp AT TIME ZONE z.zone) AS hi
              FROM scoreboard_rollup_days r, z WHERE r.tenant_id = app.tenant_id() AND r.zone = z.zone
               AND NOT EXISTS (SELECT 1 FROM scoreboard_rollup_dirty m WHERE m.tenant_id = r.tenant_id AND m.day = r.day)),
      live AS (SELECT d.day, a.* FROM d, LATERAL app.scoreboard_activity(${ids}::uuid[], d.lo, d.hi) a),
      roll AS (SELECT * FROM scoreboard_activity_daily WHERE tenant_id = app.tenant_id() AND day IN (SELECT day FROM d))
      SELECT count(*)::int AS n FROM live l FULL JOIN roll r ON r.day = l.day AND r.user_id = l.user_id
       WHERE l.user_id IS NULL
          OR COALESCE(r.calls, 0) <> l.calls OR COALESCE(r.texts_and_emails, 0) <> l.texts_and_emails
          OR COALESCE(r.appointments_set, 0) <> l.appointments_set OR COALESCE(r.appointments_held, 0) <> l.appointments_held
          OR COALESCE(r.appointments_due, 0) <> l.appointments_due OR COALESCE(r.agreements_signed, 0) <> l.agreements_signed`.execute(tx);
    expect(act.rows[0]!.n).toBe(0);
    const spd = await sql<{ n: number }>`
      WITH z AS (SELECT default_timezone AS zone FROM tenant_settings WHERE tenant_id = app.tenant_id()),
      d AS (SELECT r.day, (r.day::timestamp AT TIME ZONE z.zone) AS lo, ((r.day + 1)::timestamp AT TIME ZONE z.zone) AS hi
              FROM scoreboard_rollup_days r, z WHERE r.tenant_id = app.tenant_id() AND r.zone = z.zone
               AND NOT EXISTS (SELECT 1 FROM scoreboard_rollup_dirty m WHERE m.tenant_id = r.tenant_id AND m.day = r.day)),
      live AS (SELECT d.day, s.user_id, s.owned_at, s.first_touch_due_at, s.first_touch_at, count(*) AS n
                 FROM d, LATERAL app.scoreboard_speed(${ids}::uuid[], d.lo, d.hi) s GROUP BY 1, 2, 3, 4, 5),
      roll AS (SELECT day, user_id, owned_at, first_touch_due_at, first_touch_at, count(*) AS n FROM scoreboard_speed_daily
                WHERE tenant_id = app.tenant_id() AND day IN (SELECT day FROM d) AND user_id = ANY (${ids}::uuid[]) GROUP BY 1, 2, 3, 4, 5)
      SELECT count(*)::int AS n FROM live l FULL JOIN roll r
          ON r.day = l.day AND r.user_id = l.user_id AND r.owned_at = l.owned_at AND r.first_touch_due_at = l.first_touch_due_at
         AND r.first_touch_at IS NOT DISTINCT FROM l.first_touch_at
       WHERE l.n IS DISTINCT FROM r.n`.execute(tx);
    expect(spd.rows[0]!.n).toBe(0);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(1_500, PH);
  spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 1_500 : 200 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Pool({ connectionString: db.ownerUrl, max: 3 });
  database = createDatabase({ url: db.appUserUrl, max: 4 });
  members = (await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY role, user_id`, [T])).map((m) => ({ userId: m.user_id, role: m.role }));
  users = members.map((m) => actorOf(m));

  // fixtures the generator does not make: agreements signed on past days (incl. at exact day starts),
  // human texts and calls moved onto exact day boundaries (the instant a day starts and 1 ms before),
  // over the whole window, which spans the 2026-11-01 DST change of America/Los_Angeles
  await q(
    `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage, to_stage, actor_kind, changed_at)
     SELECT d.tenant_id, d.id, 'prospect', 'agreement_signed', 'user',
            CASE WHEN n % 3 = 0 THEN ((current_date - (n % 95)::int)::timestamp AT TIME ZONE 'America/Los_Angeles')
                 ELSE clock_timestamp() - (n % 95) * interval '1 day' - (n % 7) * interval '1 hour' END
       FROM (SELECT d.*, row_number() OVER (ORDER BY md5(d.id::text)) AS n FROM deals d WHERE d.tenant_id = $1) d WHERE n <= 120`,
    [T],
  );
  await q(
    `WITH b AS (SELECT i, (((now() AT TIME ZONE 'America/Los_Angeles')::date - i)::timestamp AT TIME ZONE 'America/Los_Angeles') AS lo
                  FROM generate_series(1, 92) i),
     m AS (SELECT id, row_number() OVER (ORDER BY md5(id::text || 'edge')) AS n FROM messages
            WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human' AND NOT imported AND dispatched_at IS NOT NULL)
     UPDATE messages x SET dispatched_at = CASE WHEN m.n % 2 = 0 THEN b.lo ELSE b.lo - interval '1 millisecond' END
       FROM m JOIN b ON b.i = 1 + (m.n % 92) WHERE x.tenant_id = $1 AND x.id = m.id AND m.n <= 184`,
    [T],
  );
  await q(
    `WITH b AS (SELECT i, (((now() AT TIME ZONE 'America/Los_Angeles')::date - i)::timestamp AT TIME ZONE 'America/Los_Angeles') AS lo
                  FROM generate_series(1, 92) i),
     c AS (SELECT id, row_number() OVER (ORDER BY md5(id::text || 'edge')) AS n FROM calls
            WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human' AND NOT imported)
     UPDATE calls x SET started_at = CASE WHEN c.n % 2 = 0 THEN b.lo ELSE b.lo - interval '1 millisecond' END
       FROM c JOIN b ON b.i = 1 + (c.n % 92) WHERE x.tenant_id = $1 AND x.id = c.id AND c.n <= 184`,
    [T],
  );
  // ledger shapes the generator does not make (it writes assigned -> first touch only): random
  // continuations of SLA periods inside the window, so first touches come after a release, a second
  // period, a breach, a waiver, a second first touch, ... (through the ledger guard: one command)
  const agents = members.filter((m) => m.role === 'agent').map((m) => m.userId);
  const heads = await q<{ contact_id: string; seq: string; at: Date }>(
    `SELECT e.contact_id, max(e.seq)::text AS seq, max(e.occurred_at) AS at FROM lead_ownership_events e
      WHERE e.tenant_id = $1 AND e.contact_id IN (SELECT contact_id FROM lead_ownership_events WHERE tenant_id = $1 AND type = 'assigned'
                                                    AND occurred_at BETWEEN now() - interval '85 days' AND now() - interval '2 days')
      GROUP BY e.contact_id ORDER BY md5(e.contact_id::text) LIMIT 220`,
    [T],
  );
  const kinds = ['first_touch_recorded', 'first_touch_breached', 'released', 'reassigned', 'claimed', 'sla_waived', 'inactivity_warned', 'first_touch_recorded', 'assigned', 'sent_to_pond'];
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.ownership_command', $1, true)`, [loadUuid(SLUG, 'ownership-command:rollup-test')]);
    let k = 0;
    for (const h of heads) {
      let seq = Number(h.seq);
      let at = h.at.getTime();
      const n = 1 + (k % 4);
      for (let i = 0; i < n; i++, k++) {
        const type = kinds[(k * 7 + i) % kinds.length]!;
        seq += 1;
        at += (5 + ((k * 13) % 600)) * 60_000;
        if (at > Date.now() - 60_000) at = Date.now() - 60_000 + i;
        const owner = agents[k % agents.length]!;
        const toState = type === 'released' ? 'unassigned' : type === 'sent_to_pond' ? 'in_pond' : 'owned';
        const periodStart = type === 'reassigned' || type === 'claimed' || type === 'assigned';
        await c.query(
          `INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, deadline_at, actor_kind, reason_code, command_id, occurred_at)
           VALUES ($1, $2, $3, gen_random_uuid(), $4, 'owned', $5, $6, $7, 'system', 'TEST_SHAPE', $8, $9)`,
          [T, h.contact_id, seq, type, toState, toState === 'owned' ? owner : null, periodStart ? new Date(at + 15 * 60_000) : null, loadUuid(SLUG, 'ownership-command:rollup-test'), new Date(at)],
        );
      }
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}, 600_000);

afterAll(async () => {
  await su?.end();
  await database?.close();
  await db?.drop();
});

describe('speed timings as epoch milliseconds', () => {
  it('floor(µs / 1000) equals what node-pg parses a timestamptz to, for every microsecond fraction', () => {
    const parse = pg.types.getTypeParser(1184) as (s: string) => Date;
    const base = Date.UTC(2026, 10, 1, 8, 59, 59); // the DST change day, as printed with an offset
    let bad = 0;
    for (let us = 0; us < 1_000_000; us++) {
      const f = String(us).padStart(6, '0').replace(/0+$/, ''); // Postgres trims trailing zeros
      const got = parse(`2026-11-01 01:59:59${f ? `.${f}` : ''}-07`).getTime();
      if (got !== base + Math.floor(us / 1000)) bad++;
    }
    expect(bad).toBe(0);
  });
});

/** app.scoreboard_speed as 0012 wrote it (two probes per period), as an invoker function for the superuser. */
const OLD_SPEED = `CREATE FUNCTION pg_temp.old_speed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_due_at timestamptz, first_touch_at timestamptz) LANGUAGE sql STABLE AS $$
  SELECT e.owner_user_id, e.occurred_at, e.deadline_at, ft.occurred_at
    FROM public.lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.occurred_at FROM public.lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND f.type = 'first_touch_recorded'
         AND NOT EXISTS (SELECT 1 FROM public.lead_ownership_events x
                          WHERE x.tenant_id = e.tenant_id AND x.contact_id = e.contact_id
                            AND x.seq > e.seq AND x.seq < f.seq
                            AND x.type IN ('reassigned','released','auto_released','inactivity_released','sent_to_pond',
                                           'closed','merged_away','claimed','assigned','offer_accepted'))
       ORDER BY f.seq LIMIT 1) ft ON true
   WHERE e.tenant_id = app.tenant_id()
     AND e.owner_user_id IN (SELECT a.user_id FROM app.scoreboard_allowed_users(p_user_ids) a)
     AND e.type IN ('offer_accepted','claimed','assigned','reassigned') AND e.deadline_at IS NOT NULL
     AND e.actor_kind <> 'import'
     AND e.occurred_at >= p_from AND e.occurred_at < p_to
$$`;

describe('0027 app.scoreboard_speed: the one-probe body returns exactly the 0012 rows', () => {
  it('for every role and the system actor, over every SLA period of the tenant (generated and random ledger shapes)', async () => {
    const ids = members.map((m) => m.userId);
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(OLD_SPEED);
      const shapes = (await c.query<{ n: number }>(`SELECT count(DISTINCT contact_id)::int AS n FROM lead_ownership_events WHERE tenant_id = $1 AND reason_code = 'TEST_SHAPE'`, [T])).rows[0]!.n;
      expect(shapes).toBeGreaterThan(150);
      for (const a of [...members.map((m) => ({ userId: m.userId, kind: 'user', label: m.role })), { userId: '', kind: 'system', label: 'system' }]) {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true), set_config('app.principal_type', 'staff', true)`, [T, a.userId, a.kind]);
        const r = (await c.query<{ old_n: number; new_n: number; only_old: number; only_new: number; touched: number }>(
          `WITH o AS (SELECT * FROM pg_temp.old_speed($1::uuid[], '-infinity', 'infinity')),
                n AS (SELECT * FROM app.scoreboard_speed($1::uuid[], '-infinity', 'infinity'))
           SELECT (SELECT count(*) FROM o)::int AS old_n, (SELECT count(*) FROM n)::int AS new_n,
                  (SELECT count(*) FROM (SELECT * FROM o EXCEPT ALL SELECT * FROM n) x)::int AS only_old,
                  (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM o) x)::int AS only_new,
                  (SELECT count(*) FROM o WHERE first_touch_at IS NOT NULL)::int AS touched`,
          [ids],
        )).rows[0]!;
        expect(r, a.label).toMatchObject({ only_old: 0, only_new: 0 });
        expect(r.new_n, a.label).toBe(r.old_n);
        if (a.label === 'system') expect(r.touched).toBeGreaterThan(0);
      }
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

describe('0027 scoreboard rollup: rollup + live equals live', () => {
  it('the fixture covers every role and every number over the 90-day window', async () => {
    expect(new Set(members.map((m) => m.role))).toEqual(new Set(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc']));
    const c = (await q<Record<string, string>>(
      `SELECT (SELECT count(*) FROM calls WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human' AND started_at > now() - interval '90 days') AS calls,
              (SELECT count(*) FROM messages WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human' AND NOT imported AND dispatched_at > now() - interval '90 days') AS texts,
              (SELECT count(*) FROM appointments WHERE tenant_id = $1 AND created_by_kind = 'user' AND created_at > now() - interval '90 days') AS appts_set,
              (SELECT count(*) FROM appointments WHERE tenant_id = $1 AND status = 'held' AND starts_at > now() - interval '90 days') AS appts_held,
              (SELECT count(*) FROM deal_stage_history WHERE tenant_id = $1 AND to_stage = 'agreement_signed' AND changed_at > now() - interval '90 days' AND changed_at < now() - interval '1 day') AS agreements,
              (SELECT count(*) FROM lead_ownership_events WHERE tenant_id = $1 AND type = 'assigned' AND deadline_at IS NOT NULL AND occurred_at > now() - interval '90 days') AS periods,
              (SELECT count(*) FROM lead_ownership_events e WHERE tenant_id = $1 AND type = 'assigned' AND occurred_at > now() - interval '90 days'
                  AND NOT EXISTS (SELECT 1 FROM lead_ownership_events f WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.type = 'first_touch_recorded')) AS untouched`,
      [T],
    ))[0]!;
    for (const [k, v] of Object.entries(c)) expect(Number(v), k).toBeGreaterThan(0);
  });

  it('with no rollup at all (a fresh database before the first job run) both paths agree', async () => {
    expect(await rolledDays()).toBe(0);
    const r = await expectEquivalent('no rollup');
    expect(r.rolledUsed).toBe(0);
  }, 600_000);

  it('after the backfill: every rolled day equals the live functions for that day, and every viewer and range agrees', async () => {
    const r = await rollAll();
    expect(r.days).toBeGreaterThanOrEqual(90);
    expect(await marks()).toEqual([]); // the generator's backdated rows marked days; the backfill consumed them
    await expectRollupRowsExact();
    const e = await expectEquivalent('backfilled');
    expect(e.rolledUsed).toBeGreaterThanOrEqual(88); // the 90d range really reads the rollup
  }, 600_000);

  it('visibility changes after a day was rolled change nothing: contact reassigned outside the team, soft-deleted, sent to a pond; a member leaves the team; a member deactivated', async () => {
    await rollAll();
    const lead = members.find((m) => m.role === 'team_lead')!;
    const team = (await q<{ user_id: string }>(
      `SELECT tm.user_id FROM team_members tm JOIN team_members l ON l.tenant_id = tm.tenant_id AND l.team_id = tm.team_id AND l.user_id = $2 AND l.is_lead
        WHERE tm.tenant_id = $1 AND tm.user_id <> $2`,
      [T, lead.userId],
    )).map((r) => r.user_id);
    expect(team.length).toBeGreaterThan(0);
    const outsider = members.find((m) => m.role === 'agent' && !team.includes(m.userId))!;
    // contacts the lead's team members touched in the window move away / disappear
    const touched = (await q<{ contact_id: string }>(
      `SELECT DISTINCT m.contact_id FROM messages m JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id AND c.ownership_state = 'owned'
                        AND NOT EXISTS (SELECT 1 FROM lead_ownership_events e WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.seq > c.ownership_seq)
        WHERE m.tenant_id = $1 AND m.initiated_by_user_id = ANY ($2::uuid[]) AND m.direction = 'outbound'
          AND m.initiator = 'human' AND m.dispatched_at > now() - interval '30 days' LIMIT 9`,
      [T, team],
    )).map((r) => r.contact_id);
    expect(touched.length).toBe(9);
    // through the real ownership engine, as the admin: reassigned outside the team, soft-deleted, released
    // to a pond (each writes today's ledger events; earlier periods keep their numbers)
    const pond = (await q<{ id: string }>(`SELECT id FROM ponds WHERE tenant_id = $1 AND archived_at IS NULL LIMIT 1`, [T]))[0]!.id as PondId;
    const admin = users.find((u) => u.role === 'admin')!;
    const cmds: OwnershipCommand[] = [
      ...[0, 1, 2].map(() => ({ kind: 'reassign', toUserId: outsider.userId as UserId, reason: 'TEST_REASSIGN' }) as OwnershipCommand),
      ...[0, 1, 2].map(() => ({ kind: 'soft_delete' }) as OwnershipCommand),
      ...[0, 1, 2].map(() => ({ kind: 'release', reason: 'unresponsive', note: 'No reply in two weeks', toPondId: pond }) as OwnershipCommand),
    ];
    for (const [i, cmd] of cmds.entries()) {
      // a release is the owner's own action; reassign and soft delete are the admin's
      const ownerId = (await q<{ o: string }>(`SELECT owner_user_id AS o FROM contacts WHERE tenant_id = $1 AND id = $2`, [T, touched[i]]))[0]!.o;
      const by = cmd.kind === 'release' ? users.find((u) => u.userId === ownerId)! : admin;
      const r = await applyOwnershipCommand(by, touched[i] as ContactId, cmd, { commandId: randomUUID(), db: database });
      expect(r.outcome.ok, `${cmd.kind}: ${JSON.stringify(r.outcome)}`).toBe(true);
    }
    const states = (await q<{ s: string; d: boolean }>(`SELECT ownership_state AS s, deleted_at IS NOT NULL AS d FROM contacts WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, touched]));
    expect(states.filter((x) => x.d).length).toBe(3);
    expect(states.filter((x) => x.s === 'in_pond').length).toBe(3);
    // a member leaves the lead's team; another member is deactivated
    await q(`DELETE FROM team_members WHERE tenant_id = $1 AND user_id = $2 AND NOT is_lead`, [T, team[0]]);
    const deactivated = members.find((m) => m.role === 'agent' && m.userId !== team[0] && m.userId !== outsider.userId)!;
    const mc = await su.connect();
    try {
      await mc.query('BEGIN');
      await mc.query('SET LOCAL session_replication_role = replica'); // the membership guards want an Owner's request; no 0027 trigger here
      await mc.query(`UPDATE memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, [T, deactivated.userId]);
      await mc.query('COMMIT');
    } finally {
      await mc.query('ROLLBACK').catch(() => undefined);
      mc.release();
    }
    // a suspended member signs in no more (no tenant context): they stay a subject, not a viewer
    users = users.filter((u) => u.userId !== deactivated.userId);
    const e = await expectEquivalent('visibility changed');
    expect(e.rolledUsed).toBeGreaterThanOrEqual(88);
  }, 600_000);

  it('late and backdated writes into rolled days mark them dirty (computed live until re-rolled); the re-roll clears exactly those marks', async () => {
    await rollAll();
    expect(await marks()).toEqual([]);
    const agent = members.find((m) => m.role === 'agent')!;
    // 1. a re-dispatch moves a human text from today-ish to 3 days ago
    await q(
      `UPDATE messages SET dispatched_at = clock_timestamp() - interval '3 days'
        WHERE tenant_id = $1 AND id = (SELECT id FROM messages WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human'
                                          AND NOT imported AND dispatched_at > now() - interval '20 days' ORDER BY id LIMIT 1)`,
      [T],
    );
    // 2. an appointment 5 days ago marked held (and one canceled)
    await q(
      `UPDATE appointments SET status = CASE WHEN status = 'held' THEN 'canceled' ELSE 'held' END
        WHERE tenant_id = $1 AND id IN (SELECT id FROM appointments WHERE tenant_id = $1 AND created_by_kind <> 'import'
                                          AND starts_at BETWEEN now() - interval '40 days' AND now() - interval '2 days' ORDER BY id LIMIT 2)`,
      [T],
    );
    // 3. an appointment logged after the fact (created today, started 6 days ago)
    await q(
      `INSERT INTO appointments (tenant_id, id, user_id, set_by_user_id, kind, starts_at, ends_at, status, created_by_kind)
       VALUES ($1, gen_random_uuid(), $2, $2, 'consult', now() - interval '6 days', now() - interval '6 days' + interval '1 hour', 'held', 'user')`,
      [T, agent.userId],
    );
    // 4. a backdated agreement and a deal changing owner (its past agreements move with it)
    const deal = (await q<{ deal_id: string }>(`SELECT deal_id FROM deal_stage_history WHERE tenant_id = $1 AND to_stage = 'agreement_signed'
                                                  AND changed_at BETWEEN now() - interval '60 days' AND now() - interval '2 days' ORDER BY deal_id LIMIT 1`, [T]))[0]!.deal_id;
    await q(`UPDATE deals SET owner_user_id = $3 WHERE tenant_id = $1 AND id = $2`, [T, deal, agent.userId]);
    await q(`INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage, to_stage, actor_kind, changed_at) VALUES ($1, $2, 'prospect', 'agreement_signed', 'user', now() - interval '8 days')`, [T, deal]);
    // 5. a call from 10 days ago deleted (retention / revert)
    await q(`DELETE FROM calls WHERE tenant_id = $1 AND id = (SELECT id FROM calls WHERE tenant_id = $1 AND direction = 'outbound' AND initiator = 'human'
                                                               AND started_at BETWEEN now() - interval '30 days' AND now() - interval '2 days' ORDER BY id LIMIT 1)`, [T]);
    // 6. a late first touch on an SLA period that started 4+ days ago and was never touched
    const open = (await q<{ contact_id: string; seq: string; owner: string }>(
      `SELECT e.contact_id, e.seq, e.owner_user_id AS owner FROM lead_ownership_events e
        WHERE e.tenant_id = $1 AND e.type = 'assigned' AND e.deadline_at IS NOT NULL AND e.occurred_at BETWEEN now() - interval '80 days' AND now() - interval '4 days'
          AND NOT EXISTS (SELECT 1 FROM lead_ownership_events f WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq)
        ORDER BY e.occurred_at LIMIT 1`,
      [T],
    ))[0]!;
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      const cmd = (await c.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)).rows[0]!.id;
      await c.query(`SELECT set_config('app.ownership_command', $1, true)`, [cmd]);
      await c.query(
        `INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
         VALUES ($1, $2, $3::bigint + 1, gen_random_uuid(), 'first_touch_recorded', 'owned', 'owned', $4, 'user', $4, 'FIRST_TOUCH', $5, clock_timestamp())`,
        [T, open.contact_id, open.seq, open.owner, cmd],
      );
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    // 7. imported rows never count, so a backdated import marks nothing
    const before = (await marks()).length;
    await q(`UPDATE calls SET started_at = now() - interval '9 days' WHERE tenant_id = $1 AND id IN (SELECT id FROM calls WHERE tenant_id = $1 AND imported LIMIT 3)`, [T]);
    expect((await marks()).length).toBe(before);

    const dirty = await marks();
    expect(new Set(dirty).size).toBeGreaterThanOrEqual(6);
    const e1 = await expectEquivalent('dirty, before the re-roll');
    expect(e1.rolledUsed).toBeLessThan(90);
    const r = await rollAll();
    expect(r.cleared).toBe(dirty.length);
    expect(await marks()).toEqual([]);
    await expectRollupRowsExact();
    const e2 = await expectEquivalent('re-rolled');
    expect(e2.rolledUsed).toBeGreaterThanOrEqual(88);
  }, 600_000);

  it('day boundaries in other zones (DST at midnight, half-hour offsets, UTC+14, a 30-minute DST): a zone change stops using the old days until re-rolled', async () => {
    for (const zone of ['America/Santiago', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Australia/Lord_Howe', 'America/New_York']) {
      await q(`UPDATE tenant_settings SET default_timezone = $2 WHERE tenant_id = $1`, [T, zone]);
      const stale = await expectEquivalent(`zone ${zone}, not re-rolled`);
      expect(stale.rolledUsed).toBe(0);
      await rollAll();
      await expectRollupRowsExact();
      const fresh = await expectEquivalent(`zone ${zone}, re-rolled`);
      expect(fresh.rolledUsed).toBeGreaterThanOrEqual(88);
    }
    await q(`UPDATE tenant_settings SET default_timezone = 'America/Los_Angeles' WHERE tenant_id = $1`, [T]);
    await rollAll();
  }, 900_000);
});

describe('0027 dirty-day marks', () => {
  it('a write into today marks nothing; a write into a past day marks it once per transaction; a write older than the window marks nothing', async () => {
    await rollAll();
    const agent = members.find((m) => m.role === 'agent')!;
    const ins = (at: string) =>
      `INSERT INTO appointments (tenant_id, id, user_id, kind, starts_at, ends_at, status, created_by_kind)
       VALUES ('${T}', gen_random_uuid(), '${agent.userId}', 'consult', ${at}, ${at} + interval '1 hour', 'scheduled', 'user')`;
    await q(ins('clock_timestamp() + interval \'2 days\''));
    expect(await marks()).toEqual([]);
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < 5; i++) await c.query(ins(`clock_timestamp() - interval '2 days'`));
      await c.query(ins(`clock_timestamp() - interval '200 days'`));
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect((await marks()).length).toBe(1);
    await rollAll();
    expect(await marks()).toEqual([]);
  });
});

describe('0027 horizon: a day is rolled only after every transaction that could still write into it has ended', () => {
  it('a sample taken while an older transaction is open is not consumed until that transaction ends; the sample needs its own transaction', async () => {
    await q(`DELETE FROM scoreboard_rollup_state WHERE tenant_id = $1`, [T2]);
    await q(`DELETE FROM scoreboard_rollup_days WHERE tenant_id = $1`, [T2]);
    const first = await inTx(sys(T2), (tx) => rollScoreboard(tx));
    expect(first).toMatchObject({ daysRolled: 0, safeUntil: null });

    const open = await su.connect();
    try {
      await open.query('BEGIN');
      await open.query('SELECT pg_current_xact_id()'); // an in-flight writer holding an xid
      expect(await inTx(sys(T2), (tx) => sampleScoreboardHorizon(tx))).toBe(true);
      expect(await inTx(sys(T2), (tx) => sampleScoreboardHorizon(tx))).toBe(false); // the older sample is kept
      const blocked = await inTx(sys(T2), (tx) => rollScoreboard(tx));
      expect(blocked).toMatchObject({ daysRolled: 0, safeUntil: null });
      await open.query('COMMIT');
    } finally {
      await open.query('ROLLBACK').catch(() => undefined);
      open.release();
    }
    // other clients of this cluster (other test databases) may hold older xids for a while: wait, bounded,
    // until the cluster-wide oldest running xid has passed the sample, and only then expect the roll to
    // consume it (before that it must not)
    const pending = Number((await q<{ x: string }>(`SELECT pending_xid::text AS x FROM scoreboard_rollup_state WHERE tenant_id = $1`, [T2]))[0]!.x);
    const xmin = async () => Number((await q<{ x: string }>(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS x`))[0]!.x);
    for (let i = 0; i < 360 && (await xmin()) <= pending; i++) await new Promise((res) => setTimeout(res, 500));
    expect(await xmin()).toBeGreaterThan(pending);
    const r = await inTx(sys(T2), (tx) => rollScoreboard(tx));
    expect(r.safeUntil).not.toBeNull();
    expect(r.daysRolled + r.pendingDays).toBeGreaterThan(0);

    // the sample refuses to run after the transaction already took an xid
    await expect(inTx(sys(T2), async (tx) => {
      await sql`SELECT pg_current_xact_id()`.execute(tx);
      return sampleScoreboardHorizon(tx);
    })).rejects.toThrow(/SCOREBOARD_ROLLUP_SAMPLE_NOT_FIRST/);
  }, 240_000);
});

describe('0027 rollup tables: RLS equals the live visibility (app.scoreboard_allowed_users)', () => {
  it('every role and the system actor see exactly the members the live functions admit; nobody but the definer writes; tenants are isolated', async () => {
    await rollAll();
    const withRows = (await q<{ user_id: string }>(`SELECT DISTINCT user_id FROM scoreboard_activity_daily WHERE tenant_id = $1
                                                    UNION SELECT DISTINCT user_id FROM scoreboard_speed_daily WHERE tenant_id = $1`, [T])).map((r) => r.user_id);
    expect(withRows.length).toBeGreaterThan(3);
    for (const a of [...users, sys()]) {
      const r = await inTx(a, async (tx) => {
        const allowed = (await sql<{ user_id: string }>`SELECT user_id FROM app.scoreboard_allowed_users(${withRows}::uuid[])`.execute(tx)).rows.map((x) => x.user_id).sort();
        const act = (await sql<{ user_id: string }>`SELECT DISTINCT user_id FROM scoreboard_activity_daily`.execute(tx)).rows.map((x) => x.user_id).sort();
        const spd = (await sql<{ user_id: string }>`SELECT DISTINCT user_id FROM scoreboard_speed_daily`.execute(tx)).rows.map((x) => x.user_id).sort();
        const spdWithRows = (await q<{ user_id: string }>(`SELECT DISTINCT user_id FROM scoreboard_speed_daily WHERE tenant_id = $1`, [T])).map((x) => x.user_id);
        return { allowed, act, spd, spdAllowed: allowed.filter((u) => spdWithRows.includes(u)) };
      });
      const actWithRows = (await q<{ user_id: string }>(`SELECT DISTINCT user_id FROM scoreboard_activity_daily WHERE tenant_id = $1`, [T])).map((x) => x.user_id);
      expect(r.act, `activity rows visible to ${'role' in a ? a.role : 'system'}`).toEqual(r.allowed.filter((u) => actWithRows.includes(u)));
      expect(r.spd, `speed rows visible to ${'role' in a ? a.role : 'system'}`).toEqual(r.spdAllowed);
    }
    // writes: app_user has SELECT only; the roll and sample refuse anyone but the system actor
    const agent = users.find((u) => u.role === 'agent')!;
    for (const stmt of [
      `INSERT INTO scoreboard_activity_daily (tenant_id, user_id, day) VALUES ('${T}', '${agent.userId}', current_date)`,
      `UPDATE scoreboard_activity_daily SET calls = 0`,
      `DELETE FROM scoreboard_rollup_dirty`,
      `INSERT INTO scoreboard_rollup_days (tenant_id, day, zone) VALUES ('${T}', current_date, 'UTC')`,
    ]) {
      await expect(inTx(agent, (tx) => sql.raw(stmt).execute(tx))).rejects.toThrow(/permission denied/);
    }
    await expect(inTx(users.find((u) => u.role === 'owner')!, (tx) => rollScoreboard(tx))).rejects.toThrow(/SCOREBOARD_ROLLUP_SYSTEM_ONLY/);
    await expect(inTx(users.find((u) => u.role === 'admin')!, (tx) => sampleScoreboardHorizon(tx))).rejects.toThrow(/SCOREBOARD_ROLLUP_SYSTEM_ONLY/);
    // the other tenant's actors see none of this tenant's rows, and its own rollup is its own
    const other = (await q<{ user_id: string; role: string }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [T2]))[0]!;
    const seen = await inTx(actorOf({ userId: other.user_id, role: other.role }, T2), async (tx) => (await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM scoreboard_activity_daily WHERE tenant_id = ${T}::uuid)::int + (SELECT count(*) FROM scoreboard_speed_daily WHERE tenant_id = ${T}::uuid)::int
           + (SELECT count(*) FROM scoreboard_rollup_days WHERE tenant_id = ${T}::uuid)::int + (SELECT count(*) FROM scoreboard_rollup_state WHERE tenant_id = ${T}::uuid)::int AS n`.execute(tx)).rows[0]!.n);
    expect(seen).toBe(0);
  }, 300_000);
});

describe('0027 rollup job', () => {
  const snapshot = async () =>
    q(`SELECT 'a' AS k, user_id::text, day::text, calls || ',' || texts_and_emails || ',' || appointments_set || ',' || appointments_held || ',' || appointments_due || ',' || agreements_signed AS v
         FROM scoreboard_activity_daily WHERE tenant_id = $1
       UNION ALL SELECT 's', user_id::text, day::text, ord || ',' || owned_at || ',' || first_touch_due_at || ',' || COALESCE(first_touch_at::text, '-')
         FROM scoreboard_speed_daily WHERE tenant_id = $1
       UNION ALL SELECT 'd', '', day::text, zone FROM scoreboard_rollup_days WHERE tenant_id = $1
       ORDER BY 1, 2, 3, 4`, [T]);

  it('is idempotent: re-running it, and re-rolling every day from scratch, gives the same rollup', async () => {
    await rollAll();
    const a = await snapshot();
    await rollAll();
    expect(await snapshot()).toEqual(a);
    // forget which days are rolled: the next run recomputes all of them, identically
    await q(`DELETE FROM scoreboard_rollup_days WHERE tenant_id = $1`, [T]);
    const r = await rollAll();
    expect(r.days).toBeGreaterThanOrEqual(90);
    expect(await snapshot()).toEqual(a);
  }, 300_000);

  it('runs as a periodic standalone job: rolls in chunks, samples the horizon in its own transaction, reschedules itself', async () => {
    await forceSafe();
    await q(`DELETE FROM scoreboard_rollup_days WHERE tenant_id = $1`, [T]);
    const direct = await runScoreboardRollup((fn) => inTx(sys(), (tx) => fn(tx)), { maxDays: 20 });
    expect(direct.calls).toBeGreaterThanOrEqual(5); // 92 days in chunks of 20
    expect(direct.daysRolled).toBeGreaterThanOrEqual(90);
    expect(direct.sampled).toBe(true);

    const registry = new HandlerRegistry().registerAll([scoreboardRollup as never]);
    const worker = createWorker({ db: database, registry, queues: ['default'], concurrency: 1, worker: 'rollup-test', idleMs: 10, log: silentLogger });
    expect(await inTx(sys(), (tx) => enqueueTyped(tx, scoreboardRollup, {}, { dedupeKey: periodicDedupeKey(scoreboardRollup.kind) }))).toBe(true);
    expect(await worker.drain(5)).toBe(1);
    const job = (await q<{ status: string; run_at: Date; created_at: Date; attempts: number }>(`SELECT status, run_at, created_at, attempts FROM jobs WHERE tenant_id = $1 AND kind = 'scoreboard.rollup'`, [T]))[0]!;
    expect(job.status).toBe('pending');
    expect(job.run_at.getTime() - Date.now()).toBeGreaterThan(SCOREBOARD_ROLLUP_EVERY_MS - 120_000);
    await expectRollupRowsExact();
  }, 300_000);
});
