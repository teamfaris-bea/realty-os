// HTTP entrypoint: config → database → providers → server → listen. The worker has its own
// entrypoint (src/worker/main.ts, api/jobs-worker).
//
// Start-up refuses to serve when the database login is not RLS-bound (superuser or BYPASSRLS): the app
// connects only as app_user. In production it refuses first, before reading anything else, when the database
// owner's credentials are in its environment (dbRole.ts; they belong to the release step only). Graceful stop on SIGTERM/SIGINT: /api/ready turns 503 at once, the server
// keeps serving for SHUTDOWN_DRAIN_MS (the load balancer takes it out), then stops accepting and lets
// in-flight requests finish, closes the pool and exits 0. SHUTDOWN_TIMEOUT_MS is a hard deadline (exit 1).
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { closeDefaultDatabase, configureDatabase } from '@realty/db';
import { loadConfig, redactConfig } from './config.js';
import { assertNoOwnerCredentials, assertRlsBoundLogin } from './dbRole.js';
import { markDraining, registerReadinessCheck } from './health.js';
import { loadObservabilityConfig } from './observability/config.js';
import { createErrorReporter } from './observability/errors.js';
import { startMetricsListener } from './observability/listener.js';
import { instrumentPool, instrumentProcess } from './observability/metrics.js';
import { Registry } from './observability/prometheus.js';
import { createProviders } from './providers/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  assertNoOwnerCredentials(process.env);
  const config = loadConfig();
  const obs = loadObservabilityConfig(process.env);
  const errorReporter = createErrorReporter(obs.errorReporting);
  process.on('uncaughtException', (e) => errorReporter.capture(e, { process: 'api', level: 'fatal', code: 'UNCAUGHT' }));
  process.on('unhandledRejection', (e) => errorReporter.capture(e, { process: 'api', code: 'UNHANDLED_REJECTION' }));
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-api', max: config.databasePoolMax });
  await assertRlsBoundLogin(db);
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const metrics = new Registry();
  instrumentProcess(metrics, { process: 'api', release: obs.errorReporting.release });
  instrumentPool(metrics, db, 'api');
  const app = buildServer(config, { providers: createProviders(config, { clock }), clock, ids, db, metrics, errorReporter });
  // readiness: the provider configuration still loads (e.g. a rotated secret file or env stays valid)
  registerReadinessCheck(app, {
    name: 'providers',
    run: async () => {
      try {
        createProviders(loadConfig(), { clock });
        return true;
      } catch {
        return false;
      }
    },
  });
  const metricsServer = obs.metrics ? await startMetricsListener({ ...obs.metrics, registry: metrics }) : null;
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
    metricsServer?.close();
    await errorReporter.flush();
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
