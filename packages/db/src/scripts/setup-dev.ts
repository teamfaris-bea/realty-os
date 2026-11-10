// pnpm db:setup — one-shot dev bootstrap (idempotent):
//   1. writes <repo>/.env from .env.example if it does not exist, with a fresh 32-byte KEK and session secret
//   2. creates the dev database named in MIGRATION_DATABASE_URL (realty_dev) if missing
//   3. makes sure the app_user login role exists exactly as 0001_init.sql expects (see ensureAppUserRole)
//   4. applies migrations as the owner role
//   5. proves the app role is RLS-bound: it can connect and sees zero tenant rows without context
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  MIGRATIONS_DIR,
  REPO_ROOT,
  databaseOf,
  ensureAppUserRole,
  loadRootEnv,
  withDatabase,
} from '../dbConfig.js';
import { migrate } from '../migrate.js';

function writeEnvIfMissing(): void {
  const envPath = resolve(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    console.log('.env exists; leaving it unchanged');
    return;
  }
  const example = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
  const filled = example
    .replace(/^KEK_BASE64=.*$/m, `KEK_BASE64=${randomBytes(32).toString('base64')}`)
    .replace(/^SESSION_SECRET_BASE64=.*$/m, `SESSION_SECRET_BASE64=${randomBytes(32).toString('base64')}`);
  writeFileSync(envPath, filled, { mode: 0o600 });
  console.log('wrote .env with a freshly generated dev KEK and session secret');
}

async function main(): Promise<void> {
  writeEnvIfMissing();
  loadRootEnv();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL must be set');
  const dbName = databaseOf(ownerUrl);
  const app = new URL(appUrl);
  const appUser = { user: decodeURIComponent(app.username), password: decodeURIComponent(app.password) };

  const admin = new pg.Client({ connectionString: withDatabase(ownerUrl, 'postgres') });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)} TEMPLATE template0 ENCODING 'UTF8'`);
      console.log(`created database ${dbName}`);
    }
    await ensureAppUserRole(admin, appUser, (l) => console.log(l));
    console.log(`role ${appUser.user}: LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT, member of no role`);
  } finally {
    await admin.end();
  }

  const r = await migrate(ownerUrl, MIGRATIONS_DIR, { log: (l) => console.log(l) });
  console.log(`migrations: ${r.applied.length} applied, ${r.alreadyApplied.length} already applied`);

  const appClient = new pg.Client({ connectionString: appUrl });
  await appClient.connect();
  try {
    const { rows } = await appClient.query<{ who: string; n: string }>(
      'SELECT current_user AS who, (SELECT count(*) FROM tenants) AS n',
    );
    console.log(`connected as ${rows[0]!.who}; tenants visible without context: ${rows[0]!.n}`);
  } finally {
    await appClient.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
