// A merge moves the loser's tasks and appointments (migration *_backlog_merge_work; R-OWN-24, E549, E552). The calendar
// side of E549 (one push, for the future appointment) needs the api's deterministic fake calendar and its reconcile:
// apps/api/src/calendar/backlogMergeWork.test.ts. Every merge goes through the ownership engine as app_user; the
// superuser pool only reads back, except the one bare UPDATE the guard case proves moves nothing.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { type TestDb, createTestDb } from '../src/testing/index.js';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, drainFollowups, type Harness, pendingFollowups, selfCreated, suRows, uuid, type World } from './world.js';

const THIS_MIGRATION = /_backlog_merge_work\.sql$/;
const HOUR = 3_600_000;

interface Work {
  task: string;
  doneTask: string;
  future: string;
  past: string;
}

/** Work of `contactId`, all held by `agentId`: an open and a done task, a future and a past appointment (Owner writes). */
async function seedWork(app: Database, w: World, contactId: string, agentId: string): Promise<Work> {
  const work = { task: uuid(), doneTask: uuid(), future: uuid(), past: uuid() };
  const now = Date.now();
  await withTenantTx(w.owner.actor, async (tx) => {
    await sql`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id)
              VALUES (app.tenant_id(), ${work.task}, ${agentId}, ${contactId}, 'promise', 'Send the comps', ${new Date(now + 24 * HOUR)}, 'user', ${w.owner.id}),
                     (app.tenant_id(), ${work.doneTask}, ${agentId}, ${contactId}, 'todo', 'Book the tour', NULL, 'user', ${w.owner.id})`.execute(tx);
    await sql`UPDATE tasks SET status = 'done', completed_at = now(), completed_by_user_id = ${w.owner.id} WHERE tenant_id = app.tenant_id() AND id = ${work.doneTask}`.execute(tx);
    await sql`INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind)
              VALUES (app.tenant_id(), ${work.future}, ${contactId}, ${agentId}, ${agentId}, 'buyer_consult', ${new Date(now + 48 * HOUR)}, ${new Date(now + 49 * HOUR)}, 'user'),
                     (app.tenant_id(), ${work.past}, ${contactId}, ${agentId}, ${agentId}, 'consult', ${new Date(now - 49 * HOUR)}, ${new Date(now - 48 * HOUR)}, 'user')`.execute(tx);
  }, { db: app });
  return work;
}

interface WorkRow { id: string; contact_id: string; who: string; status: string; sync_version: number | null }
async function workRows(su: pg.Pool, work: Work): Promise<Record<string, Omit<WorkRow, 'id'>>> {
  const rows = await suRows<WorkRow>(su, `
    SELECT id, contact_id, assignee_user_id AS who, status, NULL::int AS sync_version FROM tasks WHERE id = ANY ($1::uuid[])
    UNION ALL
    SELECT id, contact_id, user_id AS who, status, sync_version FROM appointments WHERE id = ANY ($1::uuid[])`, [[work.task, work.doneTask, work.future, work.past]]);
  return Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
}

function expectedOn(work: Work, contactId: string, agentId: string, sync: number) {
  return {
    [work.task]: { contact_id: contactId, who: agentId, status: 'open', sync_version: null },
    [work.doneTask]: { contact_id: contactId, who: agentId, status: 'done', sync_version: null },
    [work.future]: { contact_id: contactId, who: agentId, status: 'scheduled', sync_version: sync },
    [work.past]: { contact_id: contactId, who: agentId, status: 'scheduled', sync_version: sync },
  };
}

async function engineMerge(app: Database, actor: Actor, survivor: ContactId, loser: ContactId): Promise<void> {
  const r = await cmd(app, actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser, ownerChoice: null });
  expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
}

