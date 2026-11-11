// The smart-list perf bench (R-PAR-29): first page p95 ≤ 400 ms and count p95 ≤ 800 ms, for an Owner
// and for an Agent owning about 2,000 people, through the real server in process (LoadBench: session
// cookie, authorize, withTenantTx as app_user under FORCE RLS, Zod serialization), on a load database
// seeded by `pnpm load:seed` + seedLists.ts. Also records EXPLAIN plans of the first page.
//
//   pnpm --filter @realty/api exec tsx --env-file-if-exists=../../.env --conditions=@realty/source src/lists/perf/listsBench.ts [--db realty_load] [--n 30] [--out lists-bench.json]
import { writeFileSync } from 'node:fs';
import type { Actor, Role, TenantId, UserId } from '@realty/core/foundation';
import { compileList, SmartListDefinitionSchema } from '@realty/core/parity/lists';
import { withTenantTx } from '@realty/db';
import { LoadBench, type Measurement } from '../../load/bench.js';
import { loadUuid } from '../../load/generate.js';
import { argValue } from '../../load/seed.js';
import { pageQuery, countQuery } from '../repos/people.js';
import { viewerFor } from '../run.js';
import { limitListStatement } from '../common.js';
import { perfFieldId, perfTagId } from './seedLists.js';

export const LIST_BUDGET = { page: [400, 'R-PAR-29: first page p95 ≤ 400 ms'] as [number, string], count: [800, 'R-PAR-29: count p95 ≤ 800 ms'] as [number, string] };

export function benchDefinitions(slug: string): { name: string; definition: unknown; sort?: string }[] {
  const tag = (i: number) => perfTagId(slug, i);
  const field = (k: string) => perfFieldId(slug, k);
  return [
    { name: 'everyone (People tab)', definition: { v: 1 } },
    { name: 'tag: popular', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [tag(10)] }] } },
    { name: 'tag: rare', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [tag(190)] }] } },
    { name: 'tag: none of', definition: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [tag(5)] }] } },
    { name: 'stage + active in 30 days', definition: { v: 1, all: [{ kind: 'stage', in: ['nurture', 'active'] }, { kind: 'last_activity', op: 'within_days', days: 30 }] } },
    { name: 'my new leads with a tag', definition: { v: 1, all: [{ kind: 'owner', is: 'me' }, { kind: 'stage', in: ['new', 'attempting'] }, { kind: 'tag', op: 'any', tagIds: [tag(20), tag(30)] }] } },
    { name: 'budget ≥ 1.5M', definition: { v: 1, all: [{ kind: 'field', fieldId: field('budget'), op: 'num_gte', value: 1_500_000 }] } },
    { name: 'birthday in 14 days', definition: { v: 1, all: [{ kind: 'field', fieldId: field('birthday'), op: 'coming_up', days: 14 }] } },
    { name: 'features pool + timeline now', definition: { v: 1, all: [{ kind: 'field', fieldId: field('features'), op: 'opt_any', optionIds: ['pool'] }, { kind: 'field', fieldId: field('timeline'), op: 'opt_any', optionIds: ['now'] }] } },
    { name: 'overdue task', definition: { v: 1, all: [{ kind: 'next_task', op: 'overdue' }] } },
    { name: 'name contains', definition: { v: 1, all: [{ kind: 'name', contains: 'son' }] } },
    { name: 'OR group (tag or stage)', definition: { v: 1, any: [{ kind: 'tag', op: 'any', tagIds: [tag(50)] }, { kind: 'stage', in: ['under_contract'] }] } },
    { name: 'everyone by name', definition: { v: 1 }, sort: 'name_asc' },
    { name: 'everyone by next task', definition: { v: 1 }, sort: 'next_task_asc' },
    // lane people-filters: the exclusion shapes (E194-E197)
    { name: 'stage is not: closed, lost', definition: { v: 1, all: [{ kind: 'stage', not_in: ['closed', 'lost'] }] } },
    { name: 'source is not Zillow', definition: { v: 1, all: [{ kind: 'source', not_in: [loadUuid(slug, 'source:0')] }] } },
    { name: 'tag none of + stage is', definition: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [tag(5), tag(10)] }, { kind: 'stage', in: ['active', 'nurture'] }] } },
    { name: 'three filters (stage not, source not, tag none)', definition: { v: 1, all: [{ kind: 'stage', not_in: ['lost'] }, { kind: 'source', not_in: [loadUuid(slug, 'source:2')] }, { kind: 'tag', op: 'none', tagIds: [tag(5)] }] } },
    { name: 'owner is not (five agents)', definition: { v: 1, all: [{ kind: 'owner', not_in: [1, 2, 3, 4, 5].map((i) => loadUuid(slug, `user:agent:${i}`)) }] } },
    { name: 'intent is not buyer', definition: { v: 1, all: [{ kind: 'intent', not_in: ['buyer'] }] } },
    { name: 'stage is not: all but under contract (selective)', definition: { v: 1, all: [{ kind: 'stage', not_in: ['new', 'attempting', 'connected', 'nurture', 'active', 'closed', 'lost'] }] } },
  ];
}

interface Who {
  label: string;
  userId: string;
  role: Role;
  book: number;
}

