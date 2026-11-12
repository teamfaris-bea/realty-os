// The weekly plan end to end (module 33; DATA_MODEL R-PLAN-1…3, R-OWN-27; E110, E111): the hourly reconcile as the
// system actor, the feed card under weekly_plan:{user}:{week}, the member's read with render-time drops, and accept.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { contactOf } from '../workspace/testing.js';
import { isoWeekOf } from './common.js';
import { localDateOf, zone } from '@realty/core/foundation';
import { DAY, type InsightsWorld, ago, call, deal, history, insightsWorld, runWeeklyPlan, thisMonday } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let a0: TestClient;
let a1: TestClient;
let monday: Instant;
let week: string;
const ids: Record<string, string> = {};

interface PlanT {
  week: string;
  exists: boolean;
  basis?: string;
  note?: string;
  items?: { index: number; accepted: boolean; item: { kind: string; title: string; deadline: string | null; contactId: string | null; dealId: string | null; evidence: { sourceType: string; sourceId: string; reason: string }[] } }[];
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

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  [a0, a1] = w.agents as [TestClient, TestClient];
  monday = thisMonday(w.zone);
  week = isoWeekOf(localDateOf(monday, zone(w.zone)));
  const at = (days: number) => new Date(monday + days * DAY);
  // a0's pipeline: a promise due Tuesday, a todo due Wednesday, a callback with no due date, an appointment that ended
  // Sunday with no outcome, a slow deal; plus a task for a person-level do-not-contact contact (never suggested)
  ids.promise = await task(a0, 'promise', 'Send Sam the comps', at(1));
  ids.todo = await task(a0, 'todo', 'Order the sign', at(2));
  ids.callback = await task(a0, 'callback', 'Call Lena back', null);
  ids.nextWeek = await task(a0, 'todo', 'Far away', at(10)); // after this week: not a candidate
  const dnc = await contactOf(a0);
  ids.dncContact = dnc.id;
  await suFixture(h, [{ text: `UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = gen_random_uuid() WHERE tenant_id = $1 AND id = $2`, values: [w.tenantId, dnc.id] }]);
  ids.dncTask = await task(a0, 'todo', 'Call the do-not-contact person', at(1), dnc.id);
  const c = await contactOf(a0);
  ids.appt = randomUUID();
  await h.su.query(
    `INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1, $2, $3, $4, $4, 'consult', $5, $6, 'user')`,
    [w.tenantId, ids.appt, c.id, a0.userId, at(-1), new Date(monday - DAY + 3_600_000)],
  );
  // norms: 5 prospect stays of 2 days (a1's), then a0's prospect sitting 12 days is slow (> 1.5 × 2, n ≥ 5)
  for (let i = 0; i < 5; i++) {
    const d = await deal(h, w.tenantId, { owner: a1, stage: 'agreement_signed', enteredAt: ago(20 + i) });
    await history(h, w.tenantId, d, 'prospect', ago(22 + i));
  }
  ids.slow = await deal(h, w.tenantId, { owner: a0, stage: 'prospect', enteredAt: ago(12), name: 'Ortiz purchase' });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const plan = async (c: TestClient, wk = week) => {
  const r = await call<PlanT>(c, 'GET', `/me/weekly-plans/${wk}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

describe('R-PLAN-1 the Monday plan', () => {
  it('R-PLAN-1 R-OWN-27: on the member’s local Monday the hourly reconcile builds one plan per member (no TCs) and one feed card that opens the plan page', async () => {
    const r = await runWeeklyPlan(h, w.tenantId, monday);
    expect(r).toMatchObject({ week, built: 6, existing: 0 }); // owner, admin, isa, TL, 2 agents (not the TC)
    const rows = (await h.su.query(`SELECT owner_user_id, kind, autonomy, action_category, status FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan'`, [w.tenantId])).rows;
    expect(rows).toHaveLength(6);
    expect(rows.every((x) => x.autonomy === 'internal' && x.action_category === 'internal' && x.status === 'proposed')).toBe(true);
    expect(rows.map((x) => x.owner_user_id)).not.toContain(w.tc.userId);
    const feed = await call<{ pinned: unknown[]; scored: { itemType: string; primaryAction: { kind: string; week?: string; label: string }; reasons: { label: string }[] }[] }>(a0, 'GET', '/feed');
    const card = feed.body.scored.filter((x) => x.itemType === 'weekly_plan');
    expect(card).toHaveLength(1);
    expect(card[0]!.primaryAction).toEqual({ kind: 'open_plan', label: 'See the plan', week });
    expect(card[0]!.reasons[0]!.label).toBe('Keep your promise: Send Sam the comps');
  });

