// Lane perf-misses-2: smart-list runs for viewers without the 'book' hint add a value-driven clause
//   c.id IN (SELECT contact_id FROM contact_tags | contact_field_values WHERE <the same tag / value condition>)
// that the WHERE already implies (repos/people.ts driverSql). This proves it changes no row: for every
// definition below and every request context (each role, the system actor, support without and with a
// grant, a client principal), the driven WHERE and the plain WHERE return the same ids, read as app_user
// through RLS in one transaction. The fixture is the CI-sized load seed plus the list workload (tags,
// typed values) and parity rows placed on pond, offered, deleted, merged and deal contacts.
import type { Actor, TenantId, UserId } from '@realty/core/foundation';
import { compileList, type ListCursor, type ListPlan, SmartListDefinitionSchema } from '@realty/core/parity/lists';
import { createDatabase, type Database, withTenantTx } from '@realty/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadUrls } from '../load/db.js';
import { type EqActor, enterAs, equivalenceActors, leave } from '../load/equivalenceActors.js';
import { loadUuid } from '../load/generate.js';
import { seedLoad } from '../load/seed.js';
import { benchDefinitions } from './perf/listsBench.js';
import { perfFieldId, perfTagId, seedLists } from './perf/seedLists.js';
import { driverSql, pageKeys, pageKeysVia, pageQuery, plainWhereSql, whereSql } from './repos/people.js';
import { limitListStatement, mapListsDbError } from './common.js';
import { sql } from 'kysely';
import { viewerFor } from './run.js';

const DB = `realty_lists_vd_${process.pid}`;
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant');
let su: pg.Client;
let database: Database;
let actors: EqActor[] = [];
const plans: { name: string; plan: ListPlan }[] = [];

const tag = (i: number) => perfTagId(SLUG, i);
const field = (k: string) => perfFieldId(SLUG, k);
const EXTRA = [
  { name: 'tag: all of two', definition: { v: 1, all: [{ kind: 'tag', op: 'all', tagIds: [tag(10), tag(11)] }] } },
  { name: 'field set', definition: { v: 1, all: [{ kind: 'field', fieldId: field('lender'), op: 'set' }] } },
  { name: 'text contains', definition: { v: 1, all: [{ kind: 'field', fieldId: field('area'), op: 'text_contains', value: 'a' }] } },
  { name: 'date between', definition: { v: 1, all: [{ kind: 'field', fieldId: field('closing_date'), op: 'date_after', value: '2020-01-01' }] } },
  { name: 'opt all', definition: { v: 1, all: [{ kind: 'field', fieldId: field('features'), op: 'opt_all', optionIds: ['pool', 'garage'] }] } },
  { name: 'nested and: stage then tag', definition: { v: 1, all: [{ kind: 'stage', in: ['new', 'nurture', 'active'] }, { kind: 'tag', op: 'any', tagIds: [tag(190), tag(7)] }] } },
  { name: 'name contains, rare', definition: { v: 1, all: [{ kind: 'name', contains: 'zq' }] } },
  { name: 'tag none (no driver)', definition: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [tag(5)] }] } },
];

