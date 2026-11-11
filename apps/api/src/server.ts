// The Fastify server (BUILD_PLAN module 8; ARCHITECTURE §3 request lifecycle).
//
//   const app = buildServer(config, { providers, clock, ids });
//   await app.listen({ port: config.apiPort });
//
// Request lifecycle:
//   1. request id (UUIDv7 from the injected generator; client-supplied ids are ignored)
//   2. request context (AsyncLocalStorage: request id, ip, user agent) for audit()
//   3. Origin allowlist on every unsafe method except signed webhooks (CSRF_INVALID)
//   4. global rate limit per live session, else per IP (auth routes add DB-backed limits)
//   5. route guard from config.auth (rbac.ts), in preValidation, i.e. BEFORE input validation:
//      webhook signature | session (+CSRF token, MFA) | actor
//   6. Zod input validation (422), then authorize(action, facts) → core.can (404 on deny/invisible,
//      401 on stale re-auth)
//   7. handler → withTenantTx(actor, …) with audit rows in the same transaction
//   8. errors → { error: { code, requestId, details? } }, never PII, SQL or stacks
//
// Logs carry ids, codes and timings only: every log object goes through redactForLog (drops PII
// keys, masks emails and phone numbers in strings), and request logs show the route pattern, not the
// raw URL.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Clock, IdGenerator } from '@realty/core/foundation';
import { type Database, getDatabase } from '@realty/db';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type preValidationHookHandler } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { maskPii, redactForLog, requestContext } from './audit.js';
import { loadAuthState, requireActor, requireSession, sessionToken } from './auth/guard.js';
import { dummyHash } from './auth/password.js';
import type { Config } from './config.js';
import { EnvelopeService } from './crypto/envelope.js';
import { localKek } from './crypto/kek.js';
import { AppError, type ErrorCode, errorBody } from './errors.js';
import type { Providers } from './providers/index.js';
import { webhookGuard } from './providers/webhooks.js';
import { type ErrorReporter, MemoryErrorReporter } from './observability/errors.js';
import { instrumentHttp } from './observability/metrics.js';
import type { Registry } from './observability/prometheus.js';
import { type RouteTableEntry, securedPreHandlers } from './rbac.js';
import { type RouteModule, routeModules as defaultRouteModules } from './routes.js';

/** What every route and guard reaches through `req.server.platform`. */
export interface Platform {
  config: Config;
  db: Database;
  ids: IdGenerator;
  clock: Clock;
  providers: Providers;
  envelope: EnvelopeService;
  /** every registered route and its authorization declaration (filled as routes register) */
  routeTable: RouteTableEntry[];
  /** unexpected errors go here (observability/errors.ts; scrubbed, tagged with the request id) */
  errorReporter: ErrorReporter;
}

declare module 'fastify' {
  interface FastifyInstance {
    platform: Platform;
  }
}

