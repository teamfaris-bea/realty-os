// api/cma routes, mounted under /api (module 71; R-CMA-6, R-PERM-5, R-TEN-1/3).
//
//   POST  /cma                    prepare a CMA (listing, contact address or entered subject)     cma.prepare
//   POST  /contacts/:id/cma       the one-tap CMA for a contact (F15)                              cma.prepare
//   GET   /contacts/:id/cmas      the contact's CMAs and its merged-away records'                  cma.prepare
//   GET   /cma/:id                one CMA, readiness computed now                                  cma.prepare
//   PATCH /cma/:id                edit a draft and re-run it                                       cma.prepare
//
// Authorization: cma.prepare (DATA_MODEL §8: ✅ | ✅ | T | O | — | — | —) on the contact's facts (own, collaborating,
// team), or `{own}` for the creator of a research CMA without a contact. A CMA of a merged-away record the caller no
// longer sees is authorized on the facts of the survivor they see, which lists it (R-CMA-8, batch 10 review
// db-public/F1): in practice its creator, whom 0061's cma_reports_select still shows the row. ISA and TC have none; support reads through RLS
// only (no route). A contact whose detail the caller cannot see, an invisible CMA, another tenant's id and every denial
// are 404 (R-PERM-5). Bodies are strict and carry no tenant id; the tenant is the session's (R-TEN-3).
//
// Limits (batch 10 review api-ui/F5): the three routes that run V1-B's engine synchronously (one soldCandidates read,
// then prepareCma with its back-test: about 300 ms for 2,000 candidates) count every authorized call against a
// per-person and a per-team limit (CMA_RUN_LIMITS; auth/rateLimit.ts, DB-backed fixed windows, as the Spark key and
// MMS upload routes do), beside the global per-session limit. Reading a stored CMA runs no engine and is not limited.
import type { ResourceFacts } from '@realty/core/foundation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Tx } from '@realty/db';
import { actorOf, adminTx, platformOf } from '../admin/common.js';
import { type Limit, enforceLimits } from '../auth/rateLimit.js';
import { personFacts } from '../lists/repos/catalog.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { getCma, survivorSeenByCaller } from './repos.js';
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
  if (row.contact_id === null) return { own: row.created_by_user_id === req.actor?.userId };
  const facts = await contactCmaFacts(tx, row.contact_id);
  if (facts !== null) return facts;
  // contacts RLS hides a closed, unowned merged-away record from its former agent: its CMA is reached through the
  // survivor the caller sees, as the survivor's list shows it (edits are refused CONTACT_MERGED in the service)
  const survivor = await survivorSeenByCaller(tx, row.contact_id);
  return survivor === null ? null : contactCmaFacts(tx, survivor);
}

/**
 * The engine routes' limits: 60 runs a minute per person (one a second, more than reviewing comps takes) and 300 per
 * team, so one scripted session cannot hold an API process's event loop (VERIFY under load).
 */
export const CMA_RUN_LIMITS = (tenantId: string, userId: string): Limit[] => [
  { kind: 'cma_run_user', parts: [tenantId, userId], max: 60, windowSeconds: 60 },
  { kind: 'cma_run_tenant', parts: [tenantId], max: 300, windowSeconds: 60 },
];

async function limitRuns(req: FastifyRequest): Promise<void> {
  const p = platformOf(req);
  const a = actorOf(req);
  await enforceLimits(p.db, p.config.sessionSecret, CMA_RUN_LIMITS(a.tenantId, a.userId), p.cmaLimitClock);
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
    await limitRuns(req);
    const cma = await adminTx(req, (tx, now, actor) => prepare(tx, actor, now, req.body));
    return reply.code(201).send({ cma });
  });

  r.post('/contacts/:id/cma', { config: auth, preHandler: onContact, bodyLimit: 16 * 1024, schema: { params: IdParams, body: OneTapBody.optional(), response: { 200: CmaResponse, 201: CmaResponse } } }, async (req, reply) => {
    await limitRuns(req);
    const x = await adminTx(req, (tx, now, actor) => oneTap(tx, actor, now, req.params.id, req.body ?? {}));
    return reply.code(x.created ? 201 : 200).send({ cma: x.view });
  });

  r.get('/contacts/:id/cmas', { config: auth, preHandler: onContact, schema: { params: IdParams, response: { 200: CmaListResponse } } }, async (req) => ({
    cmas: await adminTx(req, (tx, _now, actor) => listForContact(tx, actor, req.params.id)),
  }));

  r.get('/cma/:id', { config: auth, preHandler: onCma, schema: { params: IdParams, response: { 200: CmaResponse } } }, async (req) => ({
    cma: await adminTx(req, (tx, now, actor) => getView(tx, actor, now, req.params.id)),
  }));

  r.patch('/cma/:id', { config: auth, preHandler: onCma, bodyLimit: 64 * 1024, schema: { params: IdParams, body: PatchBody, response: { 200: CmaResponse } } }, async (req) => {
    await limitRuns(req);
    return { cma: await adminTx(req, (tx, now, actor) => patch(tx, actor, now, req.params.id, req.body)) };
  });
}

export const cmaRoutes: RouteModule = { name: 'cma', register };
