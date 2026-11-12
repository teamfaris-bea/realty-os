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

/** E478: an attribute of the app role the owner may not change (or one that did not take). */
export class AppRoleAttributeError extends Error {
  override name = 'AppRoleAttributeError';
}

const ROLE_ATTRS = 'rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication';
type RoleAttrKey = 'rolcanlogin' | 'rolsuper' | 'rolbypassrls' | 'rolcreatedb' | 'rolcreaterole' | 'rolinherit' | 'rolreplication';
type RoleAttrRow = Record<RoleAttrKey, boolean>;
/** the app role 0001 expects: LOGIN and nothing else */
const APP_ROLE_TARGET: readonly (readonly [RoleAttrKey, boolean])[] = [
  ['rolcanlogin', true],
  ['rolsuper', false],
  ['rolbypassrls', false],
  ['rolcreatedb', false],
  ['rolcreaterole', false],
  ['rolinherit', false],
  ['rolreplication', false],
];
const ATTR_NAMES: Record<RoleAttrKey, string> = { rolcanlogin: 'LOGIN', rolsuper: 'SUPERUSER', rolbypassrls: 'BYPASSRLS', rolcreatedb: 'CREATEDB', rolcreaterole: 'CREATEROLE', rolinherit: 'INHERIT', rolreplication: 'REPLICATION' };

/**
 * The ALTER ROLE clauses that bring `current` to the app role target, given what `owner` may change under
 * PostgreSQL 16 (pure). Always LOGIN; INHERIT and CREATEROLE are always changeable (with ADMIN on the role);
 * CREATEDB, BYPASSRLS and REPLICATION only by a superuser or a role that has that attribute; SUPERUSER only by a
 * superuser. Throws AppRoleAttributeError (E478) naming the first attribute the owner cannot fix.
 */
export function appRoleAlterations(role: string, current: RoleAttrRow, owner: RoleAttrRow): string[] {
  const out = ['LOGIN'];
  for (const [k, want] of APP_ROLE_TARGET) {
    if (k === 'rolcanlogin' || current[k] === want) continue;
    const name = ATTR_NAMES[k];
    const may = k === 'rolinherit' || k === 'rolcreaterole' || owner.rolsuper || (k !== 'rolsuper' && owner[k]);
    if (!may) {
      const who = k === 'rolsuper' ? 'a superuser' : `a role with ${name}`;
      throw new AppRoleAttributeError(`${role} has ${name} and the owner role cannot remove it (PG16 lets only ${who} change it): ask an administrator to run ALTER ROLE ${role} NO${name}`);
    }
    out.push(`NO${name}`);
  }
  return out;
}
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
 *
 * R-DEPLOY-3: an existing role is altered only in what the owner may change. PostgreSQL 16 lets only a superuser
 * change SUPERUSER, and only a role that has CREATEDB / BYPASSRLS / REPLICATION change that attribute, so a managed
 * database's non-superuser owner would fail the whole ALTER on an attribute that was already right. LOGIN and the
 * password are always set; each WRONG attribute is fixed when the owner may change it, and refused (E478, naming the
 * attribute and the statement an administrator must run) before any ALTER otherwise. Afterwards all seven
 * attributes are read back and asserted.
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
      const { rows } = await admin.query<RoleAttrRow>(`SELECT ${ROLE_ATTRS} FROM pg_roles WHERE rolname = $1`, [appUser.user]);
      if (rows.length === 0) {
        await admin.query(`CREATE ROLE ${ident} ${attrs} PASSWORD ${pw}`);
        log(`created role ${appUser.user}`);
      } else {
        const owner = (await admin.query<RoleAttrRow>(`SELECT ${ROLE_ATTRS} FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
        await admin.query(`ALTER ROLE ${ident} WITH ${appRoleAlterations(appUser.user, rows[0]!, owner).join(' ')} PASSWORD ${pw}`);
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
  const after = (await admin.query<RoleAttrRow>(`SELECT ${ROLE_ATTRS} FROM pg_roles WHERE rolname = $1`, [appUser.user])).rows[0];
  const wrong = after ? APP_ROLE_TARGET.filter(([k, want]) => after[k] !== want).map(([k]) => ATTR_NAMES[k]) : ['(missing)'];
  if (wrong.length) throw new AppRoleAttributeError(`${appUser.user} still has the wrong ${wrong.join(', ')} after the release step aligned it; nothing else was changed`);
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