export interface ServerDeps {
  providers: Providers;
  clock: Clock;
  ids: IdGenerator;
  /** database handle (default: the process-wide one from DATABASE_URL) */
  db?: Database;
  /** route modules to mount under /api (default: routes.ts registry) */
  routeModules?: readonly RouteModule[];
  /** pino destination (tests capture logs here) */
  logStream?: { write(line: string): void };
  envelope?: EnvelopeService;
  /** Prometheus registry for request metrics (observability; default: none) */
  metrics?: Registry;
  /** error reporting adapter (default: the in-memory fake) */
  errorReporter?: ErrorReporter;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(req: FastifyRequest): string | null {
  const o = req.headers.origin;
  if (typeof o === 'string' && o !== 'null') return o;
  const ref = req.headers.referer;
  if (typeof ref === 'string') {
    try {
      return new URL(ref).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * JSON bodies: prototype keys dropped, and a NUL (U+0000) anywhere is a bad body. Postgres text and jsonb
 * refuse NUL, so it used to reach the database and come back as a 500 (security review).
 */
function safeJsonParse(body: string): unknown {
  return JSON.parse(body, (k, v: unknown) => {
    if (k.includes('\u0000') || (typeof v === 'string' && v.includes('\u0000'))) throw new SyntaxError('NUL in body');
    return k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v;
  });
}

function badBody(): FastifyError {
  return Object.assign(new Error('invalid body'), { statusCode: 400, code: 'REALTY_INVALID_BODY' }) as FastifyError;
}

function sendError(reply: FastifyReply, req: FastifyRequest, code: ErrorCode, status: number, details?: Record<string, unknown>) {
  req.errorCode = code;
  if (code === 'RATE_LIMITED' && typeof details?.retryAfterSeconds === 'number') reply.header('retry-after', String(details.retryAfterSeconds));
  return reply.status(status).send(errorBody(code, String(req.id), details));
}

export function buildServer(cfg: Config, deps: ServerDeps): FastifyInstance {
  const db = deps.db ?? getDatabase();
  const platform: Platform = {
    config: cfg,
    db,
    ids: deps.ids,
    clock: deps.clock,
    providers: deps.providers,
    envelope: deps.envelope ?? new EnvelopeService(localKek(cfg.kek, cfg.kekRef)),
    routeTable: [],
    errorReporter: deps.errorReporter ?? new MemoryErrorReporter(),
  };

  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // defense in depth (the req/res serializers below already emit no headers): credentials in request or
      // response headers, including the X-Api-Key a provider echoes (Spark, docs/SECURITY.md §5.3), are censored
      redact: { paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'res.headers.authorization', 'res.headers["x-api-key"]', 'headers.authorization', 'headers["x-api-key"]'], censor: '[redacted]' },
      // pino runs formatters.log BEFORE the serializers: req/res/err are left to the serializers below
      // (which emit only method, route pattern, status and masked error text); everything else is redacted.
      formatters: {
        log: (o: Record<string, unknown>) => {
          const { req, res, err, ...rest } = o;
          return { ...(redactForLog(rest) as Record<string, unknown>), ...(req !== undefined ? { req } : {}), ...(res !== undefined ? { res } : {}), ...(err !== undefined ? { err } : {}) };
        },
      },
      hooks: {
        logMethod(args, method) {
          method.apply(
            this,
            args.map((a) => (typeof a === 'string' ? maskPii(a) : a)) as Parameters<typeof method>,
          );
        },
      },
      serializers: {
        req: (r: { method: string; routeOptions?: { url?: string } }) => ({ method: r.method, route: r.routeOptions?.url ?? '[unmatched]' }),
        res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
        err: (e: FastifyError) => ({ type: e.name, message: maskPii(e.message), stack: maskPii(e.stack ?? ''), code: e.code }),
      },
    },
    genReqId: () => deps.ids.next<'RequestId'>(),
    requestIdHeader: false,
    trustProxy: cfg.trustProxy,
    bodyLimit: 1_048_576,
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.decorate('platform', platform);
  if (deps.metrics) instrumentHttp(app, deps.metrics);
  const report = (err: unknown, req: FastifyRequest, code: string) =>
    platform.errorReporter.capture(err, { requestId: String(req.id), route: req.routeOptions?.url ?? 'unmatched', method: req.method, status: 500, code, process: 'api' });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Raw body kept for signed webhooks; prototype keys dropped.
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const s = body as string;
    req.rawBody = s;
    if (s.trim() === '') return done(null, undefined);
    try {
      done(null, safeJsonParse(s));
    } catch {
      done(badBody(), undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const s = body as string;
    req.rawBody = s;
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(s)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = v;
    done(null, out);
  });

  // Request context for audit() (AsyncLocalStorage.run keeps it for the whole hook chain).
  app.addHook('onRequest', (req, _reply, done) => {
    const ua = req.headers['user-agent'];
    requestContext.run({ requestId: String(req.id), ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null, ids: deps.ids }, done);
  });

  // Origin allowlist (CSRF layer 1) for every unsafe method except provider webhooks and capability
  // URLs (public routes whose only authority is a signed token in the URL; see rbac.ts).
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.routeOptions.config?.auth === 'webhook') return;
    if (req.routeOptions.config?.auth === 'public' && req.routeOptions.config?.capabilityUrl === true) return;
    const origin = originOf(req);
    if (origin === null || !cfg.webOrigins.includes(origin)) throw new AppError('CSRF_INVALID');
  });

  // API responses carry session state (CSRF token), PII and tenant data: never cached by browsers or
  // shared proxies. A route that sets its own Cache-Control keeps it.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) {
        req.log.error({ code: err.code }, 'request failed');
        report(err, req, err.code);
      }
      return sendError(reply, req, err.code, err.status, err.details);
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.slice(0, 20).map((v) => ({ path: v.instancePath || '/', code: (v.params as { issue?: { code?: string } })?.issue?.code ?? v.keyword }));
      return sendError(reply, req, 'VALIDATION_FAILED', 422, { issues });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ code: 'RESPONSE_SERIALIZATION' }, 'response did not match its schema');
      report(err, req, 'RESPONSE_SERIALIZATION');
      return sendError(reply, req, 'INTERNAL_ERROR', 500);
    }
    if (err.statusCode === 429) return sendError(reply, req, 'RATE_LIMITED', 429);
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(reply, req, 'PAYLOAD_TOO_LARGE', 413);
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return sendError(reply, req, 'UNSUPPORTED_MEDIA_TYPE', 415);
    if (err.code === 'REALTY_INVALID_BODY' || err.code?.startsWith('FST_ERR_CTP_') || err.code === 'FST_ERR_VALIDATION') {
      return sendError(reply, req, 'VALIDATION_FAILED', 422);
    }
    req.log.error({ err, code: (err as { code?: string }).code ?? 'UNEXPECTED' }, 'unhandled error');
    report(err, req, 'INTERNAL_ERROR');
    return sendError(reply, req, 'INTERNAL_ERROR', 500);
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, req, 'NOT_FOUND', 404));

  app.register(cookie);
  app.register(helmet, { global: true, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  app.register(cors, { origin: cfg.webOrigins, credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'x-csrf-token'] });
  app.register(rateLimit, {
    global: true,
    max: cfg.globalRateLimitPerMinute,
    timeWindow: 60_000,
    // A presented cookie earns its own budget only when it resolves to a live session; otherwise the
    // request counts against its IP, so random cookies cannot open fresh buckets. The resolution is
    // cached on the request and reused by the route guard (one lookup per request).
    keyGenerator: async (req) => {
      if (sessionToken(req)) {
        const s = await loadAuthState(req).catch(() => null);
        if (s) return `s:${s.sessionId}`;
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => Object.assign(new AppError('RATE_LIMITED', { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) }), { statusCode: 429 }),
  });

  const modules = deps.routeModules ?? defaultRouteModules;
  app.register(
    async (api) => {
      // Every /api route must declare its authorization; the guard is installed from the
      // declaration (rbac.ts). (Plugin routes outside /api, e.g. the CORS preflight, are not app routes.)
      api.addHook('onRoute', (route) => {
        const { guard, chain, entry } = securedPreHandlers(route, { session: requireSession, actor: requireActor, webhook: webhookGuard });
        route.preHandler = chain;
        // the guard runs before input validation (preValidation), ahead of any route preValidation
        if (guard) {
          const own = route.preValidation ? (Array.isArray(route.preValidation) ? route.preValidation : [route.preValidation]) : [];
          route.preValidation = [guard as unknown as preValidationHookHandler, ...own];
        }
        platform.routeTable.push(entry);
      });
      // Authentication before the body is read: a route that needs a session refuses an anonymous (or
      // unknown-cookie) request in preParsing, i.e. after the Origin check and the rate limit
      // (onRequest) but before any body parser runs, so no upload is buffered for it. The full guard
      // (CSRF token, MFA state, tenant, RBAC) still runs in preValidation; this only moves the 401.
      api.addHook('preParsing', async (req, _reply, payload) => {
        const auth = req.routeOptions.config?.auth;
        if (auth !== undefined && auth !== 'public' && auth !== 'webhook' && !(await loadAuthState(req))) throw new AppError('UNAUTHENTICATED');
        return payload;
      });
      for (const m of modules) await api.register(m.register);
    },
    { prefix: '/api' },
  );

  app.addHook('onReady', async () => {
    await dummyHash(); // the first login should not pay for the dummy hash (timing uniformity)
  });

  return app;
}
