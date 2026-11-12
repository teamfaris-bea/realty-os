// api/transactions route module (PHASE2_3_PLAN §5.4 #31), mounted under /api by routes.ts:
//
//   GET  /deals/:id/milestones          the deal's timeline: dates, basis, risk state, each recipient's update
//                                       status, the queue's risk items the caller may read                 deal.view
//   POST /deals/:id/milestones/plan     acceptance date + template id/version → proposals (R-TXN-1, E95)   milestone.confirm
//   POST /deal-dates/:id/confirm        confirm (or move) one date as the person (R-TXN-1, R-TXN-2)         milestone.confirm
//   GET  /transactions/board            the TC board: the caller's open deals (RLS) with dates to act on     self
//   GET  /settings/milestone-templates  tenant templates, invalid entries by index (R-TXN-6)               milestone_template.manage
//   PUT  /settings/milestone-templates  replace them, audited as settings.changed (R-AUDIT-5)               milestone_template.manage
// Per-deal routes run core.can on dealFacts read from RLS-visible rows; an invisible deal or date is 404 (R-PERM-5).
// The Phase 1 POST /deals/:id/dates and PATCH /deal-dates/:id (workspace/routes.ts) use the same confirm path.
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { actorOf, mapWorkspaceDbError, wsTx } from '../workspace/common.js';
import { dealFacts, dealOfDate } from '../workspace/deals.js';
import { confirmInTx } from './confirm.js';
import { planInTx } from './plan.js';
import { board, milestonesOfDeal } from './reads.js';
import * as R from './repos.js';
import * as S from './schemas.js';
import { getTemplates, putTemplates } from './templates.js';

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

/** One request transaction as the session actor; the DB guard's refusal (deal_dates_confirm_guard) is the R-TXN-1 code, not a 404. */
async function txn<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: req.server.platform.db, retries: 2 });
  } catch (e) {
    if (String((e as { message?: unknown }).message ?? '').startsWith('DATE_HUMAN_CONFIRMATION')) throw new AppError('DATE_HUMAN_CONFIRMATION');
    throw mapWorkspaceDbError(e) ?? e;
  }
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const dealView = authorize('deal.view', (req) => wsTx(req, (tx) => dealFacts(tx, idOf(req))));
  const dealMilestone = authorize('milestone.confirm', (req) => wsTx(req, (tx) => dealFacts(tx, idOf(req))));
  const dateMilestone = authorize('milestone.confirm', (req) =>
    wsTx(req, async (tx) => {
      const dealId = await dealOfDate(tx, idOf(req));
      return dealId ? await dealFacts(tx, dealId) : null;
    }),
  );
  const templatesAuth = authorize('milestone_template.manage', () => ({}));

  r.get('/deals/:id/milestones', { config: { auth: 'deal.view' }, preHandler: dealView, schema: { params: S.IdParams, response: { 200: S.MilestonesResponse } } }, async (req) => {
    const m = await wsTx(req, (tx, now) => milestonesOfDeal(tx, req.params.id, now));
    if (!m) throw new AppError('NOT_FOUND');
    return m;
  });

  r.post('/deals/:id/milestones/plan', { config: { auth: 'milestone.confirm' }, preHandler: dealMilestone, schema: { params: S.IdParams, body: S.PlanBody, response: { 200: S.PlanResponse } } }, async (req) =>
    txn(req, (tx) => planInTx(tx, app.platform.ids, req.params.id, req.body)),
  );

  r.post('/deal-dates/:id/confirm', { config: { auth: 'milestone.confirm' }, preHandler: dateMilestone, schema: { params: S.IdParams, body: S.ConfirmBody, response: { 200: S.MilestonesResponse } } }, async (req) =>
    txn(req, async (tx, now, actor) => {
      const d = await R.dateById(tx, req.params.id);
      if (!d) throw new AppError('NOT_FOUND');
      await confirmInTx(tx, actor, app.platform.ids, {
        dealId: d.deal_id,
        dateId: d.id,
        ...(req.body.dueOn !== undefined ? { dueOn: req.body.dueOn } : {}),
        ...(req.body.responsible !== undefined ? { responsible: req.body.responsible } : {}),
        ...(req.body.reminderDaysBefore !== undefined ? { reminderDaysBefore: req.body.reminderDaysBefore } : {}),
      }, now);
      const m = await milestonesOfDeal(tx, d.deal_id, now);
      if (!m) throw new AppError('NOT_FOUND');
      return m;
    }),
  );

  r.get('/transactions/board', { config: { auth: 'self' }, schema: { response: { 200: S.BoardResponse } } }, async (req) => wsTx(req, (tx, now) => board(tx, now)));

  r.get('/settings/milestone-templates', { config: { auth: 'milestone_template.manage' }, preHandler: templatesAuth, schema: { response: { 200: S.TemplatesResponse } } }, async (req) => wsTx(req, (tx) => getTemplates(tx)));
  r.put('/settings/milestone-templates', { config: { auth: 'milestone_template.manage' }, preHandler: templatesAuth, schema: { body: S.PutTemplatesBody, response: { 200: S.TemplatesResponse } } }, async (req) =>
    wsTx(req, (tx, _now, actor) => putTemplates(tx, actor, req.body.templates)),
  );
}

export const transactionRoutes: RouteModule = { name: 'transactions', register };
