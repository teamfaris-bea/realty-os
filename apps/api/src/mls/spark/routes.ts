// Spark MLS (read-only) admin API, mounted under /api (docs/DEPLOY.md "Spark MLS (read-only)").
//
//   GET  /admin/integrations/mls/spark              settings and the connection in words      integration.view (Owner/Admin)
//   PUT  /admin/integrations/mls/spark/credential   save the CRM's own Spark key              integration.manage (Owner/Admin 🔒)
//   POST /admin/integrations/mls/spark/validate     the single read-only probe                integration.manage 🔒
//   (disconnect: POST /admin/integrations/connections/:id/disconnect revokes and purges the key)
//
// The CSRF token and the Origin check are the global guard's (non-GET); re-auth comes from integration.manage;
// the DB-backed limits below add to the global request budget. No response schema has a token field, so
// fast-json-stringify could not serialize one even by mistake. The token is not logged: request bodies are
// never logged (server.ts), and a validation error carries field paths and codes only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, adminTx, platformOf } from '../../admin/common.js';
import { enforceLimits } from '../../auth/rateLimit.js';
import { authorize } from '../../rbac.js';
import type { RouteModule } from '../../routes.js';
import type { Platform } from '../../server.js';
import { type SparkDeps, VALIDATION_RESULTS, saveSparkCredential, sparkView, validateSpark } from './service.js';

/** printable ASCII, no spaces (it goes into one header line) */
export const AccessToken = z.string().regex(/^[\x21-\x7e]{16,4096}$/);
/** a short nonsecret name for the key (no control characters) */
const KeyLabel = z.string().trim().min(1).max(80).refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f));
const Scheme = z.enum(['Bearer', 'OAuth']);

const ConnectionView = z.object({
  id: z.uuid(),
  status: z.string(),
  statusSentence: z.string(),
  keyLabel: z.string().nullable(),
  credentialSaved: z.boolean(),
  lastResult: z.string().nullable(),
  connectedAt: z.string().nullable(),
});
export const SparkViewResponse = z.object({ provider: z.enum(['fake', 'spark']), liveCalls: z.boolean(), sentence: z.string(), authSchemeDefault: Scheme, connection: ConnectionView.nullable() });
export const SaveBody = z.object({ accessToken: AccessToken, keyLabel: KeyLabel, authScheme: Scheme.optional() }).strict();
export const ValidateResponse = z.object({
  result: z.enum(VALIDATION_RESULTS as [string, ...string[]]),
  connection: ConnectionView,
});

export function sparkDeps(p: Platform): SparkDeps {
  return { db: p.db, envelope: p.envelope, ids: p.ids, mls: p.config.mls, adapters: p.providers.integrations, now: () => p.clock.now() };
}

async function limit(req: FastifyRequest, kind: 'mls_key_write' | 'mls_validate'): Promise<void> {
  const p = platformOf(req);
  const a = actorOf(req);
  const max = kind === 'mls_key_write' ? 10 : 30;
  await enforceLimits(p.db, p.config.sessionSecret, [
    { kind, parts: [a.tenantId, a.userId], max, windowSeconds: 3600 },
    { kind: `${kind}_tenant`, parts: [a.tenantId], max: max * 3, windowSeconds: 3600 },
  ]);
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };

  r.get('/admin/integrations/mls/spark', { ...view, schema: { response: { 200: SparkViewResponse } } }, async (req) => adminTx(req, (tx) => sparkView(tx, platformOf(req).config.mls)));

  r.put('/admin/integrations/mls/spark/credential', { ...manage, bodyLimit: 16 * 1024, schema: { body: SaveBody, response: { 200: z.object({ connection: ConnectionView }) } } }, async (req) => {
    await limit(req, 'mls_key_write');
    const connection = await saveSparkCredential(sparkDeps(platformOf(req)), actorOf(req), req.body);
    return { connection };
  });

  r.post('/admin/integrations/mls/spark/validate', { ...manage, schema: { response: { 200: ValidateResponse } } }, async (req) => {
    await limit(req, 'mls_validate');
    return validateSpark(sparkDeps(platformOf(req)), actorOf(req));
  });
}

export const sparkMlsRoutes: RouteModule = { name: 'mls-spark', register };
