// api/coaching-trends routes, mounted under /api (module 54; PHASE2_3_PLAN §5.4 #54).
//
//   GET /coaching/trends?weeks=1..4        the caller's own weekly trend per checklist item     coaching.view (own)
//   GET /coaching/trends/team?weeks=1..4   every member's and the team's                      coaching.team_view (Owner/Admin;
//                                          a Team Lead their team only while the Owner's switch is on: the definer decides)
// Every handler runs in the caller's tenant transaction; scored calls are read only through app.coaching_trends.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { adminTx } from '../../admin/common.js';
import { authorize } from '../../rbac.js';
import type { RouteModule } from '../../routes.js';
import * as S from './schemas.js';
import { ownTrends, teamTrends } from './views.js';

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const own = { config: { auth: 'coaching.view' as const }, preHandler: authorize('coaching.view', () => ({ own: true })) };
  const team = { config: { auth: 'coaching.team_view' as const }, preHandler: authorize('coaching.team_view', () => ({ team: true })) };

  r.get('/coaching/trends', { ...own, schema: { querystring: S.TrendsQuery, response: { 200: S.OwnTrendsResponse } } }, async (req) => ({
    trends: await adminTx(req, (tx, _now, actor) => ownTrends(tx, actor, req.query.weeks)),
  }));
  r.get('/coaching/trends/team', { ...team, schema: { querystring: S.TrendsQuery, response: { 200: S.TeamTrendsResponse } } }, async (req) => ({
    trends: await adminTx(req, (tx, _now, actor) => teamTrends(tx, actor, req.query.weeks)),
  }));
}

export const coachingTrendsRoutes: RouteModule = { name: 'coaching-trends', register };
