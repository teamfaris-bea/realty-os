// bulk route module (parity module 63), mounted under /api by routes.ts:
//   POST /bulk-actions                 build a draft + its preview (frozen target)      bulk.run | bulk.text | bulk.assign (role gate)
//   GET  /bulk-actions                 the caller's recent actions (RLS)                bulk.run
//   GET  /bulk-actions/:id             one action with counts by reason                 bulk.run
//   POST /bulk-actions/:id/confirm     the creator confirms (same role) → bulk.run job  bulk.run
//   POST /bulk-actions/:id/cancel      the creator or Owner/Admin                       bulk.run
//   GET  /batch-text                   the switch and the counsel text                  settings.batch_text (Owner/Admin)
//   PUT  /batch-text                   on: Owner 🔒 + attestation; off: Owner/Admin     settings.batch_text
//
// The route gate is the role column of DATA_MODEL §12 (who may run bulk work at all); every PERSON is then
// decided by core bulkPreflight with can() on that person (own / collaborator / team), at draft and again
// at run time. TCs have no cell and get 404 (R-PERM-5).
import type { Action, UserActor } from '@realty/core/foundation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { attestationMatches, getBatchText, setBatchText } from './batchText.js';
import * as S from './schemas.js';
import { type BulkDeps, cancelAction, confirmAction, createDraft, getAction, listActions } from './service.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}

/** The role gate: a person-level grant held for SOME person (own) is what lets a role start bulk work. */
const anyOwn = () => ({ own: true });

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = (): BulkDeps => ({ db: app.platform.db, ids: app.platform.ids });
  const run = { config: { auth: 'bulk.run' as Action }, preHandler: authorize('bulk.run', anyOwn) };

  r.post('/bulk-actions', { ...run, schema: { body: S.CreateBody, response: { 201: S.ActionResponse } } }, async (req, reply) => {
    const actor = actorOf(req);
    const action = await createDraft(actor, req.body, deps());
    reply.status(201);
    return { action };
  });
  r.get('/bulk-actions', { ...run, schema: { response: { 200: S.ActionsResponse } } }, async (req) => ({ actions: await listActions(actorOf(req), deps()) }));
  r.get('/bulk-actions/:id', { ...run, schema: { params: IdParams, response: { 200: S.ActionResponse } } }, async (req) => ({ action: await getAction(actorOf(req), req.params.id, deps()) }));
  r.post('/bulk-actions/:id/confirm', { ...run, schema: { params: IdParams, response: { 200: S.ActionResponse } } }, async (req) => ({ action: await confirmAction(actorOf(req), req.params.id, deps()) }));
  r.post('/bulk-actions/:id/cancel', { ...run, schema: { params: IdParams, response: { 200: S.ActionResponse } } }, async (req) => ({ action: await cancelAction(actorOf(req), req.params.id, deps()) }));

  r.get('/batch-text', { config: { auth: 'settings.batch_text' }, preHandler: authorize('settings.batch_text', () => ({ loosening: false })), schema: { response: { 200: S.BatchTextResponse } } }, async (req) => ({
    batchText: await getBatchText(actorOf(req), app.platform.db),
  }));
  r.put('/batch-text', {
    config: { auth: 'settings.batch_text' },
    // turning it on is "loosening": Owner only, re-auth within 15 minutes and the typed attestation (can())
    preHandler: authorize('settings.batch_text', (req) => {
      const b = req.body as { enabled?: boolean; attestation?: string };
      return { loosening: b.enabled === true, attested: attestationMatches(b.attestation) };
    }),
    schema: { body: S.BatchTextBody, response: { 200: S.BatchTextResponse } },
  }, async (req) => ({ batchText: await setBatchText(actorOf(req), req.body.enabled, req.body.attestation, app.platform.db) }));
}

export const bulkRoutes: RouteModule = { name: 'bulk', register };