async function people(b: LoadBench): Promise<Who[]> {
  const books = await b.q<{ user_id: string; n: number }>(
    `SELECT m.user_id, count(c.id)::int AS n FROM memberships m LEFT JOIN contacts c ON c.tenant_id = m.tenant_id AND c.owner_user_id = m.user_id AND c.deleted_at IS NULL
      WHERE m.tenant_id = $1 AND m.role = 'agent' GROUP BY 1 ORDER BY abs(count(c.id) - 2000), 1`, [b.tenantId]);
  const agent = books[0]!;
  return [
    { label: 'owner', userId: loadUuid('load-big', 'user:owner'), role: 'owner', book: -1 },
    { label: `agent (${agent.n} own)`, userId: agent.user_id, role: 'agent', book: agent.n },
  ];
}

export async function runListBench(o: { db: string; n: number; log: (s: string) => void; explain?: boolean; only?: RegExp }): Promise<{ results: Measurement[]; plans: Record<string, unknown>; checks: { name: string; ok: boolean; detail: string }[] }> {
  const b = await LoadBench.open({ db: o.db, iterations: o.n, log: o.log });
  const plans: Record<string, unknown> = {};
  try {
    const defs = benchDefinitions('load-big').filter((d) => !o.only || o.only.test(d.name));
    for (const who of await people(b)) {
      const s = await b.session(who.label, who.userId, who.role);
      for (const d of defs) {
        let next: string | null = null;
        await b.measure(`lists: first page, ${d.name} (${who.label})`, LIST_BUDGET.page, async () => {
          const r = await b.req<{ people: unknown[]; nextCursor: string | null }>(s, 'POST', '/people/query', { definition: d.definition, ...(d.sort ? { sort: d.sort } : {}) });
          if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
          next = r.body.nextCursor;
          return r.ms;
        });
        if (d.name === 'everyone (People tab)' && next) {
          await b.measure(`lists: second page, ${d.name} (${who.label})`, LIST_BUDGET.page, async () => {
            const r = await b.req(s, 'POST', '/people/query', { definition: d.definition, cursor: next });
            if (r.status !== 200) throw new Error(String(r.status));
            return r.ms;
          });
        }
        await b.measure(`lists: count, ${d.name} (${who.label})`, LIST_BUDGET.count, async () => {
          const r = await b.req<{ count: number; capped: boolean }>(s, 'POST', '/people/count', { definition: d.definition });
          if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
          return r.ms;
        });
        if (o.explain !== false) {
          const actor: Actor = { kind: 'user', userId: who.userId as UserId, tenantId: b.tenantId as TenantId, role: who.role, sessionId: 'bench' };
          plans[`${d.name} (${who.label})`] = await withTenantTx(actor, async (tx) => {
            await limitListStatement(tx, 10_000);
            const def = SmartListDefinitionSchema.parse(d.definition);
            const r = compileList(def, await viewerFor(tx, def), { sort: (d.sort ?? 'last_activity_desc') as 'name_asc' });
            if (!r.ok) throw new Error(r.code);
            const q = pageQuery(r.plan, null, 51).compile(tx);
            const e = await tx.executeQuery<{ 'QUERY PLAN': unknown }>({ ...q, sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}` });
            const cq = countQuery(r.plan, 10_000).compile(tx);
            const ce = await tx.executeQuery<{ 'QUERY PLAN': unknown }>({ ...cq, sql: `EXPLAIN (FORMAT JSON) ${cq.sql}` });
            return { page: e.rows[0]!['QUERY PLAN'], count: ce.rows[0]!['QUERY PLAN'] };
          }, { db: b.database }).catch((e: unknown) => ({ error: String((e as Error).message ?? e).slice(0, 200) }));
        }
      }
    }
    return { results: b.results, plans, checks: b.checks };
  } finally {
    await b.close();
  }
}

/** Index and scan nodes of an EXPLAIN JSON plan (for the index-use assertions). */
export function planNodes(plan: unknown): { type: string; relation?: string; index?: string }[] {
  const out: { type: string; relation?: string; index?: string }[] = [];
  const walk = (n: Record<string, unknown>) => {
    out.push({ type: String(n['Node Type']), ...(n['Relation Name'] ? { relation: String(n['Relation Name']) } : {}), ...(n['Index Name'] ? { index: String(n['Index Name']) } : {}) });
    for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  const root = Array.isArray(plan) ? (plan[0] as { Plan: Record<string, unknown> }).Plan : (plan as { Plan: Record<string, unknown> }).Plan;
  walk(root);
  return out;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  const args = process.argv.slice(2);
  const db = argValue(args, 'db') ?? 'realty_load';
  const n = Number(argValue(args, 'n') ?? 30);
  const out = argValue(args, 'out');
  const only = argValue(args, 'only');
  const explain = argValue(args, 'explain') !== 'off';
  runListBench({ db, n, log: (s) => console.log(s), explain, ...(only ? { only: new RegExp(only) } : {}) })
    .then((r) => {
      const miss = r.results.filter((m) => m.pass === false);
      console.log(`\n${r.results.length} measurements, ${miss.length} over budget`);
      for (const m of miss) console.log(`MISS ${m.name}: p95 ${m.p95.toFixed(1)} ms (budget ${m.budgetMs})`);
      if (out) writeFileSync(out, JSON.stringify({ results: r.results, plans: r.plans }, null, 2));
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