beforeAll(async () => {
  await seedLoad({ db: DB, contacts: 1_500, log: () => {} });
  await seedLists({ ownerUrl: loadUrls(DB).ownerUrl, log: () => {}, slugs: [SLUG] });
  su = new pg.Client({ connectionString: loadUrls(DB).ownerUrl });
  await su.connect();
  // parity rows on the contacts whose detail is hidden from some viewers: pond and offered (only collaborators,
  // deal members, Team Leads and tenant-wide viewers see their detail), soft-deleted and merged contacts
  const special = (await su.query<{ id: string }>(
    `(SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'in_pond' ORDER BY id LIMIT 20)
     UNION ALL (SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'offered' ORDER BY id LIMIT 20)
     UNION ALL (SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'owned' ORDER BY id LIMIT 10)`, [T])).rows.map((r) => r.id);
  for (const id of special) {
    await su.query(`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind) VALUES ($1, $2, $3, 'migrated'), ($1, $2, $4, 'migrated') ON CONFLICT DO NOTHING`, [T, id, tag(10), tag(190)]);
  }
  await su.query(`UPDATE contacts SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, special.slice(40, 45)]).catch(() => undefined);
  // open tasks without a due date (the next-task key ignores them): on people with no other open task and on
  // people with a dated one, so the NULL-key boundary of the next-task page shape is exercised
  const noTask = (await su.query<{ id: string }>(`SELECT c.id FROM contacts c WHERE c.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id) ORDER BY c.id LIMIT 30`, [T])).rows.map((r) => r.id);
  const dated = (await su.query<{ id: string }>(`SELECT DISTINCT contact_id AS id FROM tasks WHERE tenant_id = $1 AND status = 'open' AND due_at IS NOT NULL AND contact_id IS NOT NULL ORDER BY 1 LIMIT 10`, [T])).rows.map((r) => r.id);
  for (const id of [...noTask, ...dated]) {
    await su.query(`INSERT INTO tasks SELECT (jsonb_populate_record(NULL::tasks, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'contact_id', $2::uuid, 'due_at', NULL, 'kind', 'todo',
                      'source_claim_id', NULL, 'needs_review', false))).* FROM (SELECT * FROM tasks WHERE tenant_id = $1 AND status = 'open' AND contact_id IS NOT NULL ORDER BY id LIMIT 1) t`, [T, id]);
  }
  database = createDatabase({ url: loadUrls(DB).appUserUrl, max: 2 });
  actors = await equivalenceActors(su, T);
  const owner = (await su.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [T])).rows[0]!.user_id;
  const ownerActor: Actor = { kind: 'user', userId: owner as UserId, tenantId: T as TenantId, role: 'owner', sessionId: 'eq' };
  for (const d of [...benchDefinitions(SLUG), ...EXTRA]) {
    const plan = await withTenantTx(ownerActor, async (tx) => {
      const def = SmartListDefinitionSchema.parse(d.definition);
      const r = compileList(def, await viewerFor(tx, def));
      if (!r.ok) throw new Error(`${d.name}: ${r.code}`);
      return r.plan;
    }, { db: database });
    plans.push({ name: d.name, plan });
  }
}, 900_000);

afterAll(async () => {
  await su?.end();
  await database?.close();
  const admin = new pg.Client({ connectionString: loadUrls(DB).adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).finally(() => admin.end());
}, 120_000);

async function ids(c: pg.Client, where: ReturnType<typeof whereSql>): Promise<string[]> {
  const q = (await import('kysely')).sql`SELECT c.id FROM contacts c WHERE ${where} ORDER BY c.id`.compile(database.kysely);
  return (await c.query<{ id: string }>(q.sql, q.parameters as unknown[])).rows.map((r) => r.id);
}

describe('value-driven list runs return the same people (lane perf-misses-2)', () => {
  it('the fixture exercises the driver: most definitions have one, and some lists are non-empty for every staff viewer kind', () => {
    expect(plans.filter((p) => driverSql(p.plan.where) !== null).length).toBeGreaterThanOrEqual(10);
    expect(actors.map((a) => a.label)).toEqual(expect.arrayContaining(['system', 'support (no grant)', 'support (grant)', 'client principal']));
    expect(new Set(actors.filter((a) => a.actorKind === 'user').map((a) => a.label.split(':')[0]))).toEqual(new Set(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc']));
  });

  it('driven WHERE = plain WHERE, id for id, for every definition and request context', async () => {
    const diffs: string[] = [];
    let nonEmpty = 0;
    for (const a of actors) {
      await su.query('BEGIN');
      try {
        await enterAs(su, a);
        for (const p of plans) {
          const plain = await ids(su, plainWhereSql(p.plan));
          const driven = await ids(su, whereSql(p.plan, null, { driven: true }));
          if (plain.length > 0) nonEmpty++;
          if (plain.join() !== driven.join()) diffs.push(`${a.label} / ${p.name}: plain ${plain.length}, driven ${driven.length}`);
        }
        await leave(su);
      } finally {
        await su.query('ROLLBACK');
      }
    }
    expect(diffs).toEqual([]);
    expect(nonEmpty).toBeGreaterThan(plans.length * 6);
  }, 600_000);

  it('the Owner/Admin next-task page in two parts (dated tasks, then the undated) = the single-scan page, page after page, for every context', async () => {
    const diffs: string[] = [];
    const sorted = plans.filter((p) => ['everyone (People tab)', 'tag: popular', 'stage + active in 30 days', 'overdue task'].includes(p.name))
      .map((p) => ({ ...p, plan: { ...p.plan, sort: 'next_task_asc' as const } }));
    const run = async (q: ReturnType<typeof pageQuery>) => {
      const c = q.compile(database.kysely);
      return (await su.query<{ id: string; sort_key: string | null }>(c.sql, c.parameters as unknown[])).rows;
    };
    let rows = 0;
    let crossed = 0;
    for (const a of actors) {
      await su.query('BEGIN');
      try {
        await enterAs(su, a);
        for (const p of sorted) {
          // pages of 40 through the cursor until the list ends (crossing from dated into undated people)
          let cur: ListCursor | null = null;
          for (let page = 0; page < 60; page++) {
            const plain = await run(pageQuery(p.plan, cur, 40, 'wide'));
            const parts = await pageKeysVia(run, p.plan, cur, 40, 'wide');
            rows += plain.length;
            if (plain.some((r) => r.sort_key === null) && plain.some((r) => r.sort_key !== null)) crossed++;
            if (JSON.stringify(plain) !== JSON.stringify(parts)) diffs.push(`${a.label} / ${p.name} page ${page}: plain ${plain.length}, parts ${parts.length}`);
            const last = plain[plain.length - 1];
            if (!last || plain.length < 40) break;
            cur = { sort: 'next_task_asc', key: last.sort_key, id: last.id };
          }
        }
        await leave(su);
      } finally {
        await su.query('ROLLBACK');
      }
    }
    expect(diffs).toEqual([]);
    expect(rows).toBeGreaterThan(1000);
    expect(crossed).toBeGreaterThan(0);
  }, 900_000);
  it('the Owner/Admin name-filter page from a bounded prefix of the sort index = the single-scan page, page after page, for every context', async () => {
    const diffs: string[] = [];
    const named = plans.filter((p) => p.name === 'name contains' || p.name === 'name contains, rare');
    expect(named.length).toBe(2);
    const variants = named.flatMap((p) => (['last_activity_desc', 'created_desc', 'name_asc'] as const).map((sort) => ({ name: `${p.name} by ${sort}`, plan: { ...p.plan, sort } })));
    const run = async (q: ReturnType<typeof pageQuery>) => {
      const c = q.compile(database.kysely);
      return (await su.query<{ id: string; sort_key: string | null }>(c.sql, c.parameters as unknown[])).rows;
    };
    const pin = async (off: boolean) => void (await su.query(off ? 'SET LOCAL enable_sort = off' : 'SET LOCAL enable_sort = on'));
    let rows = 0;
    for (const a of actors) {
      await su.query('BEGIN');
      try {
        await enterAs(su, a);
        for (const p of variants) {
          let cur: ListCursor | null = null;
          for (let page = 0; page < 8; page++) {
            const plain = await run(pageQuery(p.plan, cur, 40, 'wide'));
            // the production prefix, and a short one (100 rows, smaller than this tenant) so both outcomes occur:
            // a prefix holding the whole page, and one that falls back to the single scan
            for (const prefix of [undefined, 100]) {
              const viaPrefix = await pageKeysVia(run, p.plan, cur, 40, 'wide', pin, prefix);
              if (JSON.stringify(plain) !== JSON.stringify(viaPrefix)) diffs.push(`${a.label} / ${p.name} page ${page} prefix ${prefix ?? 'default'}: plain ${plain.length}, prefix ${viaPrefix.length}`);
            }
            rows += plain.length;
            const last = plain[plain.length - 1];
            if (!last || plain.length < 40) break;
            cur = { sort: p.plan.sort, key: last.sort_key, id: last.id };
          }
        }
        await leave(su);
      } finally {
        await su.query('ROLLBACK');
      }
    }
    expect(diffs).toEqual([]);
    expect(rows).toBeGreaterThan(500);
  }, 900_000);
  it('review fixes: the wide next-task page is ONE statement (one snapshot), and a timeout in a pinned statement surfaces as the timeout (LIST_TOO_SLOW), not 25P02', async () => {
    const next = plans.find((p) => p.name === 'everyone (People tab)')!;
    const statements: string[] = [];
    await su.query('BEGIN');
    try {
      await enterAs(su, actors.find((a) => a.label.startsWith('owner:'))!);
      const run = async (q: ReturnType<typeof pageQuery>) => {
        const c = q.compile(database.kysely);
        statements.push(c.sql);
        return (await su.query<{ id: string; sort_key: string | null }>(c.sql, c.parameters as unknown[])).rows;
      };
      for (const cur of [null, { sort: 'next_task_asc' as const, key: null, id: '00000000-0000-0000-0000-000000000000' }]) {
        statements.length = 0;
        await pageKeysVia(run, { ...next.plan, sort: 'next_task_asc' }, cur, 40, 'wide', async () => {});
        expect(statements).toHaveLength(1);
      }
      await leave(su);
    } finally {
      await su.query('ROLLBACK');
    }
    // the real path (withTenantTx, the list timeout, pageKeys): the prefix statement times out; the error that
    // reaches mapListsDbError is the timeout itself (the abort is not hidden by resetting enable_sort)
    const named = plans.find((p) => p.name === 'name contains')!;
    const owner = actors.find((a) => a.label.startsWith('owner:'))!;
    const err = await withTenantTx({ kind: 'user', userId: owner.userId as UserId, tenantId: T as TenantId, role: 'owner', sessionId: 'eq' }, async (tx) => {
      await limitListStatement(tx, 1);
      await sql`SELECT pg_sleep(0)`.execute(tx);
      return pageKeys(tx, named.plan, null, 40, 'wide');
    }, { db: database }).then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('57014');
    expect(mapListsDbError(err)?.code).toBe('LIST_TOO_SLOW');
  }, 120_000);
});