describe('R-OWN-24 a merge moves the loser\'s tasks and appointments', () => {
  let h: Harness;
  let w: World;
  beforeAll(async () => {
    h = await createHarness(6);
    w = await createWorld(h.app, { agents: 1, teamLead: true });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('R-OWN-24 E549: an engine merge moves the loser\'s open task, a future and a past appointment to the survivor, assignee unchanged, sync_version +1 (the calendar push: apps/api calendar/backlogMergeWork.test.ts)', async () => {
    const agent = w.agents[0]!;
    for (const actor of [w.owner.actor, w.tl!.actor]) {
      const s = await selfCreated(h.app, w, agent, 'Mia Survivor');
      const l = await selfCreated(h.app, w, agent, 'Mia Dup');
      const work = await seedWork(h.app, w, l, agent.id);
      const bystander = await seedWork(h.app, w, await selfCreated(h.app, w, agent, 'Bo Bystander'), agent.id);
      const before = await workRows(h.su, bystander);
      expect(await workRows(h.su, work)).toEqual(expectedOn(work, l, agent.id, 1));
      const marksBefore = (await suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM feed_dirty WHERE tenant_id = $1 AND user_id = $2 AND group_key = $3`, [w.tenantId, agent.id, `c:${s}`]))[0]!.n;
      await engineMerge(h.app, actor, s, l);
      // in the merge transaction itself, whoever merges (a Team Lead's follow-up has not run yet)
      if (actor === w.tl!.actor) expect((await pendingFollowups(h.su, w.tenantId)).length).toBeGreaterThan(0);
      expect(await workRows(h.su, work)).toEqual(expectedOn(work, s, agent.id, 2));
      expect(await workRows(h.su, bystander)).toEqual(before);
      // the feed mark of the assignee's survivor group (0034 feed_mark_* run for the definer's write too)
      const marksAfter = (await suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM feed_dirty WHERE tenant_id = $1 AND user_id = $2 AND group_key = $3`, [w.tenantId, agent.id, `c:${s}`]))[0]!.n;
      expect(marksAfter).toBeGreaterThan(marksBefore);
      await drainFollowups(h, w);
      expect(await workRows(h.su, work)).toEqual(expectedOn(work, s, agent.id, 2));
    }
  });

  it('R-OWN-24 E549 (guard): a superuser\'s bare UPDATE moves no task', async () => {
    const agent = w.agents[0]!;
    const s = await selfCreated(h.app, w, agent, 'Ray Survivor');
    const l = await selfCreated(h.app, w, agent, 'Ray Dup');
    const work = await seedWork(h.app, w, l, agent.id);
    // platform maintenance, no tenant context, triggers on: contacts_guard allows it, but it is no engine merge
    const r = await h.su.query('UPDATE contacts SET merged_into_contact_id = $1 WHERE id = $2', [s, l]);
    expect(r.rowCount).toBe(1);
    expect(await workRows(h.su, work)).toEqual(expectedOn(work, l, agent.id, 1));
    // nor can a person call the definer
    await expect(withTenantTx(w.owner.actor, (tx) => sql`SELECT app.contacts_merge_work()`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/);
    const f = (await suRows<{ secdef: boolean; owner: string; config: string[]; pub: boolean }>(h.su, `
      SELECT p.prosecdef AS secdef, r.rolname AS owner, p.proconfig AS config, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'app.contacts_merge_work()'::regprocedure`))[0]!;
    expect(f).toEqual({ secdef: true, owner: 'app_definer', config: ['search_path=pg_catalog, public'], pub: false });
  });
});

describe('R-OWN-24 records merged before the migration', () => {
  let dir: string;
  let db: TestDb;
  let app: Database;
  let su: pg.Pool;
  let w: World;
  let merged: { work: Work; survivor: ContactId };
  let chained: { work: Work; middleWork: Work; root: ContactId };
  let untouched: { work: Work; contact: ContactId };

  beforeAll(async () => {
    // a database at the migration before this one (later ones are applied with it below)
    dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const all = listMigrations(MIGRATIONS_DIR);
    const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
    expect(at).toBeGreaterThan(0);
    for (const m of all.slice(0, at)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
    db = await createTestDb({ migrationsDir: dir });
    app = createDatabase({ url: db.appUserUrl, max: 4 });
    su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
    su.on('error', () => {});
    w = await createWorld(app, { agents: 1 });
    const agent = w.agents[0]!;

    // before the migration: L merged into S, and L2 merged into M later merged into R (the chain's root)
    const l = await selfCreated(app, w, agent, 'Ivy Dup');
    const s = await selfCreated(app, w, agent, 'Ivy Known');
    merged = { work: await seedWork(app, w, l, agent.id), survivor: s };
    await engineMerge(app, w.owner.actor, s, l);
    const l2 = await selfCreated(app, w, agent, 'Pat Dup');
    const m = await selfCreated(app, w, agent, 'Pat Middle');
    const root = await selfCreated(app, w, agent, 'Pat Root');
    chained = { work: await seedWork(app, w, l2, agent.id), middleWork: await seedWork(app, w, m, agent.id), root };
    await engineMerge(app, w.owner.actor, m, l2);
    await engineMerge(app, w.owner.actor, root, m);
    const c = await selfCreated(app, w, agent, 'Una Alone');
    untouched = { work: await seedWork(app, w, c, agent.id), contact: c };
    // the gap: the work stayed on the merged-away records
    expect(await workRows(su, merged.work)).toEqual(expectedOn(merged.work, l, agent.id, 1));
    expect(await workRows(su, chained.work)).toEqual(expectedOn(chained.work, l2, agent.id, 1));

    const applied = await migrate(db.ownerUrl, MIGRATIONS_DIR);
    expect(applied.applied[0]).toMatch(THIS_MIGRATION);
  }, 600_000);
  afterAll(async () => {
    await app?.close();
    await su?.end();
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('R-OWN-24 E552: rows of records merged before the merge-work migration are on the root survivor', async () => {
    const agent = w.agents[0]!.id;
    expect(await workRows(su, merged.work)).toEqual(expectedOn(merged.work, merged.survivor, agent, 2));
    expect(await workRows(su, chained.work)).toEqual(expectedOn(chained.work, chained.root, agent, 2));
    expect(await workRows(su, chained.middleWork)).toEqual(expectedOn(chained.middleWork, chained.root, agent, 2));
    // a record never merged is untouched (no sync_version bump, so no re-push)
    expect(await workRows(su, untouched.work)).toEqual(expectedOn(untouched.work, untouched.contact, agent, 1));
    // nothing is left on any merged-away record
    expect(await suRows(su, `
      SELECT x.id FROM (SELECT tenant_id, id, contact_id FROM tasks UNION ALL SELECT tenant_id, id, contact_id FROM appointments) x
        JOIN contacts c ON c.tenant_id = x.tenant_id AND c.id = x.contact_id AND c.merged_into_contact_id IS NOT NULL
       WHERE x.tenant_id = $1`, [w.tenantId])).toEqual([]);
  });
});
