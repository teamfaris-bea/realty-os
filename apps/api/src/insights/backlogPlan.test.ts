// The weekly plan keeps a merged person's work (backlog-gaps; R-PLAN-3, R-OWN-24, E550, E551). Since the merge-work
// migration a merge moves the loser's tasks and appointments to the survivor, so the next plan offers them there
// (planInputs, unchanged: they now pass its live-contact filter), and a plan stored before the merge renders and
// accepts them on the survivor (renderFilter re-keys an item to its evidence's current contact when the member sees
// that contact live and not do-not-contact). A do-not-contact on any record of the person still keeps the work out.
// Real Postgres through the real server (app_user); the hourly reconcile as the system actor.
import { randomUUID } from 'node:crypto';
import { type Instant, localDateOf, zone } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command } from '../leads/testing.js';
import { contactOf } from '../workspace/testing.js';
import { isoWeekOf } from './common.js';
import { DAY, type InsightsWorld, call, insightsWorld, runWeeklyPlan, thisMonday } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let monday: Instant;
let week: string;
// one agent per scenario: a plan is built once per member and week
const agents: Record<'next' | 'dncLoser' | 'dncSurvivor' | 'stored' | 'storedDnc' | 'storedHidden' | 'other', TestClient> = {} as never;
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

/** L merged into S through the API (POST /leads/:S/merge, the ownership engine). */
async function merge(by: TestClient, survivorId: string, loserId: string, ownerChoice?: string): Promise<void> {
  const m = await command(by, survivorId, 'merge', { loserId, ...(ownerChoice ? { ownerChoice } : {}) });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  const r = (await h.su.query(`SELECT merged_into_contact_id, closed_reason FROM contacts WHERE tenant_id = $1 AND id = $2`, [w.tenantId, loserId])).rows[0];
  expect(r).toEqual({ merged_into_contact_id: survivorId, closed_reason: 'merged' });
}

async function doNotContact(by: TestClient, contactId: string): Promise<void> {
  const d = await call(by, 'POST', `/contacts/${contactId}/do-not-contact`, { reason: 'asked_on_call' });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
}

