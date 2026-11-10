// HTTP entrypoint: config → database → providers → server → listen. The worker has its own
// entrypoint (src/worker/main.ts, api/jobs-worker).
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { closeDefaultDatabase, configureDatabase } from '@realty/db';
import { loadConfig, redactConfig } from './config.js';
import { createProviders } from './providers/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-api' });
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const app = buildServer(config, { providers: createProviders(config, { clock }), clock, ids, db });
  app.log.info({ config: redactConfig(config) }, 'starting api');
  const stop = async () => {
    await app.close();
    await closeDefaultDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await app.listen({ port: config.apiPort, host: config.apiHost });
}

main().catch((e: unknown) => {
  // configuration errors carry no secrets; anything else is logged by name/code only
  const err = e as { name?: string; message?: string };
  process.stderr.write(`api failed to start: ${err.name ?? 'Error'}: ${err.name === 'ConfigError' || err.name === 'ProviderConfigError' ? err.message : ''}\n`);
  process.exit(1);
});
