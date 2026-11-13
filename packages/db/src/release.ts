// The production release step as a function (docs/DEPLOY.md §3 and §12; scripts/release.ts is its CLI). Run ONCE per
// deploy, before the new api/worker start.
//
//   ownerUrl  MIGRATION_DATABASE_URL: the owner role (creates roles, owns objects; never used by the app)
//   appUrl    DATABASE_URL: the app's login, which must be app_user
//
// Superuser owner (dev, test, staging): align the app role → migrate → post-checks → the R-DEPLOY-1 app checks.
// Its output is unchanged; the new checks print nothing when they pass.
//
// Non-superuser BYPASSRLS + CREATEROLE owner (a managed database's admin role; R-DEPLOY-4):
//   a. preflight: refuse an owner subject to RLS (E475); close a CREATE window a crashed run left open; refuse a
//      missing CREATEROLE, CREATE on the database or ADMIN on an existing cluster role (E477); the FORCE-RLS probe (E476)
//   b. 0001's role block, so the owner creates the roles it lacks (and holds ADMIN on them)
//   c. GRANT app_definer, app_retention TO CURRENT_USER WITH INHERIT TRUE, SET TRUE (unless it already has both)
//   d. ensureAppUserRole (only what this owner may change, R-DEPLOY-3)
//   e. open the schema CREATE window for the definer roles   f. migrate   g. close it, in `finally`
//   h. post-checks (E479), then the app checks over appUrl
// Every refusal names a role, a check or an attribute, never a URL, a password or a host.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ensureAppUserRole } from './dbConfig.js';
import { migrate } from './migrate.js';
import { roleBlockOf } from './roleBlock.js';
import {
  APP_ROLE,
  APP_ROLE_CHECK_SQL,
  type AppRoleRow,
  CLUSTER_ROLES,
  RolePreflightError,
  appRoleProblems,
  closeCreateWindow,
  forceRlsProbe,
  inspectCreateWindow,
  inspectOwnerRole,
  openCreateWindow,
  ownerCapabilityProblems,
  postReleaseProblems,
  probeMessage,
  rlsSubjectMessage,
} from './rolePreflight.js';
import { type DatabaseTls, TLS_DISABLED, pgSsl } from './tls.js';

export interface ReleaseOptions {
  ownerUrl: string | undefined;
  appUrl: string | undefined;
  /** the migrations directory (the image's packages/db/migrations; tests pass a copy) */
  dir: string;
  tls?: DatabaseTls;
  log: (line: string) => void;
}

/** A refusal of the release step; its message names no secret. */
export class ReleaseRefused extends Error {
  override name = 'ReleaseRefused';
}

/** The app login named in DATABASE_URL, after the checks the release step makes before it connects. */
export function appLoginOf(ownerUrl: string | undefined, appUrl: string | undefined): { user: string; password: string } {
  if (!ownerUrl || !appUrl) throw new ReleaseRefused('MIGRATION_DATABASE_URL and DATABASE_URL must be set');
  const app = new URL(appUrl);
  const appUser = { user: decodeURIComponent(app.username), password: decodeURIComponent(app.password) };
  if (!appUser.user || !appUser.password) throw new ReleaseRefused('DATABASE_URL must carry the app role name and password');
  if (new URL(ownerUrl).username === app.username) throw new ReleaseRefused('the owner and the app must be different roles');
  // the migrations grant to app_user by name: any other login would be created, migrated for, then refused
  // by RLS ("permission denied for table tenants") after every migration had been applied (deploy rehearsal)
  if (appUser.user !== APP_ROLE) throw new ReleaseRefused(`DATABASE_URL must log in as ${APP_ROLE} (the migrations grant to that role); nothing was changed`);
  return appUser;
}

