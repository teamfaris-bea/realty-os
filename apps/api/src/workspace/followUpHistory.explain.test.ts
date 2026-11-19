// b19 Today fix 6 (M9; R-TODAY-17): the follow-up history read is one index read per person and per kind, at volume.
// EXPLAIN (ANALYZE) of the statement the route really sends (followUpHistorySql), as the viewer under row-level
// security, with the planner's own choices (sequential scans ON), over a tenant with 20,000 appointments and a person
// with 5,000 notes. Before migration 0110 the appointments branch scanned every appointment of the tenant once per
// person (139 of 145 ms on the reviewer's run) and the logged-activity branch read and sorted every note of the person.
//
// The messages and calls tables hold only a handful of rows here, where the planner's choice says nothing; for those
// two the test proves the index path exists (sequential scans off), in the way of cma/sweep.test.ts.
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, sendText } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { followUpHistorySql, loadFollowUpContext } from './repos/followUp.js';

let h: ApiHarness;
let w: CommsWorld;
let a: TestClient;
let busy: { id: string };
const people: string[] = [];

const APPOINTMENTS = 20_000;
const NOTES = 5_000;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  a = w.agents[0]!;
  busy = await ownedContact(a, { firstName: 'Busy' });
  people.push(busy.id);
  for (let i = 0; i < 19; i++) people.push((await ownedContact(a, { firstName: `Other${i}`, consent: false })).id);
  expect((await sendText(a, busy.id, 'Checking in about Saturday.')).body.result).toBe('sent');
  await suFixture(h, [
    // 20,000 appointments of the tenant (other people's), and 30 held ones of the busy person
    {
      text: `INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, status, created_by_kind)
             SELECT $1, gen_random_uuid(), gen_random_uuid(), $2, 'consult', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval + interval '30 minutes',
                    CASE WHEN g % 3 = 0 THEN 'held' ELSE 'scheduled' END, 'user' FROM generate_series(1, ${APPOINTMENTS}) g`,
      values: [w.tenantId, a.userId],
    },
    {
      text: `INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, status, created_by_kind)
             SELECT $1, gen_random_uuid(), $3, $2, 'consult', now() - (g || ' days')::interval, now() - (g || ' days')::interval + interval '30 minutes', 'held', 'user' FROM generate_series(1, 30) g`,
      values: [w.tenantId, a.userId, busy.id],
    },
    // 5,000 notes of the busy person: the NEWEST 2,000 are manual, under them 2,500 logged calls and 500 imported
    // notes, so no branch finds its row at the top of the person's notes by luck
    {
      text: `INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, imported, created_at, activity_kind, activity_direction, activity_at, activity_outcome)
             SELECT $1, gen_random_uuid(), $3, CASE WHEN g > 4500 THEN NULL ELSE $2::uuid END, 'Note ' || g,
                    CASE WHEN g <= 2000 THEN 'manual' WHEN g <= 4500 THEN 'logged_activity' ELSE 'import' END, g > 4500,
                    now() - (g || ' minutes')::interval,
                    CASE WHEN g > 2000 AND g <= 4500 THEN 'call' END, CASE WHEN g > 2000 AND g <= 4500 THEN 'outbound' END,
                    CASE WHEN g > 2000 AND g <= 4500 THEN now() - (g || ' minutes')::interval - interval '1 hour' END,
                    CASE WHEN g > 2000 AND g <= 4500 THEN 'connected' END
               FROM generate_series(1, ${NOTES}) g`,
      values: [w.tenantId, a.userId, busy.id],
    },
  ]);
  await h.su.query('ANALYZE appointments; ANALYZE notes; ANALYZE messages; ANALYZE calls; ANALYZE contacts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const actorOf = (c: TestClient): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'follow-up-explain-test' }) as unknown as UserActor;

type Node = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; Plans?: Node[] };
function walk(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
}

