// api/insights routes (PHASE2_3_PLAN module 33). Mounted under /api by routes.ts.
//
//   GET    /owner/sources?from&to          dollars by source, costs, cost per closing    owner_view.view (human Owner/Admin)
//   GET    /owner/velocity                 median stage dwell with n                      owner_view.view
//   GET    /owner/forecast                 90-day range, method, samples, exclusions      owner_view.view
//   GET    /lead-source-costs?from&to      the cost rows to edit                          owner_view.view
//   PUT    /lead-source-costs              a manual cost (closed month: 🔒), audited      source_cost.edit
//   GET    /goals?userId                   goals with pace + who the caller may manage    goal.view
//   POST   /goals                          create                                         goal.manage
//   PATCH  /goals/:id                      change the target                              goal.manage
//   DELETE /goals/:id                      remove                                         goal.manage
//   GET    /me/weekly-plans/current        this week's plan                               self
//   GET    /me/weekly-plans/:week          one week's plan (items dropped at render)      self
//   POST   /me/weekly-plans/:week/accept   add chosen items to my tasks (one tap)         self
//
// Every permission denial is 404 (R-PERM-5): an agent or a Team Lead asking for the owner view gets 404, never 403.
// None of these routes is reachable by the system actor or a support session (no system via, no support flag).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { addMonthsYm, insightsTx, mondayOfIsoWeek, monthOf, monthsBetween, platformOf, tenantZone } from './common.js';
import { createGoal, deleteGoal, goalMembers, goalOwner, goalRelation, goalsWithPace, updateGoal } from './goals.js';
import { costMonthState, forecastView, listCosts, putCost, sources, velocity } from './owner.js';
import { acceptPlan, currentWeek, getPlan } from './plan.js';
import {
  AcceptPlanBody,
  CostsResponse,
  CreateGoalBody,
  ForecastResponse,
  GoalResponse,
  GoalsQuery,
  GoalsResponse,
  OkResponse,
  PeriodQuery,
  PlanResponse,
  PutCostBody,
  PutCostResponse,
  SourcesResponse,
  UpdateGoalBody,
  VelocityResponse,
  Week,
} from './schemas.js';

/** At most two years in one owner-view request. */
export const MAX_PERIOD_MONTHS = 24;

export const PACE_METHOD =
  'Counted from the scoreboard for this member over the goal period so far (closings: their deals that closed in the period), compared with an even pace across the period.';

async function period(req: FastifyRequest, q: { from?: string | undefined; to?: string | undefined }) {
  const now = platformOf(req).clock.now();
  return insightsTx(req, async (tx) => {
    const cur = monthOf(now, await tenantZone(tx));
    const to = q.to ?? cur;
    const from = q.from ?? to;
    if (to < from || monthsBetween(from, to) > MAX_PERIOD_MONTHS) throw new AppError('VALIDATION_FAILED', { reason: 'PERIOD_RANGE' });
    return { from, to, cur, prev: addMonthsYm(cur, -1) };
  });
}

function goalView(g: Awaited<ReturnType<typeof goalsWithPace>>['goals'][number]) {
  return {
    id: g.goal.id as string,
    userId: g.goal.userId as string,
    periodKind: g.goal.periodKind,
    periodStart: g.goal.periodStart as string,
    periodEndExclusive: g.pace.periodEndExclusive as string,
    metric: g.goal.metric,
    target: g.goal.target,
    pace: {
      actual: g.pace.actual,
      expectedByNow: g.pace.expectedByNow,
      behindBy: g.pace.behindBy,
      remaining: g.pace.remaining,
      daysLeft: g.pace.daysLeft,
      status: g.pace.status,
      words: g.pace.words,
      method: PACE_METHOD,
    },
  };
}

