// R-PAR-29 perf test, CI-sized (PARITY_PLAN module 60): `pnpm load:seed` at 3,000 contacts into a
// throwaway database, the list workload on top (seedLists: ≈ 4 tag links and ≈ 8 typed values per
// person), then the list bench through the real server in process for an Owner and for an Agent.
// It fails on a p95 above 4× the R-PAR-29 budget (first page 400 ms, count 800 ms; the loose factor of
// pnpm load:smoke) and on any plan that scans a whole detail table (contact_tags, contact_field_values,
// tasks): under RLS that pays one app.contact_detail_visible() call per row. The 250k numbers come
// from `listsBench.ts` (reported in docs/PERFORMANCE.md, "Smart lists").
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadUrls } from '../../load/db.js';
import { seedLoad } from '../../load/seed.js';
import { LIST_BUDGET, planNodes, runListBench } from './listsBench.js';
import { seedLists } from './seedLists.js';

const DB = `realty_lists_perf_${process.pid}`;
const LOOSE = 4;
let result: Awaited<ReturnType<typeof runListBench>>;

beforeAll(async () => {
  await seedLoad({ db: DB, contacts: 3_000, log: () => {} });
  await seedLists({ ownerUrl: loadUrls(DB).ownerUrl, log: () => {} });
  result = await runListBench({ db: DB, n: 4, log: () => {} });
}, 600_000);

afterAll(async () => {
  const admin = new pg.Client({ connectionString: loadUrls(DB).adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).finally(() => admin.end());
}, 120_000);

describe('R-PAR-29 smart-list performance (CI-sized)', () => {
  it('R-PAR-29: every list run (first page, next page, count) for an Owner and an Agent stays within 4× its budget', () => {
    expect(result.results.length).toBeGreaterThan(50);
    const over = result.results.filter((m) => m.budgetMs !== null && m.p95 > LOOSE * m.budgetMs).map((m) => `${m.name}: p95 ${m.p95.toFixed(0)} ms`);
    expect(over).toEqual([]);
    expect(LIST_BUDGET.page[0]).toBe(400);
    expect(LIST_BUDGET.count[0]).toBe(800);
  });

  it('R-PAR-29: no list plan scans a whole detail table (tags, values and tasks are per-person probes)', () => {
    const scans: string[] = [];
    for (const [name, p] of Object.entries(result.plans)) {
      const plan = p as { page?: unknown; error?: string };
      expect(plan.error, name).toBeUndefined();
      for (const n of planNodes(plan.page)) {
        if (/Seq Scan|Bitmap Heap Scan/.test(n.type) && ['contact_tags', 'contact_field_values', 'tasks'].includes(n.relation ?? '')) scans.push(`${name}: ${n.type} on ${n.relation}`);
      }
    }
    expect(scans).toEqual([]);
    expect(Object.keys(result.plans).length).toBeGreaterThan(20);
  });
});
