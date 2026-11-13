// Throwaway owner roles for the role-preflight and release tests (R-DEPLOY-2..4). Roles are cluster-wide, so every
// role is named realty_trial_<pid>_<tag>, and cleanupTrials() revokes every membership those roles granted, drops
// their databases, then drops the roles. clusterRoleSnapshot() lets each file assert that app_user, app_definer and
// app_retention keep their attributes and memberships.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connectionSettings, withCredentials, withDatabase } from '../src/dbConfig.js';

export interface TrialOwner {
  name: string;
  password: string;
  /** a URL that logs in as this role to `database` */
  url(database: string): string;
}

const created: string[] = [];
const databases: string[] = [];

export async function admin<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const url = database ? withDatabase(connectionSettings().adminUrl, database) : connectionSettings().adminUrl;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Creates realty_trial_<pid>_<tag> LOGIN with the given attributes (e.g. 'CREATEROLE BYPASSRLS'). */
export async function createTrialOwner(tag: string, attrs: string): Promise<TrialOwner> {
  const name = `realty_trial_${process.pid}_${tag}`;
  const password = randomBytes(12).toString('hex');
  await admin((c) => c.query(`CREATE ROLE ${c.escapeIdentifier(name)} LOGIN ${attrs} PASSWORD ${c.escapeLiteral(password)}`));
  created.push(name);
  return { name, password, url: (database) => withCredentials(withDatabase(connectionSettings().adminUrl, database), name, password) };
}

/** Creates an empty database owned by `owner` (from template0: no extensions). */
export async function createTrialDb(owner: TrialOwner | string, tag: string): Promise<string> {
  const db = `realty_trial_${process.pid}_${tag}`;
  const role = typeof owner === 'string' ? owner : owner.name;
  await admin((c) => c.query(`CREATE DATABASE ${c.escapeIdentifier(db)} OWNER ${c.escapeIdentifier(role)} TEMPLATE template0`));
  databases.push(db);
  return db;
}

export async function cleanupTrials(): Promise<void> {
  await admin(async (c) => {
    for (const db of databases.splice(0)) await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(db)} WITH (FORCE)`);
    const mine = `realty_trial_${process.pid}_%`;
    const grants = (
      await c.query<{ grp: string; member: string; grantor: string }>(
        `SELECT g.rolname AS grp, m.rolname AS member, gr.rolname AS grantor FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member JOIN pg_roles gr ON gr.oid = am.grantor
          WHERE gr.rolname LIKE $1 OR m.rolname LIKE $1 OR g.rolname LIKE $1`,
        [mine],
      )
    ).rows;
    for (const g of grants) {
      await c.query(`REVOKE ${c.escapeIdentifier(g.grp)} FROM ${c.escapeIdentifier(g.member)} GRANTED BY ${c.escapeIdentifier(g.grantor)} CASCADE`).catch(() => {});
    }
    const roles = (await c.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [mine])).rows.map((r) => r.rolname);
    for (const r of roles) await c.query(`DROP ROLE IF EXISTS ${c.escapeIdentifier(r)}`);
    created.splice(0);
  });
}

/** Attributes and memberships of the three cluster roles, ignoring throwaway trial roles of other processes. */
export async function clusterRoleSnapshot(): Promise<unknown> {
  return admin(async (c) => ({
    roles: (await c.query(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication FROM pg_roles WHERE rolname IN ('app_user','app_definer','app_retention') ORDER BY 1`)).rows,
    members: (
      await c.query(
        `SELECT g.rolname AS grp, m.rolname AS member, am.admin_option, am.inherit_option, am.set_option FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
          WHERE (g.rolname IN ('app_user','app_definer','app_retention') OR m.rolname IN ('app_user','app_definer','app_retention'))
            AND m.rolname NOT LIKE 'realty_trial_%' AND g.rolname NOT LIKE 'realty_trial_%' ORDER BY 1, 2`,
      )
    ).rows,
  }));
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
