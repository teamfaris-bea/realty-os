// b7 review, ownership-data/F5 (R-PLAN-3, R-OWN-24): the weekly plan judges do-not-contact over the WHOLE person
// (app.contact_person_ids: the record, its root survivor, every record merged into that root) and drops work whose
// contact is a merged-away record, both when building the inputs (planInputs) and when rendering or accepting a
// stored plan (renderFilter). Before the fix a task or appointment still pointing at a merged-away duplicate L, whose
// survivor S carries the person-level do-not-contact, was suggested. Real Postgres through the real server (app_user),
// the hourly reconcile as the system actor.
import { randomUUID } from 'node:crypto';
import { type Instant, type TenantId, localDateOf, zone } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { contactOf } from '../workspace/testing.js';
import { isoWeekOf } from './common.js';
import { planInputs } from './plan.js';
import { DAY, type InsightsWorld, call, insightsWorld, runWeeklyPlan, thisMonday } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let monday: Instant;
let week: string;
// one agent per scenario: a plan is built once per member and week
let dncAgent: TestClient; // test 1: merged L into S, then do-not-contact on S
let plainAgent: TestClient; // test 1b: merged L into S, no do-not-contact anywhere
let laterAgent: TestClient; // test 3: plan built first, merge afterwards
let personAgent: TestClient; // test 2: do-not-contact only on the merged-away record
const ids: Record<string, string> = {};

interface PlanItemT {
  index: number;
  accepted: boolean;
  item: { kind: string; title: string; contactId: string | null; evidence: { sourceType: string; sourceId: string }[] };
}
interface PlanT {
  exists: boolean;
  items?: PlanItemT[];
  droppedSinceBuilt?: number;
  accepted?: { taskIds: string[] } | null;
}

async function task(owner: TestClient, kind: string, title: string, dueAt: Date | null, contactId: string | null = null): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $3)`,
    [w.tenantId, id, owner.userId, contactId, kind, title, dueAt],
  );
  return id;
}

/** An appointment of `owner` with `contactId` that ended Sunday with no outcome (a plan candidate). */
async function appt(owner: TestClient, contactId: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1, $2, $3, $4, $4, 'consult', $5, $6, 'user')`,
    [w.tenantId, id, contactId, owner.userId, new Date(monday - DAY), new Date(monday - DAY + 3_600_000)],
  );
  return id;
}

/** Two duplicate records of `agent` (L, S) and the merge of L into S through the API. */
/** L merged into S through the API (POST /leads/:S/merge, the ownership engine), as the agent who owns both. */
async function merge(agent: TestClient, survivorId: string, loserId: string): Promise<void> {
  const m = await command(agent, survivorId, 'merge', { loserId });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  const r = (await h.su.query(`SELECT merged_into_contact_id, closed_reason FROM contacts WHERE tenant_id = $1 AND id = $2`, [w.tenantId, loserId])).rows[0];
  expect(r).toEqual({ merged_into_contact_id: survivorId, closed_reason: 'merged' });
}

/** The merge leaves the loser's tasks and appointments where they were: the facts behind the finding. */
async function stillOnLoser(taskIds: string[], apptIds: string[], loserId: string): Promise<void> {
  const t = (await h.su.query(`SELECT DISTINCT contact_id FROM tasks WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND status = 'open'`, [w.tenantId, taskIds])).rows;
  const a = (await h.su.query(`SELECT DISTINCT contact_id FROM appointments WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND outcome IS NULL`, [w.tenantId, apptIds])).rows;
  expect([...t, ...a].map((x) => x.contact_id)).toEqual([...(taskIds.length ? [loserId] : []), ...(apptIds.length ? [loserId] : [])]);
}

