// pnpm seed [--reset]: the demo tenant (demo.ts) in the dev database (realty_dev), built THROUGH THE REAL API.
//
// This file is the command line only. Before it touches the database it refuses a production deployment that
// serves real teams (guard.ts) and an unwritable credentials file; then it optionally rebuilds the database and
// runs demo.ts's runDemoSeed, which refuses to seed twice (the demo tenant exists: nothing is changed).
//
// --reset drops and recreates realty_dev and re-applies the migrations first (stop dev servers first).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDefaultDatabase } from '@realty/db';
import { migrate } from '@realty/db/migrate';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { SeedError } from './client.js';
import { runDemoSeed, stdoutLog as log } from './demo.js';
import { assertCredentialsWritable, assertSeedAllowed } from './guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..');
export const CREDENTIALS_PATH = resolve(REPO_ROOT, '.demo/credentials.json');

// ---- reset -------------------------------------------------------------------------------------------

async function resetDatabase(ownerUrl: string): Promise<void> {
  const u = new URL(ownerUrl);
  const dbName = decodeURIComponent(u.pathname.slice(1));
  const admin = new URL(ownerUrl);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(dbName)}`);
    await c.query(`CREATE DATABASE ${c.escapeIdentifier(dbName)} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await c.end();
  }
  const r = await migrate(ownerUrl, resolve(REPO_ROOT, 'packages/db/migrations'), { log: () => {} });
  log(`reset ${dbName}: ${r.applied.length} migrations applied`);
}

// ---- main --------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  assertSeedAllowed(process.env);
  assertCredentialsWritable(CREDENTIALS_PATH);
  const reset = process.argv.includes('--reset');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new SeedError('MIGRATION_DATABASE_URL is not set (run pnpm db:setup first)');
  if (reset) await resetDatabase(ownerUrl);
  const su = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  // An idle client can be terminated by the server (a test database dropped WITH (FORCE), a restart):
  // without a listener pg re-throws it as an unhandled error. Queries in flight still reject normally.
  su.on('error', () => {});
  try {
    await runDemoSeed(su, { config: loadConfig(), credentialsPath: CREDENTIALS_PATH, log });
  } finally {
    await su.end();
  }
}

main().catch(async (e: unknown) => {
  process.stderr.write(`seed failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  await closeDefaultDatabase().catch(() => undefined);
  process.exit(1);
});
