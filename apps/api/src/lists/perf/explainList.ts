// Bench-only: EXPLAIN (ANALYZE, BUFFERS) of one bench list's first page and count, as the Owner (or --role
// agent: the agent the bench uses), through withTenantTx as app_user. Prints the text plans.
//
//   pnpm --filter @realty/api exec tsx --env-file-if-exists=../../.env --conditions=@realty/source src/lists/perf/explainList.ts --db realty_load --name "tag: popular"
import type { Actor, TenantId, UserId } from '@realty/core/foundation';
import { compileList, SmartListDefinitionSchema } from '@realty/core/parity/lists';
import { createDatabase, withTenantTx } from '@realty/db';
import { loadUrls } from '../../load/db.js';
import { loadUuid } from '../../load/generate.js';
import { argValue } from '../../load/seed.js';
import { limitListStatement } from '../common.js';
import { countQuery, nextTaskPageQuery, pageQuery, scopeHintFor } from '../repos/people.js';
import { sql } from 'kysely';
import { viewerFor } from '../run.js';
import { benchDefinitions } from './listsBench.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbName = argValue(args, 'db') ?? 'realty_load';
  const name = argValue(args, 'name') ?? 'tag: popular';
  const database = createDatabase({ url: loadUrls(dbName).appUserUrl, max: 1 });
  const T = loadUuid('load-big', 'tenant') as TenantId;
  const owner: Actor = { kind: 'user', userId: loadUuid('load-big', 'user:owner') as UserId, tenantId: T, role: 'owner', sessionId: 'explain' };
  const d = benchDefinitions('load-big').find((x) => x.name === name);
  if (!d) throw new Error(`no bench list named ${name}`);
  try {
    await withTenantTx(owner, async (tx) => {
      await limitListStatement(tx, 60_000);
      const def = SmartListDefinitionSchema.parse(d.definition);
      const r = compileList(def, await viewerFor(tx, def), { sort: (d.sort ?? 'last_activity_desc') as 'name_asc' });
      if (!r.ok) throw new Error(r.code);
      const hint = scopeHintFor('owner');
      // the 'next task' page of a wide viewer is the one-statement shape the API runs, with enable_sort pinned off
      const wideNext = r.plan.sort === 'next_task_asc' && hint === 'wide';
      if (wideNext) await sql`SET LOCAL enable_sort = off`.execute(tx);
      for (const [label, q] of [['page', wideNext ? nextTaskPageQuery(r.plan, null, 51, hint) : pageQuery(r.plan, null, 51, hint)], ['count', countQuery(r.plan, 10_000, hint)]] as const) {
        if (argValue(args, 'only') && argValue(args, 'only') !== label) continue;
        const c = q.compile(tx);
        const e = await tx.executeQuery<{ 'QUERY PLAN': string }>({ ...c, sql: `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${c.sql}` });
        console.log(`---- ${label}: ${name}\n${e.rows.map((x) => x['QUERY PLAN']).join('\n')}`);
      }
    }, { db: database });
  } finally {
    await database.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
