// Connection settings shared by the dev setup script and the per-test database helper.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type pg from 'pg';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Loads <repo>/.env into process.env without overriding variables that are already set. */
export function loadRootEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
  }
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export interface ConnectionSettings {
  /** owner/superuser connection to the maintenance database (CREATE/DROP DATABASE) */
  adminUrl: string;
  /** the RLS-bound login role the application uses */
  appUser: { user: string; password: string };
}

const ROLE_LOCK_KEY = 1380270414; // advisory lock: app role DDL
const DEFAULT_OWNER = 'postgres://app_owner:dev@localhost:5432/realty_dev';
const DEFAULT_APP = 'postgres://app_user:app_user_dev@localhost:5432/realty_dev';

export function connectionSettings(): ConnectionSettings {
  loadRootEnv();
  const owner = process.env.MIGRATION_DATABASE_URL || DEFAULT_OWNER;
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || withDatabase(owner, 'postgres');
  const app = new URL(process.env.DATABASE_URL || DEFAULT_APP);
  return {
    adminUrl,
    appUser: { user: decodeURIComponent(app.username), password: decodeURIComponent(app.password) },
  };
}

/**
 * Makes sure the application login role exists exactly as 0001_init.sql expects:
 * NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION, member of no role
 * (0001 aborts otherwise), plus LOGIN with the dev password. Role grants on tables come from the
 * migrations themselves. Roles are cluster-wide, so this is shared by every database in the cluster.
 */
export async function ensureAppUserRole(
  admin: pg.Client,
  appUser: { user: string; password: string },
  log: (line: string) => void = () => {},
): Promise<void> {
  const ident = admin.escapeIdentifier(appUser.user);
  const pw = admin.escapeLiteral(appUser.password);
  const attrs = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION';
  // Role DDL is cluster-wide: concurrent ALTER ROLE from parallel test runs fails with
  // "tuple concurrently updated", so changes serialize on an advisory lock (+ a retry as backstop).
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query('BEGIN');
      await admin.query('SELECT pg_advisory_xact_lock($1)', [ROLE_LOCK_KEY]);
      const { rows } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser.user]);
      if (rows.length === 0) {
        await admin.query(`CREATE ROLE ${ident} ${attrs} PASSWORD ${pw}`);
        log(`created role ${appUser.user}`);
      } else {
        await admin.query(`ALTER ROLE ${ident} WITH ${attrs} PASSWORD ${pw}`);
      }
      await admin.query('COMMIT');
      break;
    } catch (err) {
      await admin.query('ROLLBACK').catch(() => {});
      const e = err as { code?: string; message?: string };
      const transient = e.code === '42710' || /tuple concurrently updated/.test(e.message ?? '');
      if (!transient || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  const members = await admin.query<{ grp: string }>(
    `SELECT g.rolname AS grp FROM pg_auth_members am
       JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname = $1`,
    [appUser.user],
  );
  for (const r of members.rows) {
    await admin.query(`REVOKE ${admin.escapeIdentifier(r.grp)} FROM ${ident}`);
    log(`revoked membership of ${appUser.user} in ${r.grp} (0001_init.sql requires none)`);
  }
}
