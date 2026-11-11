// Integrations admin API (PHASE2_3_PLAN §5.4 #21; DATA_MODEL §8 first two rows). Mounted under /api.
//
//   GET   /admin/integrations                              every service, honest sentences, packs   integration.view (Owner/Admin)
//   POST  /admin/integrations/:kind/connect                OAuth start (PKCE + signed state)         integration.manage (Owner/Admin 🔒)
//   GET   /admin/integrations/:kind/callback               provider redirect; system actor           public (the signed state is the authority)
//   PATCH /admin/integrations/connections/:id              rename, lead source                       integration.manage 🔒
//   POST  /admin/integrations/connections/:id/disconnect   disconnect + revoke (R-INT-5)             integration.manage 🔒
//
// Request schemas are strict and never accept a tenant id, status, account link or capability: those are
// the provider callback's to write (R-INT-3). Response schemas carry no tenant id and no confidence field.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminTx, platformOf } from '../admin/common.js';
import { CONNECTION_KINDS } from '../providers/integrations/types.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import * as repo from './repos/connections.js';
import { type IntegrationDeps, connectionView, disconnect, listIntegrations, oauthCallback, startConnect, updateConnection } from './service.js';

const Label = z.string().trim().min(1).max(120);
const AccountId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const Capability = z.object({ name: z.string(), available: z.boolean(), reason: z.string().nullable() });
export const ConnectionResponse = z.object({
  id: z.uuid(),
  kind: z.enum(CONNECTION_KINDS),
  displayName: z.string(),
  status: z.string(),
  statusSentence: z.string(),
  externalAccountId: z.string().nullable(),
  leadSourceId: z.uuid().nullable(),
  capabilities: z.array(Capability),
  lastErrorCode: z.string().nullable(),
  connectedAt: z.string().nullable(),
  disconnectedAt: z.string().nullable(),
});
export const IntegrationsResponse = z.object({
  adapterMode: z.enum(['fake', 'unconfigured', 'real']),
  services: z.array(
    z.object({ kind: z.enum(CONNECTION_KINDS), name: z.string(), connect: z.string(), canConnect: z.boolean(), sentence: z.string(), connections: z.array(ConnectionResponse) }),
  ),
  platformPacks: z.array(z.object({ key: z.string(), version: z.string(), reviewed: z.boolean(), sentence: z.string() })),
});
export const ConnectStartResponse = z.object({ connectionId: z.uuid(), authorizeUrl: z.string(), expiresAt: z.string() });

const ConnectBody = z
  .object({ connectionId: z.uuid().optional(), displayName: Label.optional(), externalAccountId: AccountId, leadSourceId: z.uuid().optional() })
  .strict();
const PatchBody = z.object({ displayName: Label.optional(), leadSourceId: z.uuid().nullable().optional() }).strict();

export function integrationDeps(p: Platform): IntegrationDeps {
  return {
    db: p.db,
    envelope: p.envelope,
    ids: p.ids,
    adapters: p.providers.integrations,
    secret: p.config.sessionSecret,
    publicBaseUrl: p.config.publicBaseUrl,
    webOrigin: p.config.webOrigins[0]!,
    now: () => p.clock.now(),
  };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };

  r.get('/admin/integrations', { ...view, schema: { response: { 200: IntegrationsResponse } } }, async (req) =>
    adminTx(req, (tx) => listIntegrations(tx, platformOf(req).providers.integrations)),
  );

  r.post(
    '/admin/integrations/:kind/connect',
    { ...manage, schema: { params: z.object({ kind: z.string().max(40) }).strict(), body: ConnectBody, response: { 201: ConnectStartResponse } } },
    async (req, reply) => {
      const deps = integrationDeps(platformOf(req));
      const out = await adminTx(req, (tx, _now, actor) => startConnect(deps, tx, actor, { kind: req.params.kind, ...req.body }));
      reply.status(201);
      return out;
    },
  );

  r.get(
    '/admin/integrations/:kind/callback',
    {
      config: { auth: 'public' },
      schema: {
        params: z.object({ kind: z.string().max(40) }).strict(),
        querystring: z.object({ state: z.string().max(4096).optional(), code: z.string().max(4096).optional(), error: z.string().max(200).optional(), error_description: z.string().max(2000).optional() }),
      },
    },
    async (req, reply) => {
      const res = await oauthCallback(integrationDeps(platformOf(req)), req.params.kind, req.query);
      req.log.info({ outcome: res.outcome }, 'integration oauth callback');
      return reply.redirect(res.location, 303);
    },
  );

  r.patch(
    '/admin/integrations/connections/:id',
    { ...manage, schema: { params: z.object({ id: z.uuid() }).strict(), body: PatchBody, response: { 200: z.object({ connection: ConnectionResponse }) } } },
    async (req) =>
      adminTx(req, async (tx, _now, actor) => {
        const row = await updateConnection(tx, actor, req.params.id, req.body);
        return { connection: connectionView(row, await packs(tx)) };
      }),
  );

  r.post(
    '/admin/integrations/connections/:id/disconnect',
    { ...manage, schema: { params: z.object({ id: z.uuid() }).strict(), response: { 200: z.object({ connection: ConnectionResponse }) } } },
    async (req) =>
      adminTx(req, async (tx, now, actor) => {
        const row = await disconnect(tx, actor, req.params.id, now);
        return { connection: connectionView(row, await packs(tx)) };
      }),
  );
}

async function packs(tx: Parameters<typeof repo.listPlatformPacks>[0]) {
  return (await repo.listPlatformPacks(tx)).map((p) => ({ key: p.key, version: p.version, reviewedByCounselAt: p.reviewed_by_counsel_at ? p.reviewed_by_counsel_at.toISOString() : null }));
}

export const integrationsRoutes: RouteModule = { name: 'integrations', register };
