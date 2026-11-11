// templates route module (parity module 63), mounted under /api by routes.ts:
//   GET   /templates                               team + own personal templates          template.personal
//   POST  /templates                               create (team: Owner/Admin)             template.personal / template.team_manage
//   GET   /templates/:id                           one template                           template.personal
//   PATCH /templates/:id                           edit (version-checked)                 template.personal (RLS + can())
//   POST  /templates/:id/archive                   archive                                template.personal (RLS + can())
//   POST  /templates/:id/copy                      copy to personal (Q-PAR-4)             template.personal
//   POST  /templates/:id/render {contactId}        render for one person (sender RLS)     contact.view_detail (on that person)
//   GET/PUT /email-signature                       the caller's plain-text signature      self
//
// Every route declares template.personal (all roles) and the service re-decides the scope: a team
// template write needs template.team_manage (Owner/Admin), and RLS hides other people's personal ones.
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { contactFacts } from '../comms/repos/contacts.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as S from './schemas.js';
import { type TemplateDeps, archiveTemplate, copyTemplate, createTemplate, getSignature, getTemplate, listTemplates, putSignature, renderForOne, updateTemplate } from './service.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = (): TemplateDeps => ({ db: app.platform.db, ids: app.platform.ids });
  const personal = { config: { auth: 'template.personal' as const }, preHandler: authorize('template.personal', () => ({})) };

  r.get('/templates', { ...personal, schema: { querystring: S.ListQuery, response: { 200: S.TemplatesResponse } } }, async (req) => ({
    templates: await listTemplates(actorOf(req), { channel: req.query.channel, includeArchived: req.query.includeArchived }, deps()),
  }));
  r.post('/templates', { ...personal, schema: { body: S.CreateBody, response: { 201: S.TemplateResponse } } }, async (req, reply) => {
    const t = await createTemplate(actorOf(req), req.body, deps());
    reply.status(201);
    return { template: t };
  });
  r.get('/templates/:id', { ...personal, schema: { params: IdParams, response: { 200: S.TemplateResponse } } }, async (req) => ({ template: await getTemplate(actorOf(req), req.params.id, deps()) }));
  r.patch('/templates/:id', { ...personal, schema: { params: IdParams, body: S.PatchBody, response: { 200: S.TemplateResponse } } }, async (req) => ({
    template: await updateTemplate(actorOf(req), req.params.id, req.body, deps()),
  }));
  r.post('/templates/:id/archive', { ...personal, schema: { params: IdParams, response: { 200: S.TemplateResponse } } }, async (req) => ({ template: await archiveTemplate(actorOf(req), req.params.id, deps()) }));
  r.post('/templates/:id/copy', { ...personal, schema: { params: IdParams, response: { 201: S.TemplateResponse } } }, async (req, reply) => {
    const t = await copyTemplate(actorOf(req), req.params.id, deps());
    reply.status(201);
    return { template: t };
  });

  r.post('/templates/:id/render', {
    config: { auth: 'contact.view_detail' },
    preHandler: authorize('contact.view_detail', (req) => withTenantTx(actorOf(req), (tx) => contactFacts(tx, (req.body as { contactId: string }).contactId), { db: req.server.platform.db })),
    schema: { params: IdParams, body: S.RenderBody, response: { 200: S.RenderResponse } },
  }, async (req) => ({ rendered: await renderForOne(actorOf(req), req.body.contactId, req.params.id, deps()) }));

  r.get('/email-signature', { config: { auth: 'self' }, schema: { response: { 200: S.SignatureResponse } } }, async (req) => getSignature(actorOf(req), deps()));
  r.put('/email-signature', { config: { auth: 'self' }, schema: { body: S.SignatureBody, response: { 200: S.SignatureResponse } } }, async (req) => putSignature(actorOf(req), req.body.signature, deps()));
}

export const templatesRoutes: RouteModule = { name: 'templates', register };