const plan = async (c: TestClient) => {
  const r = await call<PlanT>(c, 'GET', `/me/weekly-plans/${week}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.exists).toBe(true);
  return r.body;
};
const cites = (p: PlanT, sourceId: string) => p.items!.some((i) => i.item.evidence.some((e) => e.sourceId === sourceId));
const onContact = (p: PlanT, contactId: string) => p.items!.some((i) => i.item.contactId === contactId);

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  monday = thisMonday(w.zone);
  week = isoWeekOf(localDateOf(monday, zone(w.zone)));
  const at = (days: number) => new Date(monday + days * DAY);
  [dncAgent, plainAgent] = w.agents as [TestClient, TestClient];
  laterAgent = await h.invite(w.owner, 'agent');
  personAgent = await h.invite(w.owner, 'agent');

  // test 1: L and S (duplicates of one person); open work on L; L merged into S; S records the do-not-contact
  {
    const l = await contactOf(dncAgent);
    const s = await contactOf(dncAgent);
    ids.l1 = l.id;
    ids.s1 = s.id;
    ids.control1 = await task(dncAgent, 'todo', 'Order the yard sign', at(2));
    ids.promise1 = await task(dncAgent, 'promise', 'Send the duplicate the comps', at(1), l.id);
    ids.todo1 = await task(dncAgent, 'todo', 'Call the duplicate back', at(1), l.id);
    ids.appt1 = await appt(dncAgent, l.id);
    ids.sTask1 = await task(dncAgent, 'todo', 'Call the survivor', at(1), s.id);
    await merge(dncAgent, s.id, l.id);
    await stillOnLoser([ids.promise1, ids.todo1], [ids.appt1], l.id);
    const d = await call(dncAgent, 'POST', `/contacts/${s.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    // the person-level flag sits on the survivor only; the merged-away record's own column stays clear
    const flags = (await h.su.query(`SELECT id, do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [w.tenantId, [l.id, s.id]])).rows;
    expect(Object.fromEntries(flags.map((f) => [f.id, f.dnc]))).toEqual({ [l.id]: false, [s.id]: true });
  }

  // test 1b: the same merge with no do-not-contact anywhere
  {
    const l = await contactOf(plainAgent);
    const s = await contactOf(plainAgent);
    ids.l2 = l.id;
    ids.s2 = s.id;
    ids.promise2 = await task(plainAgent, 'promise', 'Send the other duplicate the comps', at(1), l.id);
    ids.appt2 = await appt(plainAgent, l.id);
    ids.sTask2 = await task(plainAgent, 'todo', 'Call the other survivor', at(2), s.id);
    await merge(plainAgent, s.id, l.id);
    await stillOnLoser([ids.promise2], [ids.appt2], l.id);
  }

  // test 3: work on L built into the plan BEFORE the merge
  {
    const l = await contactOf(laterAgent);
    const s = await contactOf(laterAgent);
    ids.l3 = l.id;
    ids.s3 = s.id;
    ids.control3 = await task(laterAgent, 'todo', 'Book the photographer', at(2));
    ids.promise3 = await task(laterAgent, 'promise', 'Send the late duplicate the comps', at(1), l.id);
    ids.appt3 = await appt(laterAgent, l.id);
  }

  // test 2: S with work, L merged into S; built before the do-not-contact appears
  {
    const l = await contactOf(personAgent);
    const s = await contactOf(personAgent);
    ids.l4 = l.id;
    ids.s4 = s.id;
    ids.control4 = await task(personAgent, 'todo', 'Print the flyers', at(2));
    ids.sTask4 = await task(personAgent, 'todo', 'Call the merged person', at(1), s.id);
    await merge(personAgent, s.id, l.id);
  }

  const r = await runWeeklyPlan(h, w.tenantId, monday);
  expect(r.week).toBe(week);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('b7 ownership-data/F5: the weekly plan and merged records', () => {
  it('R-PLAN-3 R-OWN-24 b7 ownership-data/F5: a do-not-contact on the survivor keeps a merged-away record’s open work out of the plan', async () => {
    const p = await plan(dncAgent);
    // the merged-away record's promise, task and appointment are not offered, nor is the survivor's own task
    for (const id of [ids.promise1!, ids.todo1!, ids.appt1!, ids.sTask1!]) expect(cites(p, id), id).toBe(false);
    expect(onContact(p, ids.l1!)).toBe(false);
    expect(onContact(p, ids.s1!)).toBe(false);
    expect(JSON.stringify(p)).not.toContain(ids.l1);
    // the plan is still built: the unrelated work is there
    expect(cites(p, ids.control1!)).toBe(true);
    expect(p.items!.map((i) => i.item.title)).toEqual(['Order the yard sign']);
    // the stored payload never carried the merged-away work either (dropped at build, not only at render)
    const stored = (await h.su.query(`SELECT payload FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan' AND owner_user_id = $2`, [w.tenantId, dncAgent.userId])).rows[0];
    expect(JSON.stringify(stored.payload)).not.toContain(ids.l1);
    expect(p.droppedSinceBuilt).toBe(0);
  });

  it('R-PLAN-3 R-OWN-24 b7 ownership-data/F5: with no do-not-contact anywhere, work whose contact is a merged-away record is not in the plan (the survivor’s is)', async () => {
    const p = await plan(plainAgent);
    expect(cites(p, ids.promise2!)).toBe(false);
    expect(cites(p, ids.appt2!)).toBe(false);
    expect(onContact(p, ids.l2!)).toBe(false);
    expect(cites(p, ids.sTask2!)).toBe(true);
    expect(p.items!.find((i) => cites({ items: [i] } as PlanT, ids.sTask2!))!.item.contactId).toBe(ids.s2);
    const stored = (await h.su.query(`SELECT payload FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan' AND owner_user_id = $2`, [w.tenantId, plainAgent.userId])).rows[0];
    expect(JSON.stringify(stored.payload)).not.toContain(ids.l2);
  });

  it('R-PLAN-3 b7 ownership-data/F5: whole-person do-not-contact via the record merged into (the flag only on the merged-away record): planInputs (system actor, tenant-wide) marks the survivor’s work do-not-contact', async () => {
    const before = await plan(personAgent);
    const idx = before.items!.find((i) => cites({ items: [i] } as PlanT, ids.sTask4!))?.index;
    expect(idx, 'the survivor task was planned while nobody had asked').toBeTypeOf('number');
    // the flag on L only: the follow-merge trigger (0018 contacts_dnc_follow_merge) is bypassed (replica) so that
    // only app.contact_person_ids can connect it to S; S's own column stays clear
    await suFixture(h, [
      { text: `UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = gen_random_uuid() WHERE tenant_id = $1 AND id = $2`, values: [w.tenantId, ids.l4] },
    ]);
    const flags = (await h.su.query(`SELECT id, do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [w.tenantId, [ids.l4, ids.s4]])).rows;
    expect(Object.fromEntries(flags.map((f) => [f.id, f.dnc]))).toEqual({ [ids.l4!]: true, [ids.s4!]: false });
    // build side: the survivor's task is marked do-not-contact (planWeek never suggests it)
    const actor = systemActor(w.tenantId as TenantId, 'timer');
    const inputs = await withTenantTx(actor, (tx) => planInputs(tx, personAgent.userId!, zone(w.zone), monday, (monday + 7 * DAY) as Instant), { db: h.database });
    const t = inputs.tasks.find((x) => (x.taskId as string) === ids.sTask4);
    expect(t?.doNotContact).toBe(true);
    expect(inputs.tasks.find((x) => (x.taskId as string) === ids.control4)?.doNotContact).toBe(false);
    // not asserted: the render side. renderFilter reads app.contact_person_ids under the MEMBER's RLS, and a
    // merged-away record (closed, no owner) is not visible to an agent, so the person set from S is {S} and a flag
    // carried only by L is not seen at render or accept. Unreachable while 0018 contacts_dnc_follow_merge copies L's
    // flag onto S (at the merge and on any later flag of L); reported as a gap, not a failure.
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  it('R-PLAN-3 b7 ownership-data/F5: renderFilter drops an item whose contact became merged-away after the plan was stored', async () => {
    const before = await plan(laterAgent);
    expect(cites(before, ids.promise3!)).toBe(true);
    expect(cites(before, ids.appt3!)).toBe(true);
    expect(cites(before, ids.control3!)).toBe(true);
    const onL = before.items!.filter((i) => i.item.contactId === ids.l3).map((i) => i.index);
    expect(onL).toHaveLength(2);
    const control = before.items!.find((i) => cites({ items: [i] } as PlanT, ids.control3!))!.index;

    await merge(laterAgent, ids.s3!, ids.l3!);
    await stillOnLoser([ids.promise3!], [ids.appt3!], ids.l3!);

    const after = await plan(laterAgent);
    expect(onContact(after, ids.l3!)).toBe(false);
    expect(cites(after, ids.promise3!)).toBe(false);
    expect(cites(after, ids.appt3!)).toBe(false);
    expect(after.droppedSinceBuilt).toBe(2);
    expect(after.items!.map((i) => i.index)).toEqual([control]);

    // accept: an index of a dropped item is refused (and nothing is decided); the remaining one is accepted
    for (const i of onL) expect((await call(laterAgent, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [i] })).status).toBe(404);
    expect((await call(laterAgent, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [control, ...onL] })).status).toBe(404);
    const st = (await h.su.query(`SELECT status FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan' AND owner_user_id = $2`, [w.tenantId, laterAgent.userId])).rows[0];
    expect(st.status).toBe('proposed');
    const ok = await call<PlanT>(laterAgent, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [control] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.accepted!.taskIds).toEqual([ids.control3]);
    expect(ok.body.items!.map((i) => i.index)).toEqual([control]);
  });
});
