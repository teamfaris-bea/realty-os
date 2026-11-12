// api/gbp routes, mounted under /api (module 53; PHASE2_3_PLAN §5.4 #53).
//
//   GET  /gbp/status                 why Google Business Profile is off, or when each location was read  gbp.view
//   GET  /gbp/reviews?connectionId&filter=needs_reply|all   each review with its state in words       gbp.view
//   POST /gbp/reviews/:id/draft      {mode: assistant|manual, text?}: a draft, on a tap only (E133)     gbp.reply (Owner/Admin)
//   POST /gbp/reviews/:id/reply      {actionId, text}: the one tap that posts it                        gbp.reply
//   POST /gbp/reviews/:id/discard    {actionId}: drop a waiting draft                                   gbp.reply
//
// Every handler runs in the caller's tenant transaction under FORCE RLS. Responses carry no tenant id, no confidence,
// and nothing about the reviewer beyond what Google shows publicly (never a contact).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { adminTx, platformOf } from '../admin/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as R from './repos/gbp.js';
import * as S from './schemas.js';
import { type ReplyDeps, discardReply, draftReply, listReviews, postReply } from './replies.js';
import { gbpStatus } from './status.js';
import type { Platform } from '../server.js';
import { actorOf } from '../leads/common.js';

const replyDepsOf = (p: Platform): ReplyDeps => ({ db: p.db, envelope: p.envelope, ids: p.ids, ai: p.providers.ai, gbp: p.providers.gbp });

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'gbp.view' as const }, preHandler: authorize('gbp.view', () => ({})) };

  r.get('/gbp/status', { ...view, schema: { response: { 200: S.StatusResponse } } }, async (req) => ({
    status: await adminTx(req, async (tx) => {
      const pack = await R.packState(tx);
      const zone = (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC';
      // R-GBP-3: while uncleared, no location state is read or shown
      return gbpStatus(pack, platformOf(req).providers.gbp, pack.cleared ? await R.locations(tx) : [], zone);
    }),
  }));

  r.get('/gbp/reviews', { ...view, schema: { querystring: S.ReviewsQuery, response: { 200: S.ReviewsResponse } } }, async (req) => ({
    reviews: await adminTx(req, (tx) => listReviews(tx, { connectionId: req.query.connectionId ?? null, filter: req.query.filter }, Date.now())),
  }));

  const reply = { config: { auth: 'gbp.reply' as const }, preHandler: authorize('gbp.reply', () => ({})) };
  r.post('/gbp/reviews/:id/draft', { ...reply, schema: { params: S.ReviewParams, body: S.DraftBody, response: { 200: S.ReviewResponse } } }, async (req) => ({
    review: await draftReply(replyDepsOf(platformOf(req)), actorOf(req), req.params.id, req.body),
  }));
  r.post('/gbp/reviews/:id/reply', { ...reply, schema: { params: S.ReviewParams, body: S.ReplyBody, response: { 200: S.ReplyResponse } } }, async (req) => {
    const out = await postReply(replyDepsOf(platformOf(req)), actorOf(req), req.params.id, req.body);
    return { review: out.review, outcome: out.outcome.kind, sentence: out.sentence };
  });
  r.post('/gbp/reviews/:id/discard', { ...reply, schema: { params: S.ReviewParams, body: S.DiscardBody, response: { 200: S.ReviewResponse } } }, async (req) => ({
    review: await discardReply(replyDepsOf(platformOf(req)), actorOf(req), req.params.id, req.body),
  }));
}

export const gbpRoutes: RouteModule = { name: 'gbp', register };
