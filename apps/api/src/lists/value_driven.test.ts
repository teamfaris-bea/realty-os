// Lane perf-misses-2: smart-list runs for viewers without the 'book' hint add a value-driven clause
//   c.id IN (SELECT contact_id FROM contact_tags | contact_field_values WHERE <the same tag / value condition>)
// that the WHERE already implies (repos/people.ts driverSql). This proves it changes no row: for every
// definition below and every request context (each role, the system actor, support without and with a
// grant, a client principal), the driven WHERE and the plain WHERE return the same ids, read as app_user
// through RLS in one transaction. The fixture is the CI-sized load seed plus the list workload (tags,
// typed values) and parity rows placed on pond, offered, deleted, merged and deal contacts.
import type { Actor, TenantId, UserId } from '@realty/core/foundation';
import { compileList, type ListPlan, SmartListDefinitionSchema } from '@realty/core/parity/lists';
import { createDatabase, type Database, withTenantTx } from '@realty/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadUrls } from '../load/db.js';
import { type EqActor, enterAs, equivalenceActors, leave } from '../load/equivalenceActors.js';
import { loadUuid } from '../load/generate.js';
import { seedLoad } from '../load/seed.js';
import { benchDefinitions } from './perf/listsBench.js';
import { perfFieldId, perfTagId, seedLists } from './perf/seedLists.js';
import { driverSql, plainWhereSql, whereSql } from './repos/people.js';
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
          const driven = await ids(su, whereSql(p.plan));
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
});
