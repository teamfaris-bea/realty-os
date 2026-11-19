// E796 (b19 review F5): the count the reservation makes under the team model-budget lock reads today's AI assistant
// calls through an index, not every ai_runs row of the tenant. EXPLAIN of the query production runs (spend.ts
// modelBudgetDay and modelBudgetUsageSql), as the system actor that runs it, over a synthetic ledger: 60 days of 20,000 runs of other
// purposes and 3,000 AI assistant calls, 40 of them today. A plan shape, not a timing.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { modelBudgetDay, modelBudgetUsageSql } from './spend.js';
import { assignmentOf, isaLead, isaWorld, startCare } from './testing.js';

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

interface PlanNode { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Filter?: string; Plans?: PlanNode[] }
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
};

it('E796 R-ISA-20: the budget count reads ai_runs by (tenant, purpose, created time): today\'s AI assistant calls only, never the whole ledger', async () => {
  const w = await isaWorld(h);
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  const a = (await assignmentOf(h, lead.id))!;
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,created_at)
    SELECT $1,gen_random_uuid(),'draft','fake-1','synthetic','test','{}'::jsonb,'succeeded', now() - (g % 60) * interval '1 day' - interval '1 minute' FROM generate_series(1,20000) g`, [w.tenantId]);
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,created_at)
    SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded', now() - (1 + g % 59) * interval '1 day' FROM generate_series(1,2960) g`, [w.tenantId, a.id]);
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status)
    SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded' FROM generate_series(1,40)`, [w.tenantId, a.id]);
  await h.su.query(`ANALYZE ai_runs`);
  const actor = systemActor(w.tenantId as never, 'assistant');
  const { plan, usage } = await withTenantTx(actor, async (tx) => {
    const day = await modelBudgetDay(tx);
    const r = await sql<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>`EXPLAIN (FORMAT JSON) ${modelBudgetUsageSql(lead.id, day)}`.execute(tx);
    return { plan: r.rows[0]!['QUERY PLAN'][0].Plan, usage: (await modelBudgetUsageSql(lead.id, day).execute(tx)).rows[0]! };
  }, { db: h.database });
  // the count itself: today's calls only (every one of them this person's)
  expect({ team: usage.team, person: usage.person }).toEqual({ team: 40, person: 40 });
  const text = JSON.stringify(plan, null, 1);
  const runs = walk(plan).filter((n) => n['Relation Name'] === 'ai_runs');
  expect(runs.length, text).toBeGreaterThan(0);
  for (const n of runs) {
    expect(n['Node Type'], text).toMatch(/^(Index Scan|Index Only Scan|Bitmap Heap Scan)$/);
    expect(n['Node Type'], text).not.toBe('Seq Scan');
  }
  const indexed = walk(plan).filter((n) => n['Index Name'] === 'ai_runs_purpose_created_idx');
  expect(indexed.length, text).toBeGreaterThan(0);
  // the purpose and the day's bounds are index conditions, not a filter over the tenant's rows
  expect(indexed[0]!['Index Cond'] ?? '', text).toMatch(/purpose = 'ai_isa_turn'/);
  expect(indexed[0]!['Index Cond'] ?? '', text).toMatch(/created_at >=/);
}, 120_000);
