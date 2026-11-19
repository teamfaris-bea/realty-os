// Plan shape and loose timing bounds for the two team work queue reads the review flagged (b19 team-queue lane, review
// step 7; DATA_MODEL R-TEAMQ-29), in the style of comms/chatFanout.perf.test.ts:
//   1. the waiting-inquiries read had no inner limit and ranged on the source's CLAIMED time: it now ranges on the one
//      arrival instant through lead_inquiries_source_arrival_idx (migration 0109) and stops per source at the cap;
//   2. the waiting-inbound read for a TEAM LEAD walked the whole tenant's recently active people and filtered them by
//      the team scope: it now starts from the Team Lead's own members (contacts_owner_idx, contacts_offeree_idx) and
//      the pond leads, so another team's activity is never scanned.
// The data set is a superuser load fixture (triggers off): one lead created through the API per kind, cloned. Every
// measured read runs as app_user under the caller's own row-level security through the module's own functions.
// The budgets asserted are loose so a slow or busy box does not flake.
import { type Instant, instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { type RawBuilder, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantWorld, inboundSms, ownedContact } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { QUEUE_READ_CAP, waitingInbound, waitingInboundPeopleSql, waitingInquiries, waitingInquiriesSql } from './repos/teamQueue.js';
import { type AccWorld, acceptedLead, call } from './testing.js';

const OUTSIDE_PEOPLE = 3000;
const INQUIRIES = 4000;
let h: ApiHarness;
let w: AccWorld;
let outsider: TestClient;
let mine: string;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Filter?: string; Plans?: PlanNode[] };
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
};
const DAY = 86_400_000;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  const base = await assistantWorld(h, { agents: 2, teamLead: true });
  outsider = await h.invite(base.owner, 'agent');
  w = { ...base, outsider };
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  await call(w.owner, 'PATCH', '/settings', { version: s.body.settings.version, uncontactedCapacityCap: 50 });
  // the Team Lead's team: one waiting lead and one person who wrote in
  const lead = await acceptedLead(h, w);
  const wrote = await ownedContact(w.agents[0]!, { firstName: 'Rhea' });
  expect((await inboundSms(h, wrote.phone, w.mainNumber, 'Is the open house still on?')).statusCode).toBe(200);
  mine = wrote.id;
  // another team's book: an outside agent's person who wrote in, cloned OUTSIDE_PEOPLE times
  const theirs = await ownedContact(outsider, { firstName: 'Otto' });
  expect((await inboundSms(h, theirs.phone, w.mainNumber, 'Hello?')).statusCode).toBe(200);
  const cols = (await h.su.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND is_generated = 'NEVER' ORDER BY ordinal_position",
  )).rows.map((r) => `"${r.column_name}"`);
  const sel = cols.map((c) => (c === '"id"' ? 'gen_random_uuid()' : `x.${c}`));
  await suFixture(h, [
    { text: `INSERT INTO contacts (${cols.join(', ')}) SELECT ${sel.join(', ')} FROM contacts x, generate_series(1, $2) g WHERE x.id = $1`, values: [theirs.id, OUTSIDE_PEOPLE - 1] },
    // the waiting lead's inquiry, cloned: INQUIRIES arrivals of one source spread over the last 13 days, each of its own (cloned) person
    { text: `INSERT INTO contacts (${cols.join(', ')}) SELECT ${sel.join(', ')} FROM contacts x, generate_series(1, $2) g WHERE x.id = $1`, values: [lead.contactId, INQUIRIES - 1] },
    {
      text: `INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, created_at, inquiry_type, fingerprint, outcome)
             SELECT c.tenant_id, gen_random_uuid(), c.id, $2, now() - (random() * interval '13 days'), now() - (random() * interval '13 days'), 'buy', md5(c.id::text), 'new_contact'
               FROM contacts c WHERE c.tenant_id = $1 AND c.owner_user_id = $3 AND c.id <> $4 AND NOT EXISTS (SELECT 1 FROM lead_inquiries i WHERE i.contact_id = c.id)`,
      values: [w.tenantId, w.sourceId, lead.owner.userId, mine],
    },
  ]);
  await h.su.query('ANALYZE contacts; ANALYZE lead_inquiries; ANALYZE messages; ANALYZE calls');
}, 300_000);
afterAll(async () => {
  await h?.close();
});

