// Re-inquiry periods in the speed-to-lead definitions (migration *_api_accountability_reinquiry_periods.sql;
// owner decision 2026-11-11, docs/DATA_MODEL.md R-ACC-2 / E68) over real Postgres. The database is migrated up
// to the migration before it and its days are rolled by the old definitions, then the migration is applied, as
// on a live deployment. Checked: the rule in v_speed_to_lead, app.scoreboard_speed and the rollup's rows; the
// backfill marks that keep the already-rolled days exact; and the dirty-day marks of later ledger writes.
//
// The rule: a reinquiry whose payload has newPeriod = true (R-OWN-20: the owner's new SLA period) is a period
// of its own and ends the earlier period's first-touch window. A plain reinquiry ends nothing.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantId } from '@realty/core/foundation';
import { type Database, createDatabase, withTenantTx } from '@realty/db';
import { listMigrations, migrate } from '@realty/db/migrate';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../load/db.js';
import { defaultSpec, generateLoad, loadUuid } from '../load/generate.js';
import { kekFromEnv } from '../load/seed.js';
import { systemActor } from '../worker/systemActor.js';
import * as repo from './repos/scoreboard.js';
import { rollScoreboard } from './scoreboardRollup.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const T = loadUuid('load-big', 'tenant') as TenantId;
const ZONE = 'America/Los_Angeles'; // the generated tenant's zone
const THIS_MIGRATION = /_api_accountability_reinquiry_periods\.sql$/;

let db: TestDb;
let su: pg.Pool;
let database: Database;
let dir: string;
let agent: string;
let memberIds: string[];

const sys = () => systemActor(T, 'worker');
const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await su.query<R>(text, values)).rows;

/** One event of a hand-built ledger shape, `daysAgo` before now; period starts get a deadline 15 minutes later. */
type Ev = { type: 'assigned' | 'reinquiry' | 'first_touch_recorded'; daysAgo: number; newPeriod?: boolean };

/** The shapes, each on its own contact, all owned by `agent` in the ledger. */
const SHAPES = {
  // missed, then a new period: the touch after the re-inquiry is the newer period's
  superseded: [{ type: 'assigned', daysAgo: 12 }, { type: 'reinquiry', daysAgo: 8, newPeriod: true }, { type: 'first_touch_recorded', daysAgo: 6 }],
  // a plain re-inquiry (no new SLA) ends nothing: the touch is the period's
  plain: [{ type: 'assigned', daysAgo: 20 }, { type: 'reinquiry', daysAgo: 18 }, { type: 'first_touch_recorded', daysAgo: 17 }],
  // touched late before the re-inquiry, then the newer period's own touch
  touchedBefore: [{ type: 'assigned', daysAgo: 12 }, { type: 'first_touch_recorded', daysAgo: 11 }, { type: 'reinquiry', daysAgo: 8, newPeriod: true }, { type: 'first_touch_recorded', daysAgo: 6 }],
  // a re-inquiry period still untouched (touched later, after its day was rolled)
  open: [{ type: 'assigned', daysAgo: 12 }, { type: 'reinquiry', daysAgo: 5, newPeriod: true }],
  // periods that get a backdated re-inquiry after the migration
  laterNew: [{ type: 'assigned', daysAgo: 15 }],
  laterPlain: [{ type: 'assigned', daysAgo: 15 }],
} satisfies Record<string, Ev[]>;
type Shape = keyof typeof SHAPES;
const contactOf = {} as Record<Shape, string>;

/**
 * Appends events to a contact's ledger head through the ledger guard (one command id per transaction). Instants
 * are whole milliseconds, so they compare exactly with what node-pg reads back.
 */
