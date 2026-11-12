// One leaves-the-owner rule in the speed-to-lead definitions (migration *_api_accountability_period_end_withdrawn.sql;
// batch 6 interaction review ownership-sla/F5; docs/DATA_MODEL.md R-ACC-2) over real Postgres. The database is
// migrated up to the migration before it and its days are rolled by the old definitions, then the migration is
// applied, as on a live deployment. Checked: the rule in v_speed_to_lead, app.scoreboard_speed and the rollup's rows;
// the backfill marks that keep the already-rolled days exact; and the dirty-day marks of later ledger writes.
//
// The rule: a period's first-touch window also ends at any event that takes the lead out of `owned` or gives it to
// someone else (an owner-changing merged_in, a deactivation re-route from owned to offered), as the untouched-lead
// card already read it. Before, only the 0001 list and a newPeriod reinquiry ended it, so the new owner's first touch
// after an owner-changing merge was the earlier owner's period's first touch.
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
const THIS_MIGRATION = /_api_accountability_period_end_withdrawn\.sql$/;

let db: TestDb;
let su: pg.Pool;
let database: Database;
let dir: string;
let agent: string;
let other: string;
let memberIds: string[];

const sys = () => systemActor(T, 'worker');
const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await su.query<R>(text, values)).rows;

/**
 * One event of a hand-built ledger shape, `daysAgo` before now (as the engine writes it: the state and owner AFTER
 * it). `assigned` and `offer_accepted` get a first-touch deadline 15 minutes later; `owner` 'other' is the second agent.
 */
type Ev = { type: 'assigned' | 'merged_in' | 'offered' | 'offer_accepted' | 'first_touch_recorded'; daysAgo: number; from: 'owned' | 'offered'; to: 'owned' | 'offered'; owner?: 'agent' | 'other' };

const SHAPES = {
  // an owner-changing merge, then the new owner's touch: before 0047 it was the earlier period's first touch
  mergedAway: [
    { type: 'assigned', daysAgo: 12, from: 'owned', to: 'owned', owner: 'agent' },
    { type: 'merged_in', daysAgo: 8, from: 'owned', to: 'owned', owner: 'other' },
    { type: 'first_touch_recorded', daysAgo: 6, from: 'owned', to: 'owned', owner: 'other' },
  ],
  // a deactivation re-route (owned straight to offered), the next agent's accept and touch: the touch is their period's
  rerouted: [
    { type: 'assigned', daysAgo: 20, from: 'owned', to: 'owned', owner: 'agent' },
    { type: 'offered', daysAgo: 19, from: 'owned', to: 'offered' },
    { type: 'offer_accepted', daysAgo: 18, from: 'offered', to: 'owned', owner: 'other' },
    { type: 'first_touch_recorded', daysAgo: 17, from: 'owned', to: 'owned', owner: 'other' },
  ],
  // a merge that keeps the owner ends nothing: the touch is the period's
  sameOwnerMerge: [
    { type: 'assigned', daysAgo: 25, from: 'owned', to: 'owned', owner: 'agent' },
    { type: 'merged_in', daysAgo: 24, from: 'owned', to: 'owned', owner: 'agent' },
    { type: 'first_touch_recorded', daysAgo: 23, from: 'owned', to: 'owned', owner: 'agent' },
  ],
  // a period that gets an owner-changing merge and the new owner's touch after the migration
  later: [{ type: 'assigned', daysAgo: 15, from: 'owned', to: 'owned', owner: 'agent' }],
} satisfies Record<string, Ev[]>;
type Shape = keyof typeof SHAPES;
const contactOf = {} as Record<Shape, string>;

