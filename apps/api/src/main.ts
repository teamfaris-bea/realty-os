// HTTP entrypoint: config → database → providers → server → listen. The worker has its own
// entrypoint (src/worker/main.ts, api/jobs-worker).
//
// Start-up refuses to serve when the database login is not RLS-bound (superuser or BYPASSRLS): the app
// connects only as app_user. Graceful stop on SIGTERM/SIGINT: /api/ready turns 503 at once, the server
// keeps serving for SHUTDOWN_DRAIN_MS (the load balancer takes it out), then stops accepting and lets
// in-flight requests finish, closes the pool and exits 0. SHUTDOWN_TIMEOUT_MS is a hard deadline (exit 1).
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { closeDefaultDatabase, configureDatabase, withPreTenant } from '@realty/db';
import { sql } from 'kysely';
import { loadConfig, redactConfig } from './config.js';
import { markDraining } from './health.js';
import { createProviders } from './providers/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-api' });
  const role = await withPreTenant(async (tx) => (await sql<{ su: boolean; bypass: boolean }>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`.execute(tx)).rows[0], { db });
  if (!role || role.su || role.bypass) throw Object.assign(new Error('DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)'), { name: 'ConfigError' });
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const app = buildServer(config, { providers: createProviders(config, { clock }), clock, ids, db });
  app.log.info({ config: redactConfig(config) }, 'starting api');
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const hard = setTimeout(() => {
      app.log.error({ code: 'SHUTDOWN_TIMEOUT' }, 'graceful stop timed out');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    hard.unref();
    app.log.info({ drainMs: config.shutdownDrainMs }, `draining after ${signal}`);
    markDraining(app);
    await new Promise((r) => setTimeout(r, config.shutdownDrainMs));
    await app.close();
    await closeDefaultDatabase();
    app.log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  await app.listen({ port: config.apiPort, host: config.apiHost });
}

main().catch((e: unknown) => {
  // configuration errors carry no secrets; anything else is logged by name/code only
  const err = e as { name?: string; message?: string; code?: string };
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'api failed to start', type: err.name ?? 'Error', code: err.code ?? null, detail: err.name === 'ConfigError' || err.name === 'ProviderConfigError' ? err.message : null })}\n`);
  process.exit(1);
});