async function append(contactId: string, events: readonly Ev[], at: 'now' | 'daysAgo' = 'daysAgo'): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.ownership_command', gen_random_uuid()::text, true)`);
    for (const e of events) {
      await c.query(
        `WITH t AS (SELECT date_trunc('milliseconds', CASE WHEN $5 THEN clock_timestamp() ELSE clock_timestamp() - ($4::int * interval '1 day') END) AS at)
         INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, deadline_at,
                                            actor_kind, reason_code, command_id, occurred_at, payload)
         SELECT $1, $2, (SELECT max(seq) + 1 FROM lead_ownership_events WHERE tenant_id = $1 AND contact_id = $2), gen_random_uuid(), $3, 'owned', 'owned', $6,
                CASE WHEN $3 = 'assigned' OR $7 THEN t.at + interval '15 minutes' END, 'system', 'TEST_SHAPE',
                current_setting('app.ownership_command')::uuid, t.at, CASE WHEN $7 THEN '{"newPeriod": true, "releaseDueAt": null}' ELSE '{}' END::jsonb
           FROM t`,
        [T, contactId, e.type, e.daysAgo, at === 'now', agent, e.newPeriod === true],
      );
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The shape's events as written: occurred_at, deadline and local day, in seq order. */
async function eventsOf(shape: Shape): Promise<{ type: string; at: Date; due: Date | null; day: string }[]> {
  return q<{ type: string; at: Date; due: Date | null; day: string }>(
    `SELECT type, occurred_at AS at, deadline_at AS due, app.scoreboard_day_of(occurred_at, $3)::text AS day FROM lead_ownership_events
      WHERE tenant_id = $1 AND contact_id = $2 AND reason_code = 'TEST_SHAPE' ORDER BY seq`,
    [T, contactOf[shape], ZONE],
  );
}

const marks = async () => (await q<{ day: string }>(`SELECT DISTINCT day::text FROM scoreboard_rollup_dirty WHERE tenant_id = $1 ORDER BY 1`, [T])).map((r) => r.day);

/** Pretends the horizon has passed (scoreboard_rollup.test.ts tests the horizon): every closed day is safe. */
async function forceSafe(): Promise<void> {
  await q(
    `INSERT INTO scoreboard_rollup_state (tenant_id, zone, safe_until)
       SELECT tenant_id, default_timezone, clock_timestamp() FROM tenant_settings WHERE tenant_id = $1
     ON CONFLICT (tenant_id) DO UPDATE SET zone = EXCLUDED.zone, safe_until = EXCLUDED.safe_until, pending_at = NULL, pending_xid = NULL`,
    [T],
  );
}

/** The job's roll step, run to completion as the tenant's system actor. */
async function rollAll(): Promise<void> {
  await forceSafe();
  for (let i = 0; i < 10; i++) {
    const r = await withTenantTx(sys(), (tx) => rollScoreboard(tx), { db: database });
    if (r.pendingDays === 0) return;
  }
  throw new Error('rollup did not finish');
}

/** The scoreboard's speed rows through the rollup equal the all-live ones (every member, 30 days). */
async function expectPathsAgree(label: string): Promise<void> {
  await withTenantTx(sys(), async (tx, now) => {
    const b = await repo.rangeBounds(tx, '30d', now);
    const norm = (rows: Awaited<ReturnType<typeof repo.speedRows>>) =>
      rows.map((r) => [r.userId, r.ownedAt, r.firstTouchDueAt, r.firstTouchAt]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(norm(await repo.speedRows(tx, memberIds, b.from, b.to)), label).toEqual(norm(await repo.liveSpeedRows(tx, memberIds, b.from, b.to)));
  }, { db: database });
}

/** app.scoreboard_speed rows of the agent over the last 30 days, as the system actor: owned_at -> first touch. */
async function liveSpeed(): Promise<Map<number, number | null>> {
  const r = await withTenantTx(sys(), (tx) => sql<{ owned_at: Date; first_touch_at: Date | null }>`
    SELECT owned_at, first_touch_at FROM app.scoreboard_speed(${[agent]}::uuid[], now() - interval '30 days', now())`.execute(tx), { db: database });
  return new Map(r.rows.map((x) => [x.owned_at.getTime(), x.first_touch_at?.getTime() ?? null]));
}

beforeAll(async () => {
  // a database at the migration before this one
  dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
  // every migration that sorts before this one (later ones, from later batches, are applied with it below)
  const all = listMigrations(MIGRATIONS_DIR);
  const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
  expect(at).toBeGreaterThan(0);
  const before = all.slice(0, at);
  for (const m of before) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
  db = await createTestDb({ migrationsDir: dir });
  const spec = defaultSpec(150, PH);
  spec.tenants = spec.tenants.slice(0, 1).map((t) => ({ ...t, contacts: 150 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  database = createDatabase({ url: db.appUserUrl, max: 2 });
  memberIds = (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 ORDER BY user_id`, [T])).map((r) => r.user_id);
  agent = (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'agent' ORDER BY user_id LIMIT 1`, [T]))[0]!.user_id;
  // contacts whose ledger is older than every shape event, so each shape is the newest part of its ledger
  const old = await q<{ contact_id: string }>(
    `SELECT contact_id FROM lead_ownership_events WHERE tenant_id = $1 GROUP BY contact_id
      HAVING max(occurred_at) < now() - interval '25 days' ORDER BY md5(contact_id::text) LIMIT $2`,
    [T, Object.keys(SHAPES).length],
  );
  expect(old.length).toBe(Object.keys(SHAPES).length);
  for (const [i, [shape, events]] of Object.entries(SHAPES).entries()) {
    contactOf[shape as Shape] = old[i]!.contact_id;
    await append(old[i]!.contact_id, events);
  }
  // the days rolled by the OLD definitions: the superseded period took the newer period's touch; the newer period has no row
  await rollAll();
  const [p, r, f] = await eventsOf('superseded');
  const rolled = await q<{ owned_at: Date; first_touch_at: Date | null }>(
    `SELECT owned_at, first_touch_at FROM scoreboard_speed_daily WHERE tenant_id = $1 AND user_id = $2 AND owned_at = ANY ($3::timestamptz[])`,
    [T, agent, [p!.at, r!.at]],
  );
  expect(rolled.map((x) => [x.owned_at.getTime(), x.first_touch_at?.getTime() ?? null])).toEqual([[p!.at.getTime(), f!.at.getTime()]]);
  expect(await marks()).toEqual([]);
  // ... then this migration, as on a live deployment
  const applied = await migrate(db.ownerUrl, MIGRATIONS_DIR);
  expect(applied.applied).toHaveLength(listMigrations(MIGRATIONS_DIR).length - before.length);
  expect(applied.applied[0]).toMatch(THIS_MIGRATION);
}, 600_000);

afterAll(async () => {
  await su?.end();
  await database?.close();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('re-inquiry periods (owner decision 2026-11-11, R-ACC-2 E68)', () => {
  it('the migration marks the rolled days whose speed rows change (each re-inquiry period\'s day and the day of the period before it), so the scoreboard is exact before the job re-rolls them', async () => {
    const days = new Set<string>();
    for (const shape of ['superseded', 'touchedBefore', 'open'] as const) for (const e of await eventsOf(shape)) if (e.due !== null) days.add(e.day);
    expect(days.size).toBeGreaterThanOrEqual(3);
    expect(await marks()).toEqual([...days].sort()); // the plain re-inquiry's days are not marked
    await expectPathsAgree('after the migration, before the re-roll');
    await rollAll();
    expect(await marks()).toEqual([]);
    await expectPathsAgree('re-rolled');
    // equal paths are not enough: the rolled rows hold the newer periods, with their own first touches
    const [, r, f] = await eventsOf('superseded');
    const row = await q<{ first_touch_at: Date | null }>(`SELECT first_touch_at FROM scoreboard_speed_daily WHERE tenant_id = $1 AND user_id = $2 AND owned_at = $3`, [T, agent, r!.at]);
    expect(row.map((x) => x.first_touch_at?.getTime())).toEqual([f!.at.getTime()]);
  });

  it('v_speed_to_lead and app.scoreboard_speed: a new-period re-inquiry is its own period and takes the touch after it; the earlier period keeps only a touch made before it; a plain re-inquiry ends nothing', async () => {
    const live = await liveSpeed();
    const [p, r, f] = await eventsOf('superseded');
    expect([live.get(p!.at.getTime()), live.get(r!.at.getTime())]).toEqual([null, f!.at.getTime()]);
    const [p2, q2, f2] = await eventsOf('plain');
    expect([live.get(p2!.at.getTime()), live.has(q2!.at.getTime())]).toEqual([f2!.at.getTime(), false]);
    const [p3, f3, r3, f3b] = await eventsOf('touchedBefore');
    expect([live.get(p3!.at.getTime()), live.get(r3!.at.getTime())]).toEqual([f3!.at.getTime(), f3b!.at.getTime()]);
    const [p4, r4] = await eventsOf('open');
    expect([live.get(p4!.at.getTime()), live.get(r4!.at.getTime())]).toEqual([null, null]);
    // the view (the documented definition) says the same, with its response time and SLA flag (the contact's
    // ledger before the shape is older than 25 days)
    const view = await q<{ owned_at: Date; first_touch_at: Date | null; response_seconds: string | null; within_sla: boolean }>(
      `SELECT owned_at, first_touch_at, response_seconds, within_sla FROM v_speed_to_lead
        WHERE tenant_id = $1 AND contact_id = $2 AND owned_at > now() - interval '25 days' ORDER BY owned_seq`,
      [T, contactOf.superseded],
    );
    expect(view.map((v) => [v.owned_at.getTime(), v.first_touch_at?.getTime() ?? null, v.within_sla])).toEqual([
      [p!.at.getTime(), null, false],
      [r!.at.getTime(), f!.at.getTime(), false],
    ]);
    expect(Number(view[1]!.response_seconds)).toBe(Math.round((f!.at.getTime() - r!.at.getTime()) / 1000));
  });

  it('dirty-day marks: a first touch marks the day of the re-inquiry period it belongs to; a backdated new-period re-inquiry marks its own day; a plain one marks nothing', async () => {
    await rollAll();
    expect(await marks()).toEqual([]);
    const [, r4] = await eventsOf('open');
    await append(contactOf.open, [{ type: 'first_touch_recorded', daysAgo: 0 }], 'now');
    await append(contactOf.laterNew, [{ type: 'reinquiry', daysAgo: 3, newPeriod: true }]);
    await append(contactOf.laterPlain, [{ type: 'reinquiry', daysAgo: 2 }]);
    const [, r5] = await eventsOf('laterNew');
    expect(await marks()).toEqual([r4!.day, r5!.day].sort());
    await expectPathsAgree('dirty, before the re-roll');
    const live = await liveSpeed();
    const [, , f4] = await eventsOf('open');
    expect(live.get(r4!.at.getTime())).toBe(f4!.at.getTime());
    expect(live.get(r5!.at.getTime())).toBeNull();
    await rollAll();
    expect(await marks()).toEqual([]);
    await expectPathsAgree('re-rolled');
  });
});