const planOf = async (c: TestClient, q: RawBuilder<unknown>): Promise<PlanNode> =>
  withTenantTx(c.actor(), async (tx) => (await sql<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>`EXPLAIN (FORMAT JSON) ${q}`.execute(tx)).rows[0]!['QUERY PLAN'][0].Plan, { db: h.database });

describe(`R-TEAMQ-29 the waiting-inquiries read with ${INQUIRIES} inquiries of one source in the window`, () => {
  it('R-TEAMQ-29 E898: ranges on the arrival through lead_inquiries_source_arrival_idx, never a sequential scan of lead_inquiries, and stops inside each source at the cap', async () => {
    const now = instant(Date.now());
    const plan = await planOf(w.owner, waitingInquiriesSql(instant(now - 14 * DAY), now, QUEUE_READ_CAP));
    const nodes = walk(plan);
    const text = JSON.stringify(plan, null, 1);
    const inq = nodes.filter((n) => n['Relation Name'] === 'lead_inquiries');
    expect(inq.length, text).toBeGreaterThan(0);
    for (const n of inq) expect(n['Node Type'], text).not.toBe('Seq Scan');
    expect(inq.some((n) => n['Index Name'] === 'lead_inquiries_source_arrival_idx' && /created_at/.test(n['Index Cond'] ?? '')), text).toBe(true);
    // the inner limit: a Limit node under the per-source lateral, above the inquiries scan
    expect(nodes.filter((n) => n['Node Type'] === 'Limit').length, text).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('R-TEAMQ-29: the read returns the cap + 1 longest-waiting rows, oldest first, within a loose budget', async () => {
    const now = instant(Date.now());
    const [rows, ms] = await withTenantTx(w.owner.actor(), async (tx) => {
      const t0 = performance.now();
      const r = await waitingInquiries(tx, instant(now - 14 * DAY), now, QUEUE_READ_CAP);
      return [r, performance.now() - t0] as const;
    }, { db: h.database });
    expect(rows.length).toBe(QUEUE_READ_CAP + 1);
    expect(rows.map((r) => r.arrived_at.getTime())).toEqual([...rows.map((r) => r.arrived_at.getTime())].sort((a, b) => a - b));
    expect(ms).toBeLessThan(15_000);
  }, 120_000);
});

describe(`R-TEAMQ-29 the waiting-inbound read for a Team Lead with ${OUTSIDE_PEOPLE} recently active people of another team`, () => {
  it('R-TEAMQ-29 E899: starts from the Team Lead\'s own members by the owner and offeree indexes: no sequential scan of contacts, and the tenant-wide activity index is not what finds the team\'s people', async () => {
    const now = instant(Date.now());
    const members = [w.teamLead!.userId!, ...w.agents.map((a) => a.userId!)];
    const plan = await planOf(w.teamLead!, waitingInboundPeopleSql(instant(now - 14 * DAY), QUEUE_READ_CAP, { wide: false, members }));
    const nodes = walk(plan);
    const text = JSON.stringify(plan, null, 1);
    const contacts = nodes.filter((n) => n['Relation Name'] === 'contacts');
    for (const n of contacts) expect(n['Node Type'], text).not.toBe('Seq Scan');
    expect(nodes.some((n) => n['Index Name'] === 'contacts_owner_idx' && /owner_user_id = ANY/.test(n['Index Cond'] ?? '')), text).toBe(true);
    expect(nodes.some((n) => n['Index Name'] === 'contacts_offeree_idx'), text).toBe(true);
  }, 120_000);

  it('R-TEAMQ-29: the Team Lead gets their own team\'s waiting person and none of the other team\'s, within a loose budget; the Owner still gets everyone (capped)', async () => {
    const now = instant(Date.now()) as Instant;
    const [tl, ms] = await withTenantTx(w.teamLead!.actor(), async (tx) => {
      const t0 = performance.now();
      const r = await waitingInbound(tx, instant(now - 14 * DAY), now, QUEUE_READ_CAP);
      return [r, performance.now() - t0] as const;
    }, { db: h.database });
    expect(tl.people.map((p) => p.contact_id)).toContain(mine);
    expect(tl.people.every((p) => p.owner_user_id !== outsider.userId)).toBe(true);
    expect(tl.capped).toBe(false);
    expect(ms).toBeLessThan(15_000);
    const all = await withTenantTx(w.owner.actor(), (tx) => waitingInbound(tx, instant(now - 14 * DAY), now, QUEUE_READ_CAP), { db: h.database });
    expect(all.capped).toBe(true);
    expect(all.people.length).toBe(QUEUE_READ_CAP);
  }, 120_000);
});
