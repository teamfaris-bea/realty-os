// Liveness and readiness for load balancers and orchestrators (docs/DEPLOY.md, docs/OPERATIONS.md).
//
//   GET /api/health   liveness: the process answers. No database, no details. Always 200 while serving.
//   GET /api/ready    readiness with dependency checks, each reported as ok | failed:
//                       database   answers as an RLS-bound role (not superuser, no BYPASSRLS)   → down
//                       storage    a probe object can be written, read back and deleted          → degraded
//                       providers  the provider configuration loads (registered by main.ts)      → degraded
//                     200 { status: 'ready' }     every check ok
//                     200 { status: 'degraded' }  the database is fine but storage or providers are not:
//                                                 the instance still serves (sign-in, feed, reads), uploads
//                                                 or sends may fail; the alert pages, the balancer keeps it
//                     503 { status: 'unavailable' } the database check failed (nothing works without it)
//                     503 { status: 'draining' }  a graceful stop marked the server draining first, so the
//                                                 balancer takes it out before connections close
//                   The storage probe result is cached for 30 s so frequent balancer polls stay cheap.
// Both are public, carry no ids, versions or error text, and are exempt from the global rate limit.
import { randomBytes } from 'node:crypto';
import { withPreTenant } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { RouteModule } from './routes.js';
import type { Platform } from './server.js';

const draining = new WeakSet<Platform>();

/** Readiness turns 503 from now on (call before closing the server). */
export function markDraining(app: FastifyInstance): void {
  draining.add(app.platform);
}

export type CheckResult = 'ok' | 'failed';
export interface ReadinessCheck {
  name: 'storage' | 'providers';
  run(): Promise<boolean>;
}

const extraChecks = new WeakMap<Platform, ReadinessCheck[]>();

/** Adds a degraded-level dependency check to this server's readiness (main.ts: provider configuration). */
export function registerReadinessCheck(app: FastifyInstance, check: ReadinessCheck): void {
  const list = extraChecks.get(app.platform) ?? [];
  extraChecks.set(app.platform, [...list.filter((c) => c.name !== check.name), check]);
}

async function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function dbReady(p: Platform, timeoutMs: number): Promise<boolean> {
  return withTimeout(
    withPreTenant(
      async (tx) => {
        const r = await sql<{ ok: boolean }>`SELECT NOT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`.execute(tx);
        return r.rows[0]?.ok === true;
      },
      { db: p.db },
    ),
    timeoutMs,
  );
}

/** The probe lives under the nil tenant (never a real tenant id), so it can never collide with data. */
export const READINESS_PROBE_PREFIX = 'tenants/00000000-0000-0000-0000-000000000000/readiness';
const instance = randomBytes(6).toString('hex');

async function storageWritable(p: Platform): Promise<boolean> {
  const key = `${READINESS_PROBE_PREFIX}/${instance}.probe`;
  const bytes = new Uint8Array(randomBytes(16));
  await p.providers.storage.put(key, bytes, { contentType: 'application/octet-stream' });
  const back = await p.providers.storage.get(key);
  await p.providers.storage.delete(key);
  return back !== null && Buffer.from(back).equals(Buffer.from(bytes));
}

const STORAGE_CACHE_MS = 30_000;
const storageCache = new WeakMap<Platform, { at: number; ok: boolean }>();

async function storageCheck(p: Platform, timeoutMs: number): Promise<CheckResult> {
  const c = storageCache.get(p);
  if (c && performance.now() - c.at < STORAGE_CACHE_MS) return c.ok ? 'ok' : 'failed';
  const ok = await withTimeout(storageWritable(p), timeoutMs);
  storageCache.set(p, { at: performance.now(), ok });
  return ok ? 'ok' : 'failed';
}

export const healthRoutes: RouteModule = {
  name: 'health',
  async register(app) {
    const cfg = { auth: 'public' as const, rateLimit: false as const };
    app.get('/health', { config: cfg }, async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return { status: 'ok' };
    });
    app.get('/ready', { config: cfg }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const p = req.server.platform;
      if (draining.has(p)) return reply.status(503).send({ status: 'draining' });
      const [database, storage, ...extra] = await Promise.all([
        dbReady(p, 2_000).then((ok): CheckResult => (ok ? 'ok' : 'failed')),
        storageCheck(p, 2_000),
        ...(extraChecks.get(p) ?? []).map(async (c) => [c.name, (await withTimeout(c.run(), 2_000)) ? 'ok' : 'failed'] as const),
      ]);
      const checks: Record<string, CheckResult> = { database, storage, ...Object.fromEntries(extra) };
      if (database !== 'ok') return reply.status(503).send({ status: 'unavailable', checks });
      const degraded = Object.values(checks).some((v) => v !== 'ok');
      return { status: degraded ? 'degraded' : 'ready', checks };
    });
  },
};
