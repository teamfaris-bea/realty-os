// The release step (docs/DEPLOY.md §3) refuses an app login other than app_user before it changes anything.
// Deploy rehearsal: with DATABASE_URL user realty_app it created that role, applied every migration, then failed
// "permission denied for table tenants", leaving a migrated database and a stray role behind.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionSettings } from '../src/dbConfig.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const release = join(dirname(fileURLToPath(import.meta.url)), '../src/scripts/release.ts');
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb({ empty: true });
});
afterAll(async () => {
  await db?.drop();
});

async function one<T extends pg.QueryResultRow>(url: string, q: string, params: unknown[] = []): Promise<T | undefined> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows[0];
  } finally {
    await c.end();
  }
}

describe('release step', () => {
  it('refuses a DATABASE_URL that does not log in as app_user, before creating a role or applying a migration', async () => {
    const role = `realty_app_${process.pid}`;
    const appUrl = new URL(db.ownerUrl);
    appUrl.username = role;
    appUrl.password = 'rehearsal-only-password';
    const r = spawnSync(process.execPath, ['--import', 'tsx', release], { env: { ...process.env, MIGRATION_DATABASE_URL: db.ownerUrl, DATABASE_URL: appUrl.href }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release failed: DATABASE_URL must log in as app_user');
    expect(r.stderr + r.stdout).not.toContain('rehearsal-only-password');
    expect(await one(db.ownerUrl, `SELECT 1 FROM pg_namespace WHERE nspname = 'realty_migrations'`)).toBeUndefined();
    expect(await one(connectionSettings().adminUrl, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).toBeUndefined();
  }, 70_000);
});
