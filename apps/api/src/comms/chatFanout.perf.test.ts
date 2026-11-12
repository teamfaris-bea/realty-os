// Plan shape and a timing bound for the reachability summary's batched website-chat fan-out (R-CHAN-4; review
// chat-R1 of batch 6). reachabilityFor runs on every thread and compose open (again every 15 s while a chat is live),
// on the feed's batch of up to 50 cards and once per person in a bulk enroll. Its chat fan-out (repos/reachability.ts
// chatFanoutFor) must read each contact's person once and then that person's points by contact_id: a correlated
// `contact_id = ANY ((SELECT app.contact_person_ids(..., c.id)))` in a join condition becomes a join filter that runs
// the recursive person read once per (contact, web-chat point of the tenant) pair, which with a few thousand chat
// leads took 10 s for a 50-card batch and hit the 30 s statement timeout at 4,000.
// The data set is a superuser load fixture (triggers off): one contact created through the API, cloned to CHAT_LEADS
// contacts with one website-chat identity each. Every measured read runs as app_user under the Owner's RLS through the
// module's own functions. The budget asserted is loose so a slow box does not flake.
import { instantFromDate } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { reachabilityFor } from './reachability.js';
import { chatFanoutHmacs } from './repos/gate.js';
import { chatFanoutFor, chatFanoutSql } from './repos/reachability.js';
import { type CommsWorld, commsWorld, ownedContact } from './testing.js';

const CHAT_LEADS = 3000;
let h: ApiHarness;
let w: CommsWorld;
let ids: string[] = [];

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await commsWorld(h, { agents: 1 });
  const seed = await ownedContact(w.agents[0]!, { consent: false });
  const cols = (await h.su.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND is_generated = 'NEVER' ORDER BY ordinal_position",
  )).rows.map((r) => `"${r.column_name}"`);
  const sel = cols.map((c) => (c === '"id"' ? 'gen_random_uuid()' : `x.${c}`));
  await suFixture(h, [
    { text: `INSERT INTO contacts (${cols.join(', ')}) SELECT ${sel.join(', ')} FROM contacts x, generate_series(1, $2) g WHERE x.id = $1`, values: [seed.id, CHAT_LEADS - 1] },
    {
      text: `INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label)
             SELECT tenant_id, gen_random_uuid(), id, 'web_chat', 'wc:' || md5(id::text), decode(md5(id::text) || md5(id::text || 'x'), 'hex'), 'other'
               FROM contacts WHERE tenant_id = $1`,
      values: [w.tenantId],
    },
  ]);
  await h.su.query('ANALYZE contacts; ANALYZE contact_points');
  ids = (await h.su.query<{ id: string }>('SELECT id FROM contacts WHERE tenant_id = $1 ORDER BY random() LIMIT 50', [w.tenantId])).rows.map((r) => r.id);
}, 300_000);
afterAll(async () => {
  await h?.close();
});

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Cond'?: string; 'Join Filter'?: string; Filter?: string; 'Subplan Name'?: string; Plans?: PlanNode[] };
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
};

describe(`the batched chat fan-out with ${CHAT_LEADS} website-chat identities in the tenant`, () => {
  it('reads each person once and its points by contact_id: no per-point person read in a join filter', async () => {
    const plan = await withTenantTx(w.owner.actor(), async (tx) => {
      const r = await sql<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>`EXPLAIN (FORMAT JSON) ${chatFanoutSql(ids)}`.execute(tx);
      return r.rows[0]!['QUERY PLAN'][0].Plan;
    }, { db: h.database });
    const nodes = walk(plan);
    const text = JSON.stringify(plan, null, 1);
    // the regression's shape: `Join Filter: (p.contact_id = ANY ((SubPlan 1)))` over every web-chat point of the
    // tenant (the points' own Filter keeps the RLS policy's SubPlans: those are per visible row and expected)
    for (const n of nodes) {
      expect(n['Join Filter'] ?? '', text).not.toMatch(/SubPlan|contact_id/);
      expect(n.Filter ?? '', text).not.toMatch(/contact_id = ANY/);
    }
    const points = nodes.filter((n) => n['Relation Name'] === 'contact_points');
    expect(points.length, text).toBeGreaterThan(0);
    for (const p of points) expect(p['Index Cond'] ?? '', text).toMatch(/contact_id = /);
  }, 120_000);

  it('a 50-contact batch answers well within the feed budget, with the gate\'s own chat fan-out for each contact', async () => {
    const now = instantFromDate(new Date());
    const [fan, ms, wholeMs] = await withTenantTx(w.owner.actor(), async (tx) => {
      const t0 = performance.now();
      const f = await chatFanoutFor(tx, ids);
      const t1 = performance.now();
      await reachabilityFor(tx, ids, now);
      return [f, t1 - t0, performance.now() - t1] as const;
    }, { db: h.database });
    console.info(`[chat fan-out] 50 contacts over ${CHAT_LEADS} chat identities: fan-out ${Math.round(ms)} ms, whole summary ${Math.round(wholeMs)} ms`);
    expect(ms).toBeLessThan(500);
    expect(wholeMs).toBeLessThan(1500);
    // the same rows the send-time gate reads, contact by contact
    const gate = await withTenantTx(w.owner.actor(), async (tx) => {
      const out = new Map<string, string[]>();
      for (const id of ids) out.set(id, await chatFanoutHmacs(tx, id));
      return out;
    }, { db: h.database });
    expect(fan).toEqual(gate);
    expect([...fan.values()].every((x) => x.length === 1)).toBe(true);
  }, 120_000);
});
