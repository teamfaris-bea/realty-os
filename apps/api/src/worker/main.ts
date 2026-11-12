// Worker entrypoint (same build as the API, second entrypoint; ARCHITECTURE §2 "Processes").
//
//   node dist/worker/main.js [--queues realtime,default,bulk,maintenance] [--concurrency 8]
//                            [--no-sweeper] [--no-maintenance]
//
// no owner credentials (production; dbRole.ts) → config → database (app_user) → providers → registry
// (handlers/index.ts) → worker loop + sweeper (every 15 s) + maintenance (every 60 s). SIGTERM/SIGINT stop
// claiming, let in-flight jobs finish, then close the pool. Several worker processes may run: claims use
// SKIP LOCKED, sweeper and periodic enqueues are deduplicated, and maintenance steps are idempotent.
// SHUTDOWN_TIMEOUT_MS is a hard deadline for that stop (exit 1). WORKER_HEALTH_PORT (optional) serves
// GET /health: 200 while the loops run, 503 once stopping (for container health checks; no details).
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { instant } from '@realty/core/foundation';
import { QUEUES, type Queue, closeDefaultDatabase, configureDatabase } from '@realty/db';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { assertAppRoleModel, assertNoOwnerCredentials } from '../dbRole.js';
import { observedAlerts } from '../observability/alerts.js';
import { loadObservabilityConfig } from '../observability/config.js';
import { createErrorReporter } from '../observability/errors.js';
import { startMetricsListener } from '../observability/listener.js';
import { PrometheusWorkerMetrics, collectOperational, instrumentPool, instrumentProcess, teeMetrics } from '../observability/metrics.js';
import { Registry as MetricsRegistry } from '../observability/prometheus.js';
import { createProviders } from '../providers/index.js';
import { handlers } from './handlers/index.js';
import { createWorker, workerName } from './loop.js';
import { createMaintenance } from './maintenance.js';
import { MemoryMetrics, jsonLogger, logAlertSink } from './observability.js';
import { registry } from './registry.js';
import { createSweeper } from './sweeper.js';

const Args = z.object({
  queues: z.array(z.enum(QUEUES)).min(1),
  concurrency: z.coerce.number().int().min(1).max(100),
  sweeper: z.boolean(),
  maintenance: z.boolean(),
});

export function parseArgs(argv: readonly string[]): z.infer<typeof Args> {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return Args.parse({
    queues: (get('--queues') ?? QUEUES.join(',')).split(',').map((s) => s.trim()).filter(Boolean) as Queue[],
    concurrency: get('--concurrency') ?? '8',
    sweeper: !argv.includes('--no-sweeper'),
    maintenance: !argv.includes('--no-maintenance'),
  });
}

async function main(): Promise<void> {
  assertNoOwnerCredentials(process.env);
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const obs = loadObservabilityConfig(process.env);
  const errorReporter = createErrorReporter(obs.errorReporting);
  process.on('uncaughtException', (e) => errorReporter.capture(e, { process: 'worker', level: 'fatal', code: 'UNCAUGHT' }));
  process.on('unhandledRejection', (e) => errorReporter.capture(e, { process: 'worker', code: 'UNHANDLED_REJECTION' }));
  const log = jsonLogger({ level: config.logLevel === 'silent' ? 'silent' : config.logLevel === 'fatal' || config.logLevel === 'trace' ? 'info' : config.logLevel });
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-worker', max: args.concurrency + 4 });
  // same refusal as the API (docs/DEPLOY.md §2): a superuser or BYPASSRLS login would bypass tenant isolation
  await assertAppRoleModel(db);
  const clock = { now: () => instant(Date.now()) };
  const providers = createProviders(config, { clock });
  registry.registerAll(handlers);
  const metricRegistry = new MetricsRegistry();
  instrumentProcess(metricRegistry, { process: 'worker', release: obs.errorReporting.release });
  instrumentPool(metricRegistry, db, 'worker');
  collectOperational(metricRegistry, db);
  const alerts = observedAlerts(logAlertSink(log), metricRegistry, errorReporter);
  const metrics = teeMetrics(new MemoryMetrics(), new PrometheusWorkerMetrics(metricRegistry));
  const metricsServer = obs.metrics ? await startMetricsListener({ ...obs.metrics, registry: metricRegistry }) : null;
  const ac = new AbortController();
  const name = workerName(hostname());
  log.info('starting worker', { worker: name, queues: args.queues, count: args.concurrency, kind: registry.kinds().join(','), telephony: config.providers.telephony, telephonyLiveRequests: config.telephonyLiveRequests });

  const loops: Promise<never>[] = [createWorker({ queues: args.queues, concurrency: args.concurrency, worker: name, db, providers, log, alerts, metrics, signal: ac.signal }).run()];
  if (args.sweeper) loops.push(createSweeper({ db, log, alerts, metrics }).run({ everyMs: 15_000, signal: ac.signal }));
  if (args.maintenance) loops.push(createMaintenance({ db, log, alerts, metrics }).run({ everyMs: 60_000, signal: ac.signal }));

  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? '');
  const health = Number.isInteger(healthPort) && healthPort > 0
    ? createServer((req, res) => {
        const ok = req.url === '/health' && !ac.signal.aborted;
        res.writeHead(req.url === '/health' ? (ok ? 200 : 503) : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: ok ? 'ok' : req.url === '/health' ? 'stopping' : 'not_found' }));
      }).listen(healthPort, '0.0.0.0')
    : null;
  const stop = () => {
    if (ac.signal.aborted) return;
    log.info('stopping worker: no new claims, finishing in-flight jobs', { worker: name });
    ac.abort(new Error('shutdown'));
    setTimeout(() => {
      log.error('worker stop timed out', { worker: name, code: 'SHUTDOWN_TIMEOUT' });
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const results = await Promise.allSettled(loops);
  health?.close();
  metricsServer?.close();
  await errorReporter.flush();
  await closeDefaultDatabase();
  const crashed = results.find((r) => r.status === 'rejected' && !ac.signal.aborted);
  process.exit(crashed ? 1 : 0);
}

const isEntry = process.argv[1] !== undefined && /worker[\\/]main\.(t|j)s$/.test(process.argv[1]);
if (isEntry) {
  main().catch((e: unknown) => {
    // one JSON line, like the API's (docs/DEPLOY.md §2): configuration errors carry no secrets; anything else by name/code only
    const err = e as { name?: string; message?: string; code?: string };
    const detail = err.name === 'ConfigError' || err.name === 'ProviderConfigError' || err.name === 'ZodError' ? (err.message ?? null) : null;
    process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'worker failed to start', type: err.name ?? 'Error', code: err.code ?? null, detail })}\n`);
    process.exit(1);
  });
}
