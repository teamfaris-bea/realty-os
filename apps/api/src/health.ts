// Liveness and readiness for load balancers and orchestrators (docs/DEPLOY.md).
//
//   GET /api/health   liveness: the process answers. No database, no details. Always 200 while serving.
//   GET /api/ready    readiness: 200 only when the database answers as an RLS-bound role (not superuser,
//                     no BYPASSRLS) and the process is not draining; otherwise 503. A graceful stop marks
//                     the server draining first, so the balancer takes it out before connections close.
// Both are public, carry no ids, versions or errors, and are exempt from the global rate limit.
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

async function dbReady(p: Platform, timeoutMs: number): Promise<boolean> {
  const check = withPreTenant(
    async (tx) => {
      const r = await sql<{ ok: boolean }>`SELECT NOT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`.execute(tx);
      return r.rows[0]?.ok === true;
    },
    { db: p.db },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([check.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
      if (!(await dbReady(p, 2_000))) return reply.status(503).send({ status: 'unavailable' });
      return { status: 'ready' };
    });
  },
};
