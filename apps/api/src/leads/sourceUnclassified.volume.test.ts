// R-LSRC-9 A4 (bounded work): a mapping change does work in proportion to what there is to stop, not to the tenant.
//
// One team holds 60,000 committed contacts import records under one big label (plus 100,000 import records of another
// category), and 20 people under a small label, 5 of them in a running plan. Mapping, removing and re-mapping either
// label answers in well under the request budget: the label's people are found through import_records_contact_label
// (0101), joined straight to the plans, AI care and drafts there are to stop, the definer is asked only for people who
// have something to stop, and the answer row counts that label alone. No lock is taken and nothing reads the tenant's
// whole import history. Two proofs: the small label's two requests read fewer than 2,000 rows of import_records in all
// (the table holds 160,020; counted by the database's own statistics), and every request answers within a generous
// budget (5 s; each takes a fraction of a second on an idle machine, where a per-person definer call over the label
// would take minutes). Made-up labels; fakes only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, enrollmentRow, runJobs, smsStep } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, freshReauth, ownedContact } from '../comms/testing.js';
import { importedPerson } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let plain: string;
const BIG = 'Big label (volume test)';
const SMALL = 'Small label (volume test)';
const BIG_PEOPLE = 60_000;
const BUDGET_MS = 5000;
/** The stated time for the CRM-wide review list at this volume (about 150 ms on an idle machine). */
const LIST_BUDGET_MS = 5000;
const planned: { contactId: string; enrollmentId: string }[] = [];

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h, w.owner);
  plain = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'referral' })).body.source.id;
  const plan = await approvedPlaybook(w.owner, {
    kind: 'nurture',
    scope: 'team',
    name: 'Two check-ins (test)',
    steps: [
      smsStep({ key: 'first', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] }),
      smsStep({ key: 'second', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in again.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
  // the small label: 20 real people in one import, 5 of them in a running plan
  let batchId: string | undefined;
  for (let i = 0; i < 20; i++) {
    const c = await ownedContact(agent);
    batchId = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: SMALL, ...(batchId ? { batchId } : {}) })).batchId;
    if (i < 5) planned.push({ contactId: c.id, enrollmentId: '' });
  }
  // the big label, and the noise of another import category, written in bulk as the migration owner (fixtures only)
  const stage = (await h.su.query<{ id: string }>(`SELECT id FROM import_stages WHERE batch_id = $1 AND category = 'contacts'`, [batchId])).rows[0]!.id;
  const other = randomUUID();
  await h.su.query(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'messages', 4, 'pending')`, [w.tenantId, other, batchId]);
  await h.su.query(
    `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id)
     SELECT $1, gen_random_uuid(), $2, 'big#' || g, now(), jsonb_build_object('category', 'contacts', 'leadSourceLabel', $3::text), 'imported', 'contacts', gen_random_uuid()
       FROM generate_series(1, $4::int) g`,
    [w.tenantId, stage, BIG, BIG_PEOPLE],
  );
  await h.su.query(
    `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id)
     SELECT $1, gen_random_uuid(), $2, 'msg#' || g, now(), jsonb_build_object('category', 'messages'), 'imported', 'messages', gen_random_uuid()
       FROM generate_series(1, 100000) g`,
    [w.tenantId, other],
  );
  await h.su.query('ANALYZE import_records');
  // reviewed (so plans may run), then the five plans start
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: SMALL, leadSourceId: plain })).status).toBe(200);
  for (const p of planned) {
    const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${p.contactId}/enrollments`, { playbookId: plan.playbookId });
    expect(e.status).toBe(201);
    p.enrollmentId = e.body.enrollment.id;
  }
}, 600_000);
afterAll(async () => {
  await h?.close();
});

type Answer = { label: { people: number; inReview: boolean; leadSourceId: string | null }; stopping: number; pausing: number; withdrawn: number };
async function timed(label: string, leadSourceId: string | null): Promise<{ ms: number; status: number; body: Answer }> {
  await freshReauth(h, w.owner);
  const t0 = Date.now();
  const r = await call<Answer>(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId });
  return { ms: Date.now() - t0, status: r.status, body: r.body };
}

/**
 * Rows of import_records read so far by any plan (sequential, index or bitmap), from the database's own counters. A
 * backend reports its counters when it has been idle for up to ten seconds, so this waits first.
 */
async function rowsRead(): Promise<number> {
  await new Promise((r) => setTimeout(r, 11_000));
  const r = await h.su.query<{ n: string }>("SELECT (COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0))::text AS n FROM pg_stat_user_tables WHERE relname = 'import_records'");
  return Number(r.rows[0]!.n);
}