/** Appends events to a contact's ledger head through the ledger guard (one command id per transaction), whole milliseconds. */
async function append(contactId: string, events: readonly Ev[], at: 'now' | 'daysAgo' = 'daysAgo'): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.ownership_command', gen_random_uuid()::text, true)`);
    for (const e of events) {
      const owner = e.to === 'owned' ? (e.owner === 'other' ? other : agent) : null;
      await c.query(
        `WITH t AS (SELECT date_trunc('milliseconds', CASE WHEN $5 THEN clock_timestamp() ELSE clock_timestamp() - ($4::int * interval '1 day') END) AS at)
         INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, offered_to_user_id, offer_id,
                                            deadline_at, actor_kind, reason_code, command_id, occurred_at, payload)
         SELECT $1, $2, (SELECT max(seq) + 1 FROM lead_ownership_events WHERE tenant_id = $1 AND contact_id = $2), gen_random_uuid(), $3, $7, $8, $6,
                CASE WHEN $3 = 'offered' THEN $9::uuid END, CASE WHEN $3 = 'offered' THEN gen_random_uuid() END,
                CASE WHEN $3 IN ('assigned','offer_accepted') THEN t.at + interval '15 minutes' WHEN $3 = 'offered' THEN t.at + interval '5 minutes' END,
                'system', 'TEST_SHAPE', current_setting('app.ownership_command')::uuid, t.at, '{}'::jsonb
           FROM t`,
        [T, contactId, e.type, e.daysAgo, at === 'now', owner, e.from, e.to, other],
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

/** app.scoreboard_speed rows of both agents over the last 30 days, as the system actor: owned_at -> first touch. */
async function liveSpeed(): Promise<Map<number, number | null>> {
  const r = await withTenantTx(sys(), (tx) => sql<{ owned_at: Date; first_touch_at: Date | null }>`
    SELECT owned_at, first_touch_at FROM app.scoreboard_speed(${[agent, other]}::uuid[], now() - interval '30 days', now())`.execute(tx), { db: database });
  return new Map(r.rows.map((x) => [x.owned_at.getTime(), x.first_touch_at?.getTime() ?? null]));
}

/** The rolled row of a period (by its start), or undefined when that day holds none. */
async function rolledRow(at: Date): Promise<{ first_touch_at: Date | null } | undefined> {
  return (await q<{ first_touch_at: Date | null }>(`SELECT first_touch_at FROM scoreboard_speed_daily WHERE tenant_id = $1 AND owned_at = $2`, [T, at]))[0];
}

beforeAll(async () => {
  // a database at the migration before this one
  dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
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
  const agents = (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'agent' ORDER BY user_id LIMIT 2`, [T])).map((r) => r.user_id);
  expect(agents).toHaveLength(2);
  [agent, other] = agents as [string, string];
  // contacts whose ledger is older than every shape event, so each shape is the newest part of its ledger
  const old = await q<{ contact_id: string }>(
    `SELECT contact_id FROM lead_ownership_events WHERE tenant_id = $1 GROUP BY contact_id
      HAVING max(occurred_at) < now() - interval '30 days' ORDER BY md5(contact_id::text) LIMIT $2`,
    [T, Object.keys(SHAPES).length],
  );
  expect(old.length).toBe(Object.keys(SHAPES).length);
  for (const [i, [shape, events]] of Object.entries(SHAPES).entries()) {
    contactOf[shape as Shape] = old[i]!.contact_id;
    await append(old[i]!.contact_id, events);
  }
  // the days rolled by the OLD definitions: the merged-away period took the new owner's touch
  await rollAll();
  const [p, , f] = await eventsOf('mergedAway');
  expect((await rolledRow(p!.at))?.first_touch_at?.getTime()).toBe(f!.at.getTime());
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

describe('a first-touch window ends however the lead leaves its owner (batch 6 review F5, R-ACC-2)', () => {
  it('R-ACC-2 R-ACC-4: the migration marks the rolled days whose speed rows may change (the period an off-list leaving event fell in), so the scoreboard is exact before the job re-rolls them', async () => {
    const [merged] = await eventsOf('mergedAway');
    const [rerouted] = await eventsOf('rerouted');
    const [same] = await eventsOf('sameOwnerMerge');
    const m = await marks();
    expect(m).toEqual(expect.arrayContaining([merged!.day, rerouted!.day]));
    expect(m).not.toContain(same!.day); // a merge that keeps the owner ends nothing
    await expectPathsAgree('after the migration, before the re-roll');
    await rollAll();
    expect(await marks()).toEqual([]);
    await expectPathsAgree('re-rolled');
    // equal paths are not enough: the re-rolled row of the merged-away period has no first touch now
    expect(await rolledRow(merged!.at)).toEqual({ first_touch_at: null });
  });

  it('R-ACC-2 R-ACC-4 R-OWN-24 R-OWN-22: v_speed_to_lead and app.scoreboard_speed end the window at an owner-changing merge and at a re-route from owned; a merge that keeps the owner ends nothing', async () => {
    const live = await liveSpeed();
    const [p, , f] = await eventsOf('mergedAway');
    expect([live.get(p!.at.getTime()), f!.type]).toEqual([null, 'first_touch_recorded']);
    const [p2, , acc, f2] = await eventsOf('rerouted');
    expect([live.get(p2!.at.getTime()), live.get(acc!.at.getTime())]).toEqual([null, f2!.at.getTime()]);
    const [p3, , f3] = await eventsOf('sameOwnerMerge');
    expect(live.get(p3!.at.getTime())).toBe(f3!.at.getTime());
    // the view (the documented definition) says the same
    const view = await q<{ owned_at: Date; first_touch_at: Date | null; within_sla: boolean }>(
      `SELECT owned_at, first_touch_at, within_sla FROM v_speed_to_lead WHERE tenant_id = $1 AND contact_id = $2 AND owned_at > now() - interval '30 days' ORDER BY owned_seq`,
      [T, contactOf.mergedAway],
    );
    expect(view.map((v) => [v.owned_at.getTime(), v.first_touch_at, v.within_sla])).toEqual([[p!.at.getTime(), null, false]]);
  });

  it('R-ACC-4: dirty-day marks after the migration: an appended owner-changing merge changes no earlier row; the new owner\'s touch after it marks a day and leaves the earlier period untouched', async () => {
    await rollAll();
    expect(await marks()).toEqual([]);
    const [p] = await eventsOf('later');
    await append(contactOf.later, [{ type: 'merged_in', daysAgo: 3, from: 'owned', to: 'owned', owner: 'other' }]);
    expect(await marks()).toEqual([]);
    await append(contactOf.later, [{ type: 'first_touch_recorded', daysAgo: 0, from: 'owned', to: 'owned', owner: 'other' }], 'now');
    expect(await marks()).toEqual([p!.day]);
    await expectPathsAgree('dirty, before the re-roll');
    expect((await liveSpeed()).get(p!.at.getTime())).toBeNull();
    await rollAll();
    expect(await marks()).toEqual([]);
    await expectPathsAgree('re-rolled');
    expect(await rolledRow(p!.at)).toEqual({ first_touch_at: null });
  });
});