async function explain(o: { seqscan: boolean }): Promise<{ nodes: Node[]; ms: number; text: string }> {
  return withTenantTx(
    actorOf(a),
    async (tx, now) => {
      if (!o.seqscan) await sql`SET LOCAL enable_seqscan = off`.execute(tx);
      const q = followUpHistorySql(people, new Date(now).toISOString());
      const r = await sql<{ 'QUERY PLAN': [{ Plan: Node; 'Execution Time': number }] }>`EXPLAIN (ANALYZE, FORMAT JSON) ${q}`.execute(tx);
      const top = r.rows[0]!['QUERY PLAN'][0]!;
      const nodes = walk(top.Plan);
      return { nodes, ms: top['Execution Time'], text: nodes.map((n) => `${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` using ${n['Index Name']}` : ''}`).join('\n') };
    },
    { db: h.database },
  );
}

describe('M9 (R-TODAY-17): the follow-up history read at volume', () => {
  it(`with ${APPOINTMENTS} appointments in the tenant and ${NOTES} notes on one person, every appointments and notes read is an index read: no scan of the tenant's appointments, no sort of the person's notes`, async () => {
    const p = await explain({ seqscan: true });
    if (process.env['FOLLOW_UP_PRINT_PLAN']) console.log(`${p.text}\nExecution Time: ${p.ms} ms`);
    const on = (rel: string) => p.nodes.filter((n) => n['Relation Name'] === rel);
    // appointments: the partial index of migration 0110, and never a pass over the tenant's rows
    expect(p.text).not.toMatch(/Seq Scan on appointments/);
    expect(on('appointments').map((n) => n['Index Name'])).toEqual(['appointments_contact_held_idx']);
    void on;
    // notes: the three reads, each by an index that fits it (a Bitmap Index Scan names its index, not its table)
    expect(p.text).not.toMatch(/Seq Scan on notes/);
    const noteIndexes = p.nodes.map((n) => n['Index Name']).filter((n): n is string => n !== undefined && n.startsWith('notes_'));
    expect([...new Set(noteIndexes)].sort()).toEqual(['notes_contact_idx', 'notes_imported_contact_idx', 'notes_logged_activity_idx']);
    // bounded: the reads by person return one row and throw none away
    // (before 0110: 20,000 appointment rows per person, and 2,500 logged notes read to sort them)
    for (const n of p.nodes.filter((x) => ['appointments_contact_held_idx', 'notes_logged_activity_idx', 'notes_contact_idx'].includes(x['Index Name'] ?? ''))) {
      expect(n['Actual Rows'] ?? 0, `${n['Index Name']} rows per loop`).toBeLessThanOrEqual(1);
      expect(n['Rows Removed by Filter'] ?? 0, `${n['Index Name']} rows filtered per loop`).toBeLessThanOrEqual(1);
    }
    // the imported read touches at most the person's IMPORTED notes (500 here, by the partial index), never their 4,500 others
    for (const n of p.nodes.filter((x) => x['Relation Name'] === 'notes' || x['Index Name'] === 'notes_imported_contact_idx')) {
      expect((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0), `${n['Node Type']} ${n['Index Name'] ?? ''}`).toBeLessThanOrEqual(500);
    }
    // nothing sorts a person's whole note history (before: every logged note of the person, to find the newest)
    for (const s of p.nodes.filter((n) => n['Node Type'] === 'Sort')) expect(s['Actual Rows'] ?? 0).toBeLessThanOrEqual(1);
  });

  it('the messages and calls reads have an index path by person (sequential scans off: these tables are tiny here)', async () => {
    const p = await explain({ seqscan: false });
    const names = (rel: string) => [...new Set(p.nodes.filter((n) => n['Relation Name'] === rel).map((n) => n['Index Name']))];
    expect(names('messages')).toEqual(['messages_contact_idx']);
    expect(names('calls')).toEqual(['calls_contact_idx']);
    expect(p.text).not.toMatch(/Seq Scan on (messages|calls|notes|appointments)/);
  });

  it('and the answer is still right at volume: the busy person’s last touch and latest contact are the text just sent, and their imported history is dated', async () => {
    const ctx = await withTenantTx(actorOf(a), (tx, now) => loadFollowUpContext(tx, actorOf(a), [busy.id], now), { db: h.database });
    const c = ctx.byContact.get(busy.id)!;
    expect(c.lastTouch).toMatchObject({ kind: 'text', direction: 'outbound' });
    expect(c.lastTouch!.snippet).toMatch(/^Checking in about Saturday\./);
    expect(c.quiet).toMatchObject({ basis: 'contact' });
    expect(c.importedAt).not.toBeNull();
  });
});
