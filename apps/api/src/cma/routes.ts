// api/cma routes, mounted under /api (module 71; R-CMA-6, R-PERM-5, R-TEN-1/3).
//
//   POST  /cma                    prepare a CMA (listing, contact address or entered subject)     cma.prepare
//   POST  /contacts/:id/cma       the one-tap CMA for a contact (F15)                              cma.prepare
//   GET   /contacts/:id/cmas      the contact's CMAs and its merged-away records'                  cma.prepare
//   GET   /cma/:id                one CMA, readiness computed now                                  cma.prepare
//   PATCH /cma/:id                edit a draft and re-run it                                       cma.prepare
//
// Authorization: cma.prepare (DATA_MODEL §8: ✅ | ✅ | T | O | — | — | —) on the contact's facts (own, collaborating,
// team), or `{own}` for the creator of a research CMA without a contact. ISA and TC have none; support reads through RLS
// only (no route). A contact whose detail the caller cannot see, an invisible CMA, another tenant's id and every denial
// are 404 (R-PERM-5). Bodies are strict and carry no tenant id; the tenant is the session's (R-TEN-3).
import type { ResourceFacts } from '@realty/core/foundation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Tx } from '@realty/db';
import { adminTx } from '../admin/common.js';
import { mergedIntoRoot } from '../admin/repos/erasure.js';
import { personFacts } from '../lists/repos/catalog.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { getCma } from './repos.js';
import { CmaListResponse, CmaResponse, IdParams, OneTapBody, PatchBody, PrepareBody } from './schemas.js';
import { getView, listForContact, oneTap, patch, prepare } from './service.js';

/** The caller's relation to a contact whose detail they see (null: invisible, R-PERM-5). */
export async function contactCmaFacts(tx: Tx, contactId: string): Promise<ResourceFacts | null> {
  const f = await personFacts(tx, contactId);
  if (!f || !f.detail_visible) return null;
  return { own: f.rel_own, collaborator: f.rel_collab, team: f.rel_team };
}

async function cmaFacts(tx: Tx, req: FastifyRequest, id: string): Promise<ResourceFacts | null> {
  const row = await getCma(tx, id);
  if (!row) return null;
  if (row.contact_id !== null) {
    // b11 ownership-data/F1 (0077): a merged-away record's CMA is read through the record its merge chain ends at, which
    // the survivor's agent and Team Lead see (contacts RLS hides the merged-away record itself from them)
    const own = await contactCmaFacts(tx, row.contact_id);
    if (own) return own;
    const root = await mergedIntoRoot(tx, row.contact_id);
    return root ? contactCmaFacts(tx, root) : null;
  }
  return { own: row.created_by_user_id === req.actor?.userId };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { auth: 'cma.prepare' as const };
  const onContact = authorize('cma.prepare', (req) => adminTx(req, (tx) => contactCmaFacts(tx, (req.params as { id: string }).id)));
  const onCma = authorize('cma.prepare', (req) => adminTx(req, (tx) => cmaFacts(tx, req, (req.params as { id: string }).id)));
  const onBody = authorize('cma.prepare', (req) => {
    const b = req.body as { contactId?: string } | undefined;
    return b?.contactId ? adminTx(req, (tx) => contactCmaFacts(tx, b.contactId!)) : { own: true };
  });

  r.post('/cma', { config: auth, preHandler: onBody, bodyLimit: 64 * 1024, schema: { body: PrepareBody, response: { 201: CmaResponse } } }, async (req, reply) => {
    const cma = await adminTx(req, (tx, now, actor) => prepare(tx, actor, now, req.body));
    return reply.code(201).send({ cma });
  });

  r.post('/contacts/:id/cma', { config: auth, preHandler: onContact, bodyLimit: 16 * 1024, schema: { params: IdParams, body: OneTapBody.optional(), response: { 200: CmaResponse, 201: CmaResponse } } }, async (req, reply) => {
    const x = await adminTx(req, (tx, now, actor) => oneTap(tx, actor, now, req.params.id, req.body ?? {}));
    return reply.code(x.created ? 201 : 200).send({ cma: x.view });
  });

  r.get('/contacts/:id/cmas', { config: auth, preHandler: onContact, schema: { params: IdParams, response: { 200: CmaListResponse } } }, async (req) => ({
    cmas: await adminTx(req, (tx, _now, actor) => listForContact(tx, actor, req.params.id)),
  }));

  r.get('/cma/:id', { config: auth, preHandler: onCma, schema: { params: IdParams, response: { 200: CmaResponse } } }, async (req) => ({
    cma: await adminTx(req, (tx, now, actor) => getView(tx, actor, now, req.params.id)),
  }));

  r.patch('/cma/:id', { config: auth, preHandler: onCma, bodyLimit: 64 * 1024, schema: { params: IdParams, body: PatchBody, response: { 200: CmaResponse } } }, async (req) => ({
    cma: await adminTx(req, (tx, now, actor) => patch(tx, actor, now, req.params.id, req.body)),
  }));
}

export const cmaRoutes: RouteModule = { name: 'cma', register };