const plan = async (c: TestClient) => {
  const r = await call<PlanT>(c, 'GET', `/me/weekly-plans/${week}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.exists).toBe(true);
  return r.body;
};
const itemCiting = (p: PlanT, sourceId: string) => p.items!.find((i) => i.item.evidence.some((e) => e.sourceId === sourceId));
const contactOfItem = (p: PlanT, sourceId: string) => itemCiting(p, sourceId)?.item.contactId ?? null;
const stored = async (c: TestClient) =>
  (await h.su.query(`SELECT payload FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan' AND owner_user_id = $2`, [w.tenantId, c.userId])).rows[0].payload as { items: { contactId: string | null }[] };

/** Duplicate records L and S of `agent`, with a promise and an appointment awaiting its outcome on L. */
async function pairWithWork(key: string, agent: TestClient): Promise<void> {
  const at = (days: number) => new Date(monday + days * DAY);
  ids[`l_${key}`] = (await contactOf(agent)).id;
  ids[`s_${key}`] = (await contactOf(agent)).id;
  ids[`control_${key}`] = await task(agent, 'todo', `Order the yard sign (${key})`, at(2));
  ids[`promise_${key}`] = await task(agent, 'promise', `Send the comps (${key})`, at(1), ids[`l_${key}`]);
  ids[`appt_${key}`] = await appt(agent, ids[`l_${key}`]!);
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  monday = thisMonday(w.zone);
  week = isoWeekOf(localDateOf(monday, zone(w.zone)));
  [agents.next, agents.dncLoser] = w.agents as [TestClient, TestClient];
  for (const k of ['dncSurvivor', 'stored', 'storedDnc', 'storedHidden', 'other'] as const) agents[k] = await h.invite(w.owner, 'agent');

  // merged BEFORE the plan is built
  await pairWithWork('next', agents.next);
  await merge(agents.next, ids.s_next!, ids.l_next!);
  await pairWithWork('dncLoser', agents.dncLoser);
  await doNotContact(agents.dncLoser, ids.l_dncLoser!); // the record merged away asked first
  await merge(agents.dncLoser, ids.s_dncLoser!, ids.l_dncLoser!);
  await pairWithWork('dncSurvivor', agents.dncSurvivor);
  await merge(agents.dncSurvivor, ids.s_dncSurvivor!, ids.l_dncSurvivor!);
  await doNotContact(agents.dncSurvivor, ids.s_dncSurvivor!); // the survivor asks after the merge

  // merged AFTER the plan is built (in the tests)
  await pairWithWork('stored', agents.stored);
  await pairWithWork('storedDnc', agents.storedDnc);
  await pairWithWork('storedHidden', agents.storedHidden);
  // the survivor of the hidden case belongs to another agent: the planning agent cannot see it
  ids.s_storedHidden = (await contactOf(agents.other)).id;

  const r = await runWeeklyPlan(h, w.tenantId, monday);
  expect(r.week).toBe(week);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-PLAN-3 the weekly plan keeps a merged person\'s work on the survivor', () => {
  it('R-PLAN-3 E550: the next plan offers the moved work on the survivor', async () => {
    const p = await plan(agents.next);
    expect(contactOfItem(p, ids.promise_next!)).toBe(ids.s_next);
    expect(contactOfItem(p, ids.appt_next!)).toBe(ids.s_next);
    expect(itemCiting(p, ids.control_next!)).toBeDefined();
    expect(JSON.stringify(p)).not.toContain(ids.l_next);
    expect(JSON.stringify(await stored(agents.next))).not.toContain(ids.l_next);
    expect(p.droppedSinceBuilt).toBe(0);
  });

  it('R-PLAN-3 E550: a do-not-contact on any record keeps it out', async () => {
    for (const key of ['dncLoser', 'dncSurvivor'] as const) {
      const p = await plan(agents[key]);
      expect(itemCiting(p, ids[`promise_${key}`]!), key).toBeUndefined();
      expect(itemCiting(p, ids[`appt_${key}`]!), key).toBeUndefined();
      for (const c of [ids[`l_${key}`]!, ids[`s_${key}`]!]) expect(JSON.stringify(p), key).not.toContain(c);
      expect(itemCiting(p, ids[`control_${key}`]!), key).toBeDefined();
    }
    // and at render: a plan stored before the merge, the survivor do-not-contact since: the item is dropped, never
    // re-keyed onto the person who asked
    const before = await plan(agents.storedDnc);
    expect(contactOfItem(before, ids.promise_storedDnc!)).toBe(ids.l_storedDnc);
    await merge(agents.storedDnc, ids.s_storedDnc!, ids.l_storedDnc!);
    await doNotContact(agents.storedDnc, ids.s_storedDnc!);
    const after = await plan(agents.storedDnc);
    expect(itemCiting(after, ids.promise_storedDnc!)).toBeUndefined();
    expect(itemCiting(after, ids.appt_storedDnc!)).toBeUndefined();
    expect(after.droppedSinceBuilt).toBe(2);
    expect(JSON.stringify(after.items)).not.toContain(ids.s_storedDnc);
    for (const i of before.items!.filter((x) => x.item.contactId === ids.l_storedDnc).map((x) => x.index)) {
      expect((await call(agents.storedDnc, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [i] })).status).toBe(404);
    }
  });

  it('R-PLAN-3 E551: a plan stored before the merge shows the items on the survivor, droppedSinceBuilt 0, and accept uses the survivor', async () => {
    const before = await plan(agents.stored);
    const onL = before.items!.filter((i) => i.item.contactId === ids.l_stored).map((i) => i.index);
    expect(onL).toHaveLength(2);
    await merge(agents.stored, ids.s_stored!, ids.l_stored!);
    const after = await plan(agents.stored);
    expect(after.droppedSinceBuilt).toBe(0);
    expect(after.items!.map((i) => i.index)).toEqual(before.items!.map((i) => i.index));
    expect(contactOfItem(after, ids.promise_stored!)).toBe(ids.s_stored);
    expect(contactOfItem(after, ids.appt_stored!)).toBe(ids.s_stored);
    expect(JSON.stringify(after.items)).not.toContain(ids.l_stored);
    // the stored payload is kept as built
    expect((await stored(agents.stored)).items.filter((i) => i.contactId === ids.l_stored)).toHaveLength(2);

    const ok = await call<PlanT>(agents.stored, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: onL });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const taskIds = ok.body.accepted!.taskIds;
    expect(taskIds).toHaveLength(2);
    expect(taskIds).toContain(ids.promise_stored); // an existing task is not copied (it moved with the merge)
    const rows = (await h.su.query(`SELECT id, contact_id, assignee_user_id FROM tasks WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [w.tenantId, taskIds])).rows;
    expect(rows.map((r) => [r.contact_id, r.assignee_user_id])).toEqual([[ids.s_stored, agents.stored.userId], [ids.s_stored, agents.stored.userId]]);
    expect(ok.body.droppedSinceBuilt).toBe(0);

    // re-keyed only onto a survivor the member sees: merged by the Owner into another agent's record, the work moved
    // there, and this member's stored items are dropped as before
    const hidden = await plan(agents.storedHidden);
    expect(contactOfItem(hidden, ids.promise_storedHidden!)).toBe(ids.l_storedHidden);
    await merge(w.owner, ids.s_storedHidden!, ids.l_storedHidden!, agents.other.userId!);
    const gone = await plan(agents.storedHidden);
    expect(itemCiting(gone, ids.promise_storedHidden!)).toBeUndefined();
    expect(itemCiting(gone, ids.appt_storedHidden!)).toBeUndefined();
    expect(gone.droppedSinceBuilt).toBe(2);
    expect(JSON.stringify(gone.items)).not.toContain(ids.s_storedHidden);
  });
});