  it('R-PLAN-1: 3–5 items, deadline first (soonest first), then the gap; each item carries evidence; the do-not-contact person is never suggested (R-PLAN-3)', async () => {
    const p = await plan(a0);
    expect(p.exists).toBe(true);
    const items = p.items!;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    // the two with deadlines first, soonest first; the undated three tie on gap 0 (no goals) and order by source id
    expect(items.map((i) => i.item.title).slice(0, 2)).toEqual(['Keep your promise: Send Sam the comps', 'Order the sign']);
    expect(items.map((i) => i.item.title).slice(2).sort()).toEqual(['Call Lena back', 'Log the outcome of this appointment', 'Move Ortiz purchase forward']);
    const deadlines = items.map((i) => i.item.deadline).filter((d): d is string => d !== null);
    expect([...deadlines].sort()).toEqual(deadlines);
    expect(items.slice(0, deadlines.length).every((i) => i.item.deadline !== null)).toBe(true);
    for (const i of items) expect(i.item.evidence.length).toBeGreaterThanOrEqual(1);
    expect(items.find((i) => i.item.kind === 'move_deal')!.item.evidence[0]!.reason).toMatch(/median 2 \(n=5\)/);
    expect(JSON.stringify(p)).not.toContain(ids.dncTask);
    expect(JSON.stringify(p)).not.toContain(ids.nextWeek);
    expect(JSON.stringify(p)).not.toMatch(/cents|commission|confidence|score|grade/i);
  });

  it('E110: a member with no goals gets a plan built from the pipeline only, and it says so', async () => {
    const p = await plan(a0);
    expect(p.basis).toBe('pipeline_only');
    expect(p.note).toMatch(/no goals set.*pipeline only/);
    const empty = await plan(a1);
    expect(empty.items).toEqual([]); // a1's only work is the norm deals: nothing slow of theirs, no tasks
    expect((await call<{ scored: { itemType: string }[] }>(a1, 'GET', '/feed')).body.scored.filter((x) => x.itemType === 'weekly_plan')).toEqual([]);
  });

  it('R-PLAN-1: deduped per member and week: a rerun, a concurrent run and a dismissed card never make a second plan or card', async () => {
    const card = (await call<{ scored: { id: string; itemType: string }[] }>(a0, 'GET', '/feed')).body.scored.find((x) => x.itemType === 'weekly_plan')!;
    expect((await call(a0, 'POST', `/feed/${card.id}/dismiss`)).status).toBe(200);
    const [x, y] = await Promise.all([runWeeklyPlan(h, w.tenantId, (monday + 3_600_000) as Instant), runWeeklyPlan(h, w.tenantId, (monday + 7_200_000) as Instant)]);
    expect(x.built + y.built).toBe(0);
    const n = (await h.su.query(`SELECT count(*)::int AS n FROM priority_feed_items WHERE tenant_id = $1 AND user_id = $2 AND item_type = 'weekly_plan'`, [w.tenantId, a0.userId])).rows[0].n;
    expect(n).toBe(1);
    expect((await call<{ scored: { itemType: string }[] }>(a0, 'GET', '/feed')).body.scored.filter((s) => s.itemType === 'weekly_plan')).toEqual([]);
  });

  it('R-OWN-27: Thursday to Sunday build nothing; Tuesday repairs a missed Monday (a member who joined after Monday gets one)', async () => {
    const late = await h.invite(w.owner, 'agent');
    expect(await runWeeklyPlan(h, w.tenantId, thisMonday(w.zone, 3))).toEqual({ week: null, built: 0, existing: 0 });
    expect((await plan(late)).exists).toBe(false);
    const r = await runWeeklyPlan(h, w.tenantId, thisMonday(w.zone, 1));
    expect(r).toMatchObject({ week, built: 1 });
    expect((await plan(late)).exists).toBe(true);
  });
});

