// Worker entrypoint (same build as the API, second entrypoint; ARCHITECTURE §2 "Processes").
//
//   node dist/worker/main.js [--queues realtime,default,bulk,maintenance] [--concurrency 8]
//                            [--no-sweeper] [--no-maintenance]
//
// config → database (app_user) → providers → registry (handlers/index.ts) → worker loop + sweeper
// (every 15 s) + maintenance (every 60 s). SIGTERM/SIGINT stop claiming, let in-flight jobs finish,
// then close the pool. Several worker processes may run: claims use SKIP LOCKED, sweeper and
// periodic enqueues are deduplicated, and maintenance steps are idempotent.
import { hostname } from 'node:os';
import { instant } from '@realty/core/foundation';
import { QUEUES, type Queue, closeDefaultDatabase, configureDatabase } from '@realty/db';
import { z } from 'zod';
import { loadConfig } from '../config.js';
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
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = jsonLogger({ level: config.logLevel === 'silent' ? 'silent' : config.logLevel === 'fatal' || config.logLevel === 'trace' ? 'info' : config.logLevel });
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-worker', max: args.concurrency + 4 });
  const clock = { now: () => instant(Date.now()) };
  const providers = createProviders(config, { clock });
  registry.registerAll(handlers);
  const alerts = logAlertSink(log);
  const metrics = new MemoryMetrics();
  const ac = new AbortController();
  const name = workerName(hostname());
  log.info('starting worker', { worker: name, queues: args.queues, count: args.concurrency, kind: registry.kinds().join(',') });

  const loops: Promise<never>[] = [createWorker({ queues: args.queues, concurrency: args.concurrency, worker: name, db, providers, log, alerts, metrics, signal: ac.signal }).run()];
  if (args.sweeper) loops.push(createSweeper({ db, log, alerts, metrics }).run({ everyMs: 15_000, signal: ac.signal }));
  if (args.maintenance) loops.push(createMaintenance({ db, log, alerts, metrics }).run({ everyMs: 60_000, signal: ac.signal }));

  const stop = () => ac.abort(new Error('shutdown'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const results = await Promise.allSettled(loops);
  await closeDefaultDatabase();
  const crashed = results.find((r) => r.status === 'rejected' && !ac.signal.aborted);
  process.exit(crashed ? 1 : 0);
}

const isEntry = process.argv[1] !== undefined && /worker[\\/]main\.(t|j)s$/.test(process.argv[1]);
if (isEntry) {
  main().catch((e: unknown) => {
    const err = e as { name?: string; message?: string };
    process.stderr.write(`worker failed to start: ${err.name ?? 'Error'}: ${err.name === 'ConfigError' || err.name === 'ProviderConfigError' || err.name === 'ZodError' ? err.message : ''}\n`);
    process.exit(1);
  });
}
