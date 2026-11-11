// Goals and pace through the real server (module 33; DATA_MODEL agent_goals RLS, R-PLAN-2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type InsightsWorld, ago, call, deal, history, insightsWorld, ym } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let a0: TestClient;
let a1: TestClient;
let monthStart: string;

interface GoalT {
  id: string;
  userId: string;
  metric: string;
  target: number;
  pace: { actual: number; status: string; words: string; method: string; expectedByNow: number; behindBy: number };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  [a0, a1] = w.agents as [TestClient, TestClient];
  monthStart = `${ym(new Date(), w.zone)}-01`;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const create = (c: TestClient, body: Record<string, unknown>) => call<{ goal: GoalT }>(c, 'POST', '/goals', { periodKind: 'month', periodStart: monthStart, ...body });

describe('R-PLAN-2 goals and pace', () => {
  it('R-PLAN-2: the Owner sets a closings goal for an agent and sees its pace, counted from the agent’s deals closed in the period; the agent sees the same pace', async () => {
    const r = await create(w.owner, { userId: a0.userId, metric: 'closings', target: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.goal.pace.actual).toBe(0);
    // one closing this month, one long ago, one of another agent: only the first counts
    const closedAt = new Date(Math.max(Date.now() - 3_600_000, new Date(`${monthStart}T12:00:00Z`).getTime()));
    await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt });
    await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: ago(200) });
    await deal(h, w.tenantId, { owner: a1, stage: 'closed', closedAt });
    const mine = await call<{ goals: GoalT[] }>(a0, 'GET', '/goals');
    expect(mine.status).toBe(200);
    const g = mine.body.goals.find((x) => x.id === r.body.goal.id)!;
    expect(g.pace.actual).toBe(1);
    expect(g.pace.words).toMatch(/^1 of 4 closings; [\d.]+ expected by now; 3 to go in \d+ days?$/);
    expect(g.pace.method).toMatch(/scoreboard/);
    expect(JSON.stringify(mine.body)).not.toMatch(/confidence|score"|grade/i);
    const owner = await call<{ goals: GoalT[] }>(w.owner, 'GET', `/goals?userId=${a0.userId}`);
    expect(owner.body.goals.find((x) => x.id === r.body.goal.id)!.pace.actual).toBe(1);
  });

  it('R-PLAN-2: agreements signed come from app.scoreboard_activity (the scoreboard definer), credited to the deal owner', async () => {
    const r = await create(w.owner, { userId: a1.userId, metric: 'agreements_signed', target: 2 });
    expect(r.status).toBe(201);
    const d = await deal(h, w.tenantId, { owner: a1, stage: 'agreement_signed', enteredAt: new Date(Date.now() - 60_000) });
    await history(h, w.tenantId, d, 'agreement_signed', new Date(Date.now() - 30_000));
    const g = (await call<{ goals: GoalT[] }>(a1, 'GET', '/goals')).body.goals.find((x) => x.id === r.body.goal.id)!;
    expect(g.pace.actual).toBe(2); // the fixture's entry + the second entry, both this month
  });

  it('R-PLAN-2: a Team Lead manages goals of their team’s members; an agent manages none; nobody outside the set (404, never 403)', async () => {
    const tl = await create(w.teamLead, { userId: a0.userId, metric: 'touches', target: 50 });
    expect(tl.status).toBe(201);
    expect((await create(a0, { userId: a0.userId, metric: 'appointments_set', target: 3 })).status).toBe(404);
    expect((await create(w.teamLead, { userId: w.isa.userId, metric: 'touches', target: 5 })).status).toBe(404);
    expect((await call(a0, 'PATCH', `/goals/${tl.body.goal.id}`, { target: 1 })).status).toBe(404);
    expect((await call(a0, 'DELETE', `/goals/${tl.body.goal.id}`)).status).toBe(404);
    // agents read only their own goals
    expect((await call(a1, 'GET', `/goals?userId=${a0.userId}`)).status).toBe(404);
    const theirs = await call<{ goals: GoalT[]; members: { userId: string; canManage: boolean }[] }>(a1, 'GET', '/goals');
    expect(theirs.body.goals.every((g) => g.userId === a1.userId)).toBe(true);
    expect(theirs.body.members.map((m) => m.userId)).toEqual([a1.userId]);
    expect(theirs.body.members[0]!.canManage).toBe(false);
    const tlView = await call<{ members: { userId: string; canManage: boolean }[] }>(w.teamLead, 'GET', '/goals');
    expect(tlView.body.members.filter((m) => m.canManage).map((m) => m.userId).sort()).toEqual([a0.userId, a1.userId, w.teamLead.userId].sort());
  });

  it('R-PLAN-2: a period starts where its kind starts; one goal per member, period and metric; target changes and removals are audited', async () => {
    const bad = await call(w.owner, 'POST', '/goals', { userId: a1.userId, periodKind: 'month', periodStart: '2026-11-02', metric: 'touches', target: 5 });
    expect([bad.status, bad.code]).toEqual([422, 'GOAL_PERIOD_START_INVALID']);
    const badWeek = await call(w.owner, 'POST', '/goals', { userId: a1.userId, periodKind: 'week', periodStart: '2026-11-10', metric: 'touches', target: 5 });
    expect(badWeek.status).toBe(422);
    const ok = await create(w.owner, { userId: a1.userId, metric: 'touches', target: 5 });
    expect(ok.status).toBe(201);
    const dup = await create(w.owner, { userId: a1.userId, metric: 'touches', target: 6 });
    expect([dup.status, dup.code]).toEqual([409, 'GOAL_EXISTS']);
    const p = await call<{ goal: GoalT }>(w.admin, 'PATCH', `/goals/${ok.body.goal.id}`, { target: 9 });
    expect(p.status).toBe(200);
    expect(p.body.goal.target).toBe(9);
    expect((await call(w.admin, 'DELETE', `/goals/${ok.body.goal.id}`)).status).toBe(200);
    expect((await call(w.admin, 'DELETE', `/goals/${ok.body.goal.id}`)).status).toBe(404);
    const a = (await h.su.query(`SELECT reason FROM audit_log WHERE tenant_id = $1 AND action = 'goal.changed' AND entity_id = $2 ORDER BY occurred_at`, [w.tenantId, ok.body.goal.id])).rows.map((r) => r.reason);
    expect(a).toEqual(['CREATED', 'TARGET_CHANGED', 'DELETED']);
  });

  it('R-PLAN-2 R-TEN-3: another tenant’s Owner cannot see, change or create goals for this tenant’s members', async () => {
    const other = await h.signup({ timezone: 'America/New_York' });
    const g = (await call<{ goals: GoalT[] }>(w.owner, 'GET', '/goals')).body.goals[0]!;
    expect((await call<{ goals: GoalT[] }>(other, 'GET', '/goals')).body.goals).toEqual([]);
    expect((await call(other, 'PATCH', `/goals/${g.id}`, { target: 1 })).status).toBe(404);
    expect((await call(other, 'POST', '/goals', { userId: a0.userId, periodKind: 'month', periodStart: monthStart, metric: 'touches', target: 1 })).status).toBe(404);
  });
});
