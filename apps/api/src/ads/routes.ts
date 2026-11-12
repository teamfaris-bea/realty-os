// api/ads routes (PHASE2_3_PLAN module 52; D2: Google Ads only). Mounted under /api by routes.ts.
//
//   GET    /ads                              the ads page: state, cap, month-to-date, daily total, campaigns, proposal    ads.view
//   GET    /ads/ledger?before=&limit=        the allocation ledger, newest first                                         ads.view
//   POST   /ads/caps                         a new cap version (the Owner, 🔒, attested), audited                         ads.cap_set
//   PATCH  /ads/campaigns/:id                link a campaign to a listing and an approved creative                       ads.campaign_manage
//   POST   /ads/campaigns/:id/resume         resume a paused campaign (one tap: an approved one-change shift)             ads.campaign_manage
//   POST   /ads/proposals/:id/approve        approve a weekly proposal (one tap; ads/dispatch.ts plans and applies it)    ads.shift_decide
//   POST   /ads/proposals/:id/reject         reject it                                                                   ads.shift_decide
//
// Every permission denial is 404 (R-PERM-5): an agent, a Team Lead or a support session gets 404 on each route. Human
// actors only: no system via, no support flag.
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { actorOf, mapWorkspaceDbError, platformOf } from '../workspace/common.js';
import { monthToDateCents, setCap } from './caps.js';
import { approveShift, mapAdsDbError, rejectShift, resumeCampaign } from './dispatch.js';
import { linkCampaign } from './link.js';
import { buildOverview, ledgerPageView } from './overview.js';
import type { AdsDeps } from './runtime.js';
import { CampaignResponse, CapBody, CapResponse, DecisionResponse, IdParams, LedgerQuery, LedgerResponse, LinkBody, OverviewResponse, RunResponse } from './schemas.js';
import { LEDGER_PAGE } from './settings.js';

/** One request transaction as the session's HUMAN actor (RLS-bound), with DB refusals mapped to their codes. */
async function adsTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  if (actor.kind !== 'user') throw new AppError('NOT_FOUND');
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const mapped = mapAdsDbError(e) ?? mapWorkspaceDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

function depsOf(req: FastifyRequest): AdsDeps {
  const p = platformOf(req);
  return { db: p.db, envelope: p.envelope, ids: p.ids, ads: p.providers.ads };
}

function human(req: FastifyRequest): UserActor {
  const a = actorOf(req);
  if (a.kind !== 'user') throw new AppError('NOT_FOUND');
  return a;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'ads.view' as const }, preHandler: authorize('ads.view', () => ({})) };
  const manage = { config: { auth: 'ads.campaign_manage' as const }, preHandler: authorize('ads.campaign_manage', () => ({})) };
  const decide = { config: { auth: 'ads.shift_decide' as const }, preHandler: authorize('ads.shift_decide', () => ({})) };

  r.get('/ads', { ...view, schema: { response: { 200: OverviewResponse } } }, async (req) => adsTx(req, (tx, now) => buildOverview(tx, now)));

  r.get('/ads/ledger', { ...view, schema: { querystring: LedgerQuery, response: { 200: LedgerResponse } } }, async (req) =>
    adsTx(req, (tx) => ledgerPageView(tx, req.query.before, req.query.limit ?? LEDGER_PAGE)),
  );

  r.post(
    '/ads/caps',
    { config: { auth: 'ads.cap_set' }, preHandler: authorize('ads.cap_set', () => ({})), schema: { body: CapBody, response: { 201: CapResponse } } },
    async (req, reply) => reply.status(201).send(await adsTx(req, (tx, now, actor) => setCap(tx, actor, platformOf(req).ids, now, req.body))),
  );

  r.patch('/ads/campaigns/:id', { ...manage, schema: { params: IdParams, body: LinkBody, response: { 200: CampaignResponse } } }, async (req) =>
    adsTx(req, async (tx, _now, actor) => {
      const c = await linkCampaign(tx, actor, req.params.id, req.body);
      return { campaign: { id: c.id, status: c.status, listingId: c.listingId, creativePieceId: c.creativePieceId, dailyBudgetCents: c.dailyBudgetCents } };
    }),
  );

  r.post('/ads/campaigns/:id/resume', { ...manage, schema: { params: IdParams, response: { 200: RunResponse } } }, async (req) =>
    resumeCampaign(depsOf(req), human(req), req.params.id, (tx) => monthToDateCents(tx, platformOf(req).clock.now())),
  );

  r.post('/ads/proposals/:id/approve', { ...decide, schema: { params: IdParams, response: { 200: RunResponse } } }, async (req) => approveShift(depsOf(req), human(req), req.params.id));

  r.post('/ads/proposals/:id/reject', { ...decide, schema: { params: IdParams, response: { 200: DecisionResponse } } }, async (req) => rejectShift(depsOf(req), human(req), req.params.id));
}

export const adsRoutes: RouteModule = { name: 'ads', register };