describe('R-PLAN-3 render-time drops', () => {
  it('E111: an item citing a deal reassigned since is dropped at render (and counted); so is one whose contact became do-not-contact since', async () => {
    const before = await plan(a0);
    expect(before.items!.some((i) => i.item.dealId === ids.slow)).toBe(true);
    await h.su.query(`UPDATE deals SET owner_user_id = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenantId, ids.slow, a1.userId]);
    const after = await plan(a0);
    expect(after.items!.some((i) => i.item.dealId === ids.slow)).toBe(false);
    expect(after.droppedSinceBuilt).toBe(1);
    await h.su.query(`UPDATE deals SET owner_user_id = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenantId, ids.slow, a0.userId]);
    expect((await plan(a0)).droppedSinceBuilt).toBe(0);
  });

  it('R-PLAN-3: another member never reads or accepts someone else’s plan (it does not exist for them)', async () => {
    expect((await plan(a1)).items!.some((i) => JSON.stringify(i).includes(ids.promise!))).toBe(false);
    const r = await call<PlanT>(w.owner, 'GET', `/me/weekly-plans/${week}`);
    expect(JSON.stringify(r.body)).not.toContain(ids.promise);
    expect((await call(a1, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [4] })).status).toBe(404);
    expect((await call(a0, 'GET', '/me/weekly-plans/2026-W99')).status).toBe(422);
  });
});

describe('R-PLAN-1 accepting', () => {
  it('R-PLAN-1: nothing is created until the member taps; one tap adds the chosen items to their tasks (existing tasks are not copied); a second accept is refused', async () => {
    const tasksBefore = (await h.su.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND assignee_user_id = $2`, [w.tenantId, a0.userId])).rows[0].n;
    const p = await plan(a0);
    const pick = p.items!.filter((i) => ['keep_promise', 'log_outcome', 'move_deal'].includes(i.item.kind)).map((i) => i.index);
    const r = await call<PlanT>(a0, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: pick });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accepted!.taskIds).toHaveLength(pick.length);
    expect(r.body.accepted!.taskIds).toContain(ids.promise);
    const tasksAfter = (await h.su.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND assignee_user_id = $2`, [w.tenantId, a0.userId])).rows[0].n;
    expect(tasksAfter - tasksBefore).toBe(pick.length - 1); // the promise already was a task
    const made = (await h.su.query(`SELECT title, created_by_kind, created_by_user_id, deal_id FROM tasks WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND id <> $3 ORDER BY title`, [w.tenantId, r.body.accepted!.taskIds, ids.promise])).rows;
    expect(made.every((t) => t.created_by_kind === 'user' && t.created_by_user_id === a0.userId)).toBe(true);
    expect(made.find((t) => t.deal_id === ids.slow)!.title).toBe('Move Ortiz purchase forward');
    const action = (await h.su.query(`SELECT status, decided_by_user_id, decided_by_role FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan' AND owner_user_id = $2`, [w.tenantId, a0.userId])).rows[0];
    expect(action).toEqual({ status: 'executed', decided_by_user_id: a0.userId, decided_by_role: 'agent' });
    const again = await call(a0, 'POST', `/me/weekly-plans/${week}/accept`, { itemIndexes: [0] });
    expect([again.status, again.code]).toEqual([409, 'PLAN_ALREADY_ACCEPTED']);
    const re = await plan(a0);
    expect(re.items!.filter((i) => i.accepted).map((i) => i.index)).toEqual(pick);
  });

  it('R-PLAN-1: the plan of the current week is also served at /me/weekly-plans/current', async () => {
    const r = await call<PlanT>(a0, 'GET', '/me/weekly-plans/current');
    expect(r.status).toBe(200);
    expect(r.body.week).toBe(isoWeekOf(localDateOf(Date.now() as Instant, zone(w.zone))));
  });
});
