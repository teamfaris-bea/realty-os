// Staff portal routes (R-PORTAL-13, R-PORTAL-14, R-PORTAL-16; DATA_MODEL §8 "Client portal"), at the /api root under
// the staff session guard (rbac.ts). Every route is an Action route with authorize(); an invisible resource, a role
// without the action and every denial are 404 (R-PERM-5).
//
//   POST  /deals/:id/portal/invite           portal.manage (deal facts)     invite a party; the notice after commit
//   POST  /listings/:id/portal/invite        portal.manage (listing facts)
//   GET   /deals/:id/portal                  portal.view                    accounts, grants, items, clearance, channels
//   GET   /listings/:id/portal               portal.view
//   GET   /portal-grants/:id/preview         portal.view                    the client view + visibleNow and why
//   POST  /portal-items/preview              portal.view                    publishable() + renderPortalItem(), no write
//   POST  /portal-items                      portal.manage                  publish into 1..10 grants, one result each
//   POST  /portal-items/:id/retract          portal.manage                  final
//   POST  /portal-grants/:id/revoke          portal.manage                  final
//   POST  /portal-accounts/:id/disable       portal.manage                  final
//   POST  /portal-accounts/:id/login-point   portal.manage                  voids outstanding links
//   PATCH /portal-grants/:id/display         portal.manage                  the grant's title
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../errors.js';
import { authorize } from '../../rbac.js';
import { platformOf } from '../../workspace/common.js';
import { dealFacts } from '../../workspace/deals.js';
import { LOGIN_POINT_CHANGED } from '../shared/copy.js';
import * as S from '../shared/schemas.js';
import { linkChannelWords, linkChannels } from '../signin/delivery.js';
import { accountFacts, canFor, grantFacts, grantById, itemGrant, listingPortalFacts, mergedFacts, scopeFacts, staffTx } from './common.js';
import { invite } from './invite.js';
import { changeLoginPoint, disableAccount, revokeGrant, setGrantTitle } from './manage.js';
import { itemPreview, publishBatch, retractItem } from './publish.js';
import { grantPreview, scopeState } from './views.js';

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const dealF = (req: FastifyRequest) => staffTx(req, (tx) => dealFacts(tx, idOf(req)));
  const listingF = (req: FastifyRequest) => staffTx(req, (tx) => listingPortalFacts(tx, idOf(req)));
  const grantF = (req: FastifyRequest) => staffTx(req, (tx) => grantFacts(tx, idOf(req)));
  const itemF = (req: FastifyRequest) => staffTx(req, async (tx) => { const g = await itemGrant(tx, idOf(req)); return g ? scopeFacts(tx, g) : null; });
  const accountF = (req: FastifyRequest) => staffTx(req, (tx) => accountFacts(tx, idOf(req)));

  const channels = (req: FastifyRequest) => {
    const c = linkChannels(platformOf(req).config);
    return { ...c, text: linkChannelWords(c) };
  };

  for (const kind of ['deal', 'listing'] as const) {
    const facts = kind === 'deal' ? dealF : listingF;
    r.post(`/${kind}s/:id/portal/invite`, { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', facts), schema: { params: S.IdParams, body: S.InviteBody, response: { 200: S.InviteResponse } } }, async (req) =>
      invite(req, { kind, id: req.params.id }, req.body),
    );
    r.get(`/${kind}s/:id/portal`, { config: { auth: 'portal.view' }, preHandler: authorize('portal.view', facts), schema: { params: S.IdParams, response: { 200: S.PortalStateResponse } } }, async (req) => {
      const s = await staffTx(req, (tx) => scopeState(tx, { kind, id: req.params.id }));
      return { ...s, channels: channels(req) };
    });
  }

  r.get('/portal-grants/:id/preview', { config: { auth: 'portal.view' }, preHandler: authorize('portal.view', grantF), schema: { params: S.IdParams, response: { 200: S.PreviewResponse } } }, async (req) => {
    const p = await staffTx(req, (tx) => grantPreview(tx, req.params.id));
    if (!p) throw new AppError('NOT_FOUND');
    return p;
  });

  r.post('/portal-items/preview', { config: { auth: 'portal.view' }, preHandler: authorize('portal.view', (req) => staffTx(req, (tx) => grantFacts(tx, (req.body as { grantId: string }).grantId))), schema: { body: S.ItemPreviewBody, response: { 200: S.ItemPreviewResponse } } }, async (req) =>
    staffTx(req, (tx) => itemPreview(tx, req.body.grantId, req.body.kind, req.body.sourceId)),
  );

  r.post(
    '/portal-items',
    {
      config: { auth: 'portal.manage' },
      // any grant the person may manage authorizes the request; each grant is checked again on its own below
      preHandler: authorize('portal.manage', (req) => staffTx(req, async (tx) => {
        const gs = [];
        for (const id of (req.body as { grantIds: string[] }).grantIds) {
          const g = await grantById(tx, id);
          if (g) gs.push(g);
        }
        return mergedFacts(tx, gs);
      })),
      schema: { body: S.PublishBody, response: { 200: S.PublishResponse } },
    },
    async (req) => {
      const can = canFor(req);
      const results = await staffTx(req, (tx, actor) => publishBatch(tx, actor, req.body.kind, req.body.sourceId, req.body.grantIds, (f) => f !== null && can('portal.manage', f)));
      return { results };
    },
  );

  const ok = { 200: S.OkResponse };
  r.post('/portal-items/:id/retract', { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', itemF), schema: { params: S.IdParams, response: ok } }, async (req) => {
    await staffTx(req, (tx, actor) => retractItem(tx, actor, req.params.id));
    return { ok: true as const, text: null };
  });
  r.post('/portal-grants/:id/revoke', { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', grantF), schema: { params: S.IdParams, response: ok } }, async (req) => {
    await staffTx(req, (tx, actor) => revokeGrant(tx, actor, req.params.id));
    return { ok: true as const, text: null };
  });
  r.post('/portal-accounts/:id/disable', { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', accountF), schema: { params: S.IdParams, body: S.DisableBody, response: ok } }, async (req) => {
    await staffTx(req, (tx, actor) => disableAccount(tx, actor, req.params.id, req.body.reason));
    return { ok: true as const, text: null };
  });
  r.post('/portal-accounts/:id/login-point', { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', accountF), schema: { params: S.IdParams, body: S.LoginPointBody, response: ok } }, async (req) => {
    await staffTx(req, (tx, actor) => changeLoginPoint(tx, actor, req.params.id, req.body.pointId));
    return { ok: true as const, text: LOGIN_POINT_CHANGED };
  });
  r.patch('/portal-grants/:id/display', { config: { auth: 'portal.manage' }, preHandler: authorize('portal.manage', grantF), schema: { params: S.IdParams, body: S.DisplayBody, response: ok } }, async (req) => {
    await staffTx(req, (tx, actor) => setGrantTitle(tx, actor, req.params.id, req.body.title));
    return { ok: true as const, text: null };
  });
}
