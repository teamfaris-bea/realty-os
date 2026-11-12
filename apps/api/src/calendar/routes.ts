// api/calendar routes (PHASE2_3_PLAN §5.4 #34). Mounted under /api. Every route is 'self': it acts only on the
// signed-in person's own calendar, and no input names another person, a tenant, a token or a status (R-CAL-1,
// R-TEN-3). Responses carry no token, no scope list, no calendar id and no event content.
//
//   GET  /me/calendar                          the person's links in words, what syncs, detached appointments
//   POST /me/calendar/:provider/connect        OAuth start (minimal scopes, PKCE, signed state)
//   GET  /me/calendar/:provider/callback       provider redirect; the same signed-in person finishes it
//   POST /me/calendar/:provider/disconnect     revoke + purge (R-INT-5), then revoke at the provider
//   GET  /me/busy?from&to                      live free/busy (R-CAL-3), never stored
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { withTenantTx } from '@realty/db';
import { z } from 'zod';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { actorOf, platformOf } from '../workspace/common.js';
import { CALENDAR_PROVIDER_KEYS } from './catalog.js';
import { type CalendarDeps, busy, calendarView, connectCallback, disconnect, startConnect } from './service.js';

const LinkStateEnum = z.enum(['connected', 'pending', 'degraded', 'needs_reconnect', 'not_connected', 'not_configured']);
export const CalendarViewResponse = z.object({
  adapterMode: z.enum(['fake', 'unconfigured', 'real']),
  syncSentence: z.string(),
  privacySentence: z.string(),
  providers: z.array(
    z.object({
      provider: z.enum(CALENDAR_PROVIDER_KEYS),
      name: z.string(),
      state: LinkStateEnum,
      sentence: z.string(),
      canConnect: z.boolean(),
      canDisconnect: z.boolean(),
      blockedSentence: z.string().nullable(),
      lastSyncedAt: z.string().nullable(),
    }),
  ),
  detached: z.array(z.object({ appointmentId: z.uuid(), kind: z.string(), startsAt: z.string(), sentence: z.string() })),
});
export const ConnectStartResponse = z.object({ authorizeUrl: z.string(), expiresAt: z.string() });
export const BusyResponse = z.object({
  calendar: z.enum(['connected', 'degraded', 'needs_reconnect', 'not_connected', 'not_configured', 'unavailable']),
  provider: z.enum(CALENDAR_PROVIDER_KEYS).nullable(),
  sentence: z.string(),
  busy: z.array(z.object({ start: z.string(), end: z.string() })),
});

const ProviderParams = z.object({ provider: z.enum(CALENDAR_PROVIDER_KEYS) }).strict();
/** nothing may name another person, a token or a status (R-CAL-1) */
const EmptyBody = z.strictObject({}).optional();
const BusyQuery = z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });

export function calendarDeps(p: Platform): CalendarDeps {
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
  const self = { config: { auth: 'self' as const } };

  r.get('/me/calendar', { ...self, schema: { response: { 200: CalendarViewResponse } } }, async (req) => {
    const actor = actorOf(req);
    const p = platformOf(req);
    return withTenantTx(actor, (tx) => calendarView(tx, actor, p.providers.integrations), { db: p.db, retries: 2 });
  });

  r.post('/me/calendar/:provider/connect', { ...self, schema: { params: ProviderParams, body: EmptyBody, response: { 201: ConnectStartResponse } } }, async (req, reply) => {
    const actor = actorOf(req);
    const deps = calendarDeps(platformOf(req));
    const out = await withTenantTx(actor, (tx) => startConnect(deps, tx, actor, req.params.provider), { db: deps.db, retries: 2 });
    reply.status(201);
    return out;
  });

  r.get(
    '/me/calendar/:provider/callback',
    {
      ...self,
      schema: {
        params: z.object({ provider: z.string().max(40) }).strict(),
        querystring: z.object({ state: z.string().max(4096).optional(), code: z.string().max(4096).optional(), error: z.string().max(200).optional(), error_description: z.string().max(2000).optional(), scope: z.string().max(4096).optional() }),
      },
    },
    async (req, reply) => {
      const res = await connectCallback(calendarDeps(platformOf(req)), actorOf(req), req.params.provider, req.query);
      req.log.info({ outcome: res.outcome }, 'calendar oauth callback');
      return reply.redirect(res.location, 303);
    },
  );

  r.post('/me/calendar/:provider/disconnect', { ...self, schema: { params: ProviderParams, body: EmptyBody, response: { 200: CalendarViewResponse } } }, async (req) => {
    const actor = actorOf(req);
    const deps = calendarDeps(platformOf(req));
    await disconnect(deps, actor, req.params.provider);
    return withTenantTx(actor, (tx) => calendarView(tx, actor, deps.adapters), { db: deps.db, retries: 2 });
  });

  r.get('/me/busy', { ...self, schema: { querystring: BusyQuery, response: { 200: BusyResponse } } }, async (req) => busy(calendarDeps(platformOf(req)), actorOf(req), req.query));
}

export const calendarRoutes: RouteModule = { name: 'calendar', register };
