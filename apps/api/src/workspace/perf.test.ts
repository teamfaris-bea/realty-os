// Load smoke tests for api/workspace (BUILD_PLAN module 14 acceptance; smaller-scale proxies of exit
// criterion 4, which needs 250k contacts × 3 tenants on production-like hardware and is NOT run here):
//   - GET /feed for a user with 200 live cards: p95 < 150 ms (end to end through the server, refresh included)
//   - GET /search over 25k contacts + 25k phone numbers under RLS: p95 < 300 ms
// Rows that have no fast application path are bulk-inserted by the superuser with triggers off (fixtures).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { call, feedOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: false });
});
afterAll(async () => {
  await h?.close();
});

/** Contacts in the search smoke (default 25k; WORKSPACE_LOAD_CONTACTS=250000 for the full-size run, ~1 min). */
const N = Number(process.env.WORKSPACE_LOAD_CONTACTS ?? 25_000);
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe('load smoke', () => {
  it('GET /feed with 200 live cards: p95 under 150 ms (refresh + persist + response)', async () => {
    const a = w.agents[0]!;
    await h.su.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, kind, title, due_at, created_by_kind, created_by_user_id)
       SELECT $1, gen_random_uuid(), $2, 'todo', 'Task ' || g, now() + (g * interval '1 minute'), 'user', $2 FROM generate_series(1, 200) g`,
      [w.tenantId, a.userId],
    );
    await h.su.query('ANALYZE tasks; ANALYZE priority_feed_items');
    const first = await feedOf(a); // inserts the 200 cards
    expect(first.total).toBe(200);
    expect(first.all.length).toBe(50);
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const r = await call(a, 'GET', '/feed');
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    console.info(`feed 200 cards: p95 ${p95(times).toFixed(1)} ms, median ${[...times].sort((x, y) => x - y)[12]!.toFixed(1)} ms`);
    expect(p95(times)).toBeLessThan(150);
  });

  it(`GET /search over ${N} contacts under RLS: p95 under 300 ms (name prefix, phone digits, no match)`, async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    await suFixture(h, [
      {
        text: `INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, ownership_state, owner_user_id, owned_at, ownership_seq, ownership_period_seq, ownership_command_id)
               SELECT $1, gen_random_uuid(), 'Loadfirst' || g, 'Surname' || (g % 997), 'Loadfirst' || g || ' Surname' || (g % 997), 'owned',
                      CASE WHEN g % 25 = 0 THEN $2::uuid ELSE $3::uuid END, now(), 1, 1, gen_random_uuid()
                 FROM generate_series(1, $4::int) g`,
        values: [w.tenantId, a.userId, b.userId, N],
      },
      {
        text: `INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, is_primary)
               SELECT c.tenant_id, gen_random_uuid(), c.id, 'phone', '+1503' || lpad((row_number() OVER (ORDER BY c.id))::text, 7, '0'),
                      sha256(convert_to(c.id::text, 'UTF8')), true
                 FROM contacts c WHERE c.tenant_id = $1 AND c.first_name LIKE 'Loadfirst%'`,
        values: [w.tenantId],
      },
    ]);
    await h.su.query('ANALYZE contacts; ANALYZE contact_points');
    const queries = ['loadfirst12', 'Loadfirst2 Surn', '(503) 000-1250', '5030002000', 'surname41', 'nobody-matches-this', 'loadf', '503 000 0'];
    const times: number[] = [];
    let found = 0;
    for (let i = 0; i < 24; i++) {
      const q = queries[i % queries.length]!;
      const t0 = performance.now();
      const r = await call<{ contacts: unknown[]; incomplete: string[] }>(a, 'GET', `/search?q=${encodeURIComponent(q)}`);
      times.push(performance.now() - t0);
      if (process.env.WORKSPACE_LOAD_CONTACTS) console.info(`  ${q}: ${(performance.now() - t0).toFixed(0)} ms`);
      expect(r.status).toBe(200);
      expect(r.body.incomplete).toEqual([]);
      found += r.body.contacts.length;
    }
    // RLS: agent A sees only their 1 in 25
    const rls = await call<{ contacts: { name: string }[] }>(a, 'GET', '/search?q=loadfirst1');
    for (const c of rls.body.contacts) expect(Number(c.name.match(/Loadfirst(\d+)/)![1]) % 25).toBe(0);
    console.info(`search ${N} contacts: p95 ${p95(times).toFixed(1)} ms, ${found} rows over ${times.length} queries`);
    expect(p95(times)).toBeLessThan(300);
  });
});