describe('R-LSRC-9 A4: a mapping change is bounded work at volume (60,000 people under one label, 160,000 import records)', () => {
  it('R-LSRC-9 E732: removing and re-mapping the 20-person label reads fewer than 2,000 of the 160,020 import records and asks its 5 running plans to stop; mapping and removing the 60,000-person label each answer within the budget with the right count; a plan asked to stop whose label is mapped again before the job runs keeps running', async () => {
    const times: Record<string, number> = {};
    const before = await rowsRead();
    const off = await timed(SMALL, null);
    times['remove small'] = off.ms;
    expect([off.status, off.body.stopping, off.body.label.people, off.body.label.inReview]).toEqual([200, 5, 20, true]);
    const on = await timed(SMALL, plain);
    times['map small'] = on.ms;
    expect([on.status, on.body.stopping, on.body.label.people, on.body.label.inReview]).toEqual([200, 0, 20, false]);
    // bounded: the two requests read the small label's rows (and each stopped person's own), never the table
    const read = (await rowsRead()) - before;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(2000);
    times['rows of import_records read by the two small-label requests'] = read;

    const bigOn = await timed(BIG, plain);
    times['map big'] = bigOn.ms;
    expect([bigOn.status, bigOn.body.stopping, bigOn.body.label.people, bigOn.body.label.inReview, bigOn.body.label.leadSourceId]).toEqual([200, 0, BIG_PEOPLE, false, plain]);
    const bigOff = await timed(BIG, null);
    times['remove big'] = bigOff.ms;
    expect([bigOff.status, bigOff.body.stopping, bigOff.body.pausing, bigOff.body.withdrawn, bigOff.body.label.people, bigOff.body.label.inReview]).toEqual([200, 0, 0, 0, BIG_PEOPLE, true]);
    const again = await timed(BIG, null); // the Owner's next act on a label nobody mapped: still bounded
    times['remove big again'] = again.ms;
    expect(again.status).toBe(200);

    console.info('R-LSRC-9 mapping at volume (ms)', times);
    for (const [what, ms] of Object.entries(times)) expect(ms, what).toBeLessThan(BUDGET_MS);
    expect((await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM import_records WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(BIG_PEOPLE + 100_000 + 20);

    // the removal asked the five plans for a step, and the Owner mapped the label again before any job ran: the step
    // runner asks again when it runs, finds the people reviewed, and stops nothing (the state follows the mapping)
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const p of planned) expect((await enrollmentRow(h, p.enrollmentId)).state).toBe('active');
    // removed for good: now they stop
    const last = await timed(SMALL, null);
    expect([last.status, last.body.stopping]).toEqual([200, 5]);
    expect(last.ms).toBeLessThan(BUDGET_MS);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const p of planned) expect(await enrollmentRow(h, p.enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
  }, 300_000);

  it('R-LSRC-10 M4 E745: at the same volume (60,030 imported people) confirming a suggestion is bounded work too, and the CRM-wide review list answers inside its stated time with every count right', async () => {
    // ten more people under a label that reads exactly like a lead source's name
    await freshReauth(h, w.owner);
    const suggested = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Suggested Label (volume test)', kind: 'referral' })).body.source.id;
    const LABEL = ' suggested label (volume TEST)';
    let batchId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const c = await ownedContact(agent);
      batchId = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: LABEL, ...(batchId ? { batchId } : {}) })).batchId;
    }
    const before = await rowsRead();
    await freshReauth(h, w.owner);
    const t0 = Date.now();
    const ok = await call<Answer & { label: { state: string } }>(w.owner, 'POST', '/lead-sources/import-labels/confirm', { label: LABEL, leadSourceId: suggested });
    const confirmMs = Date.now() - t0;
    expect([ok.status, ok.body.label.state, ok.body.label.people, ok.body.label.leadSourceId]).toEqual([200, 'mapped', 10, suggested]);
    const read = (await rowsRead()) - before;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(2000);
    expect(confirmMs).toBeLessThan(BUDGET_MS);

    // the list is a read of every label with its people: one pass over the team's committed contacts records (60,030),
    // never the 100,000 records of other categories, inside a stated time
    const t1 = Date.now();
    const list = await call<{ labels: { label: string; people: number; committedPeople: number; state: string; inReview: boolean }[] }>(w.owner, 'GET', '/lead-sources/import-labels');
    const listMs = Date.now() - t1;
    expect(list.status).toBe(200);
    const row = (label: string) => list.body.labels.find((l) => l.label === label);
    expect(row(BIG)).toMatchObject({ people: BIG_PEOPLE, committedPeople: BIG_PEOPLE, state: 'in_review', inReview: true });
    expect(row(SMALL)).toMatchObject({ people: 20, state: 'in_review' });
    expect(row(LABEL)).toMatchObject({ people: 10, state: 'mapped', inReview: false });
    console.info('R-LSRC-10 review at volume (ms)', { confirm: confirmMs, 'rows of import_records read by the confirmation': read, 'list of every label': listMs });
    expect(listMs).toBeLessThan(LIST_BUDGET_MS);
  }, 300_000);
});
