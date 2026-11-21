// CRM read API (WP3a). Mounted under /api.
//
//   POST /crm-read/tokens            crm_read.manage   Owner, re-authenticated. The secret is returned once.
//   GET  /crm-read/tokens            crm_read.manage   id, name, prefix, timestamps. Never the secret.
//   POST /crm-read/tokens/:id/revoke crm_read.manage   revocation is final.
//
//   GET /crm/v1/people[/:id]
//   GET /crm/v1/events[/:id]         calls, texts, emails, notes, appointments
//   GET /crm/v1/deals[/:id]
//   GET /crm/v1/users[/:id]
//   GET /crm/v1/stages
//
// The /crm/v1 routes take a bearer token and nothing else. They have no write method.
import type { UserActor } from '@realty/core/foundation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as S from './schemas.js';
import { createReadToken, listReadTokens, readDeal, readDeals, readEvent, readEvents, readPeople, readPerson, readStages, readUser, readUsers, revokeReadToken } from './service.js';

function actorOf(req: FastifyRequest): UserActor {
  const actor = req.actor;
  if (!actor || actor.kind !== 'user') throw new AppError('UNAUTHENTICATED');
  return actor;
}

function scopeOf(req: FastifyRequest) {
  const scope = req.crmRead;
  if (!scope) throw new AppError('UNAUTHENTICATED');
  return scope;
}

const manage = { auth: 'crm_read.manage' as const };
const read = { auth: 'crm_read' as const };

export async function registerCrmReadRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/crm-read/tokens', { config: manage, preHandler: authorize('crm_read.manage', () => ({})), schema: { body: S.CreateTokenBody, response: { 201: S.CreatedToken } } }, async (req, reply) => {
    const p = req.server.platform;
    const created = await createReadToken(actorOf(req), p.db, p.ids, req.body.name);
    return reply.status(201).send(created);
  });

  r.get('/crm-read/tokens', { config: manage, preHandler: authorize('crm_read.manage', () => ({})), schema: { response: { 200: S.TokenList } } }, async (req) => {
    return listReadTokens(actorOf(req), req.server.platform.db);
  });

  r.post('/crm-read/tokens/:id/revoke', { config: manage, preHandler: authorize('crm_read.manage', () => ({})), schema: { params: S.TokenParams, response: { 200: S.TokenSummary } } }, async (req) => {
    return revokeReadToken(actorOf(req), req.server.platform.db, req.params.id);
  });

  r.get('/crm/v1/people', { config: read, schema: { querystring: S.PageQuery, response: { 200: S.PeoplePage } } }, async (req) => {
    return readPeople(req.server.platform.db, scopeOf(req), req.query);
  });
  r.get('/crm/v1/people/:id', { config: read, schema: { params: S.IdParams, response: { 200: S.Person } } }, async (req) => {
    const person = await readPerson(req.server.platform.db, scopeOf(req), req.params.id);
    if (!person) throw new AppError('NOT_FOUND');
    return person;
  });

  r.get('/crm/v1/events', { config: read, schema: { querystring: S.EventQuery, response: { 200: S.EventsPage } } }, async (req) => {
    return readEvents(req.server.platform.db, scopeOf(req), req.query);
  });
  r.get('/crm/v1/events/:id', { config: read, schema: { params: S.EventIdParams, response: { 200: S.Activity } } }, async (req) => {
    const event = await readEvent(req.server.platform.db, scopeOf(req), req.params.id);
    if (!event) throw new AppError('NOT_FOUND');
    return event;
  });

  r.get('/crm/v1/deals', { config: read, schema: { querystring: S.PageQuery, response: { 200: S.DealsPage } } }, async (req) => {
    return readDeals(req.server.platform.db, scopeOf(req), req.query);
  });
  r.get('/crm/v1/deals/:id', { config: read, schema: { params: S.IdParams, response: { 200: S.Deal } } }, async (req) => {
    const deal = await readDeal(req.server.platform.db, scopeOf(req), req.params.id);
    if (!deal) throw new AppError('NOT_FOUND');
    return deal;
  });

  r.get('/crm/v1/users', { config: read, schema: { querystring: S.PageQuery, response: { 200: S.UsersPage } } }, async (req) => {
    return readUsers(req.server.platform.db, scopeOf(req), req.query);
  });
  r.get('/crm/v1/users/:id', { config: read, schema: { params: S.IdParams, response: { 200: S.Agent } } }, async (req) => {
    const user = await readUser(req.server.platform.db, scopeOf(req), req.params.id);
    if (!user) throw new AppError('NOT_FOUND');
    return user;
  });

  r.get('/crm/v1/stages', { config: read, schema: { querystring: S.StageQuery, response: { 200: S.StagesPage } } }, async (req) => {
    return readStages(req.server.platform.db, scopeOf(req), { limit: 100, ...req.query });
  });
}

export const crmReadRoutes: RouteModule = {
  name: 'crmRead',
  register: registerCrmReadRoutes,
};