function planView(p: Awaited<ReturnType<typeof getPlan>>) {
  if (!p.exists) return { week: p.week, exists: false };
  return {
    ...p,
    items: p.items.map((x) => ({ index: x.index, accepted: x.accepted, item: { ...x.item, evidence: x.item.evidence.map((e) => ({ ...e })), deadline: x.item.deadline === null ? null : new Date(x.item.deadline).toISOString() } })),
  };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ownerView = { config: { auth: 'owner_view.view' as const }, preHandler: authorize('owner_view.view', () => ({})) };
  const Params = z.object({ id: z.uuid() }).strict();
  const WeekParams = z.object({ week: Week }).strict();

  r.get('/owner/sources', { ...ownerView, schema: { querystring: PeriodQuery, response: { 200: SourcesResponse } } }, async (req) => {
    const p = await period(req, req.query);
    return insightsTx(req, (tx) => sources(tx, p.from, p.to));
  });
  r.get('/owner/velocity', { ...ownerView, schema: { response: { 200: VelocityResponse } } }, async (req) => insightsTx(req, (tx) => velocity(tx)));
  r.get('/owner/forecast', { ...ownerView, schema: { response: { 200: ForecastResponse } } }, async (req) => insightsTx(req, (tx, now) => forecastView(tx, now)));
  r.get('/lead-source-costs', { ...ownerView, schema: { querystring: PeriodQuery, response: { 200: CostsResponse } } }, async (req) => {
    const p = await period(req, req.query);
    return insightsTx(req, (tx) => listCosts(tx, p.from, p.to));
  });
  r.put(
    '/lead-source-costs',
    {
      config: { auth: 'source_cost.edit' },
      // a closed month (ended in the tenant zone) needs a fresh re-auth; the open month does not (DATA_MODEL §8)
      preHandler: authorize('source_cost.edit', async (req) => {
        const b = req.body as z.infer<typeof PutCostBody>;
        const now = platformOf(req).clock.now();
        const state = await insightsTx(req, (tx) => costMonthState(tx, b.month, now));
        return { closedPeriod: state === 'closed' };
      }),
      schema: { body: PutCostBody, response: { 200: PutCostResponse } },
    },
    async (req) => ({
      cost: await insightsTx(req, (tx, now, actor) => putCost(tx, actor, platformOf(req).ids, now, req.body, { reauthenticatedAt: req.authState?.reauthenticatedAt ?? null, now })),
    }),
  );

  // ---- goals ----
  r.get(
    '/goals',
    {
      config: { auth: 'goal.view' },
      preHandler: authorize('goal.view', async (req) => {
        const q = req.query as z.infer<typeof GoalsQuery>;
        if (!q.userId) return { own: true };
        return insightsTx(req, (tx, _n, actor) => goalRelation(tx, actor, q.userId!));
      }),
      schema: { querystring: GoalsQuery, response: { 200: GoalsResponse } },
    },
    async (req) =>
      insightsTx(req, async (tx, now, actor) => {
        const { zone, goals } = await goalsWithPace(tx, now, req.query.userId ? { userIds: [req.query.userId] } : {});
        return { zone: zone as string, members: await goalMembers(tx, actor), goals: goals.map(goalView) };
      }),
  );
  r.post(
    '/goals',
    {
      config: { auth: 'goal.manage' },
      preHandler: authorize('goal.manage', async (req) => {
        const b = req.body as z.infer<typeof CreateGoalBody>;
        return insightsTx(req, (tx, _n, actor) => goalRelation(tx, actor, b.userId));
      }),
      schema: { body: CreateGoalBody, response: { 201: GoalResponse } },
    },
    async (req, reply) => {
      const view = await insightsTx(req, async (tx, now, actor) => {
        const id = await createGoal(tx, actor, platformOf(req).ids, req.body);
        const { goals } = await goalsWithPace(tx, now, { userIds: [req.body.userId], pastDays: 100_000 });
        return goalView(goals.find((g) => g.goal.id === id)!);
      });
      return reply.status(201).send({ goal: view });
    },
  );
  const manageGoal = authorize('goal.manage', async (req) => {
    const { id } = req.params as { id: string };
    return insightsTx(req, async (tx, _n, actor) => {
      const userId = await goalOwner(tx, id);
      return userId ? goalRelation(tx, actor, userId) : null;
    });
  });
  r.patch('/goals/:id', { config: { auth: 'goal.manage' }, preHandler: manageGoal, schema: { params: Params, body: UpdateGoalBody, response: { 200: GoalResponse } } }, async (req) =>
    insightsTx(req, async (tx, now, actor) => {
      await updateGoal(tx, actor, req.params.id, req.body.target);
      const userId = (await goalOwner(tx, req.params.id))!;
      const { goals } = await goalsWithPace(tx, now, { userIds: [userId], pastDays: 100_000 });
      return { goal: goalView(goals.find((g) => g.goal.id === req.params.id)!) };
    }),
  );
  r.delete('/goals/:id', { config: { auth: 'goal.manage' }, preHandler: manageGoal, schema: { params: Params, response: { 200: OkResponse } } }, async (req) =>
    insightsTx(req, async (tx, _now, actor) => {
      await deleteGoal(tx, actor, req.params.id);
      return { ok: true as const };
    }),
  );

  // ---- the member's weekly plan (self) ----
  r.get('/me/weekly-plans/current', { config: { auth: 'self' }, schema: { response: { 200: PlanResponse } } }, async (req) =>
    insightsTx(req, async (tx, now, actor) => planView(await getPlan(tx, actor, (await currentWeek(tx, now)).week))),
  );
  r.get('/me/weekly-plans/:week', { config: { auth: 'self' }, schema: { params: WeekParams, response: { 200: PlanResponse } } }, async (req) => {
    if (!mondayOfIsoWeek(req.params.week)) throw new AppError('NOT_FOUND');
    return insightsTx(req, async (tx, _now, actor) => planView(await getPlan(tx, actor, req.params.week)));
  });
  r.post('/me/weekly-plans/:week/accept', { config: { auth: 'self' }, schema: { params: WeekParams, body: AcceptPlanBody, response: { 200: PlanResponse } } }, async (req) => {
    if (!mondayOfIsoWeek(req.params.week)) throw new AppError('NOT_FOUND');
    return insightsTx(req, async (tx, now, actor) => planView(await acceptPlan(tx, actor, platformOf(req).ids, now, req.params.week, req.body.itemIndexes)));
  });
}

export const insightsRoutes: RouteModule = { name: 'insights', register };