export async function runRelease(o: ReleaseOptions): Promise<void> {
  const appUser = appLoginOf(o.ownerUrl, o.appUrl);
  const tls = o.tls ?? TLS_DISABLED;
  const ssl = pgSsl(tls);
  const log = o.log;
  const roleBlock = roleBlockOf(readFileSync(join(o.dir, '0001_init.sql'), 'utf8'));

  const admin = new pg.Client({ connectionString: o.ownerUrl, ssl });
  await admin.connect();
  let windowOpen = false;
  let superuser = true;
  try {
    // a. preflight
    let owner = await inspectOwnerRole(admin);
    superuser = owner.su;
    if (!owner.su && !owner.bypass) throw new RolePreflightError('E475', rlsSubjectMessage(owner.role));
    if (!owner.su) {
      if ((await inspectCreateWindow(admin)).open) await closeCreateWindow(admin, log, 'schema CREATE window left open by an earlier run: closed');
      const missing = ownerCapabilityProblems(owner);
      if (missing.length) throw new RolePreflightError('E477', `${missing.join('; ')}; nothing was changed`);
    }
    const probe = await forceRlsProbe(admin);
    if (!probe.ok) throw new RolePreflightError('E476', probeMessage(owner.role, probe.reason));

    if (!owner.su) {
      // b. the cluster roles, created by this owner when missing (it then holds ADMIN on them)
      const missingRoles = CLUSTER_ROLES.filter((r) => !owner.roles[r].exists);
      await admin.query(roleBlock);
      log(missingRoles.length ? `cluster roles: created ${missingRoles.join(', ')} (0001 role block)` : 'cluster roles: app_user, app_definer, app_retention present');
      owner = await inspectOwnerRole(admin);
      // c. SET and INHERIT membership in the definer roles: ALTER … OWNER TO needs SET, the EXECUTE grants on their
      //    functions need INHERIT (verified on PostgreSQL 16)
      if (owner.roles.app_definer.set && owner.roles.app_definer.usage && owner.roles.app_retention.set && owner.roles.app_retention.usage) {
        log(`definer roles: ${owner.role} is already a member (SET, INHERIT)`);
      } else {
        await admin.query('GRANT app_definer, app_retention TO CURRENT_USER WITH INHERIT TRUE, SET TRUE');
        log(`definer roles: membership granted to ${owner.role} (SET, INHERIT)`);
      }
    }
    // d. the app role
    await ensureAppUserRole(admin, appUser, log);
    if (!owner.su) log(`app role: ${APP_ROLE} aligned (LOGIN, the password from DATABASE_URL)`);
    // e-g. migrate inside the CREATE window
    let applied: string[];
    let already: string[];
    if (!owner.su) {
      windowOpen = true;
      await openCreateWindow(admin, log);
    }
    try {
      const r = await migrate(o.ownerUrl!, o.dir, { log, ssl });
      applied = r.applied;
      already = r.alreadyApplied;
    } finally {
      if (windowOpen) {
        await closeCreateWindow(admin, log);
        windowOpen = false;
      }
    }
    log(`migrations: ${applied.length} applied, ${already.length} already applied`);
    // h. post-checks
    const problems = await postReleaseProblems(admin);
    if (problems.length) throw new RolePreflightError('E479', `post-checks failed: ${problems.join('; ')}`);
    if (!owner.su) log('post-checks: definer ownership, schema CREATE grants and definer roles ok');
  } finally {
    // a failed close (the connection dropped) leaves the window to the next run, which closes it first (step a)
    if (windowOpen && !superuser) await closeCreateWindow(admin, log).catch(() => {});
    await admin.end().catch(() => {});
  }

  const c = new pg.Client({ connectionString: o.appUrl, ssl });
  await c.connect();
  try {
    const row = (await c.query<AppRoleRow>(APP_ROLE_CHECK_SQL)).rows[0];
    const problems = appRoleProblems(row, APP_ROLE, tls);
    if (problems.length) throw new RolePreflightError('R-DEPLOY-1', `the app role check failed: ${problems.map((p) => p.message).join('; ')}`);
    log(`release ok: app connects as ${row!.current_user}, RLS-bound`);
  } finally {
    await c.end();
  }
}

/**
 * The CLI's error line: our refusals and migration errors by message (they name no secret), a server error by its
 * message (the server's text names no client URL), anything else (a connection or TLS failure, whose message can
 * carry the host) by its code only.
 */
export function releaseFailure(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: unknown; severity?: unknown } | null;
  if (e && ['ReleaseRefused', 'RolePreflightError', 'AppRoleAttributeError', 'MigrationError', 'DatabaseTlsError'].includes(e.name ?? '')) return e.message ?? '';
  if (e && typeof e.severity === 'string' && typeof e.message === 'string') return `${e.message} (SQLSTATE ${String(e.code)})`;
  const code = typeof e?.code === 'string' ? e.code : /does not support SSL/.test(e?.message ?? '') ? 'SERVER_NO_SSL' : 'CONNECT_FAILED';
  return `database connection failed: ${code}`;
}
