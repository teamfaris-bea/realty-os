// RLS plan shape (EXPLAIN snapshots) and the RLS overhead benchmark at 250k contacts per tenant
// (BUILD_PLAN module 7). The data set is a superuser fixture (generate_series, triggers off): 250k
// contacts across 50 agents in tenant A plus 20k in tenant B. This is a single-machine smoke of the
// pre-launch benchmark, not the 3-tenant × 250k load test of the Phase 1 exit criteria.
import { performance } from 'node:perf_hooks';
import type { UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, PH, suFixture, userActor, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
const AGENTS = 50;
const PER_TENANT = 250_000;

async function seed(w: World, n: number): Promise<UserId[]> {
  // 50 agent users + memberships, then n contacts owned round-robin by them (5% in the pond)
  await suFixture(h.su, `
    INSERT INTO users (id, email, display_name, password_hash)
      SELECT gen_random_uuid(), 'bench-' || g || '-' || $2 || '@example.test', 'Bench Agent ' || g, '${PH}' FROM generate_series(1, ${AGENTS}) g;
    INSERT INTO memberships (tenant_id, user_id, role, status, joined_at)
      SELECT $1, u.id, 'agent', 'active', now() FROM users u WHERE u.email LIKE 'bench-%-' || $2 || '@example.test';`, [w.tenantId, w.slug]);
  const agents = (await h.su.query<{ id: UserId }>(`SELECT id FROM users WHERE email LIKE 'bench-%-' || $1 || '@example.test' ORDER BY id`, [w.slug])).rows.map((r) => r.id);
  await suFixture(h.su, `
    WITH a AS (SELECT row_number() OVER (ORDER BY id) - 1 AS k, id FROM users WHERE email LIKE 'bench-%-' || $2 || '@example.test')
    INSERT INTO contacts (tenant_id, id, display_name, first_name, last_name, ownership_state, owner_user_id, pond_id, owned_at,
                          ownership_period_seq, ownership_seq, ownership_command_id, updated_at)
    SELECT $1, gen_random_uuid(), 'Lead ' || g, 'First' || g, 'Last' || g,
           CASE WHEN g % 20 = 0 THEN 'in_pond' ELSE 'owned' END,
           CASE WHEN g % 20 = 0 THEN NULL ELSE a.id END,
           CASE WHEN g % 20 = 0 THEN $3::uuid END,
           CASE WHEN g % 20 = 0 THEN NULL ELSE now() END,
           CASE WHEN g % 20 = 0 THEN NULL ELSE 1 END, 1, gen_random_uuid(), now() - (g || ' seconds')::interval
      FROM generate_series(1, ${n}) g JOIN a ON a.k = g % ${AGENTS}`, [w.tenantId, w.slug, w.pondId]);
  await h.su.query('ANALYZE contacts; ANALYZE memberships; ANALYZE team_members; ANALYZE contact_collaborators; ANALYZE deals; ANALYZE deal_members');
  return agents;
}

let agentsA: UserId[] = [];
beforeAll(async () => {
  h = await createHarness(4);
  a = await createWorld(h.app, { agents: 1 });
  b = await createWorld(h.app, { agents: 1 });
  agentsA = await seed(a, PER_TENANT);
  await seed(b, 20_000);
}, 300_000);
afterAll(async () => {
  await h?.close();
});

const LIST = (me: string) => sql`SELECT id, display_name, stage FROM contacts WHERE owner_user_id = ${me} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; 'Subplan Name'?: string; 'Parent Relationship'?: string; Plans?: PlanNode[] };
function walk(n: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
}

describe('RLS plan shape and overhead at 250k contacts per tenant', () => {
  it('EXPLAIN: the visibility helpers run once as InitPlans and contacts are read by an index on the tenant prefix', async () => {
    const me = agentsA[7]!;
    const plan = await withTenantTx(userActor(a.tenantId, me, 'agent'), async (tx) => {
      const r = await sql<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>`EXPLAIN (FORMAT JSON) ${LIST(me)}`.execute(tx);
      return r.rows[0]!['QUERY PLAN'][0].Plan;
    }, { db: h.app });
    const nodes = walk(plan);
    const initPlans = nodes.filter((n) => n['Parent Relationship'] === 'InitPlan');
    const scans = nodes.filter((n) => n['Relation Name'] === 'contacts');
    // snapshot of the shape (not of costs): every helper call is an InitPlan; no sequential scan of contacts
    expect(initPlans.length).toBeGreaterThanOrEqual(5);
    expect(scans.length).toBeGreaterThanOrEqual(1);
    for (const s of scans) {
      expect(s['Node Type']).toMatch(/Index Scan|Index Only Scan|Bitmap Heap Scan/);
    }
    const indexed = nodes.filter((n) => n['Index Name']?.startsWith('contacts_'));
    expect(indexed.some((n) => (n['Index Cond'] ?? '').includes('tenant_id'))).toBe(true);
    expect({ initPlans: initPlans.length > 0, contactsScan: [...new Set(scans.map((s) => s['Node Type']))].sort() }).toMatchSnapshot();
  });

  it('benchmark: an agent contacts list has p95 RLS overhead < 5 ms at 250k contacts (vs the same query without RLS)', async () => {
    const me = agentsA[3]!;
    const runs = 150;
    const p95 = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length * 0.95)]!;
    const withRls: number[] = [];
    await withTenantTx(userActor(a.tenantId, me, 'agent'), async (tx) => {
      for (let i = 0; i < 10; i++) await LIST(me).execute(tx); // warm
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = await LIST(me).execute(tx);
        withRls.push(performance.now() - t0);
        expect(r.rows.length).toBe(50);
      }
    }, { db: h.app });
    const c = await h.su.connect();
    const without: number[] = [];
    try {
      const q = `SELECT id, display_name, stage FROM contacts WHERE tenant_id = $2 AND owner_user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`;
      for (let i = 0; i < 10; i++) await c.query(q, [me, a.tenantId]);
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        await c.query(q, [me, a.tenantId]);
        without.push(performance.now() - t0);
      }
    } finally {
      c.release();
    }
    const overhead = p95(withRls) - p95(without);
    console.log(`contacts list @250k: p95 with RLS ${p95(withRls).toFixed(2)} ms, without ${p95(without).toFixed(2)} ms, overhead ${overhead.toFixed(2)} ms`);
    expect(overhead).toBeLessThan(5);
  }, 120_000);
});
