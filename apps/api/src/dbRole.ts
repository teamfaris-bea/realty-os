// Start-up guards shared by both entrypoints (src/main.ts and src/worker/main.ts; docs/DEPLOY.md §2
// "Start-up refusals"):
//   - the process must log in as the RLS-bound app role. A superuser or BYPASSRLS login would read and write every
//     tenant's rows, so the API and the worker refuse to start on one;
//   - R-DEPLOY-1: and as app_user exactly, with the role model 0001 expects (no CREATEROLE, CREATEDB or REPLICATION,
//     a member of no role, owning nothing, CREATE on no schema), every public table forcing RLS, zero tenants
//     visible without context, and under DATABASE_SSL_MODE=verify-full an encrypted session. The SQL and the order
//     of the checks live in @realty/db (rolePreflight.ts), shared with the release step and `db:preflight --app`;
//   - under NODE_ENV=production the process must not even HOLD the database owner's credentials (batch 5 review F2,
//     DEPLOY §3): docker-compose.prod.yml gave the internet-facing api and worker the env file with the superuser URL
//     and password, and nothing refused it (the role check above looks at DATABASE_URL only). An environment leak or
//     code execution in either process would have been a superuser login: every guard, the append-only and audit
//     tables, and COPY ... TO PROGRAM on the database host. Nor libpq variables (E483): pg reads PG* for any setting
//     the URL lacks, so PGUSER, PGHOST or PGSSLMODE could change what the checked URL means. They refuse to start,
//     naming the variable, never its value.
import { type AppRoleRow, type Database, APP_ROLE_CHECK_SQL, NOT_RLS_BOUND as APP_NOT_RLS_BOUND, appRoleProblems, libpqEnvNames, tlsFailureMessage, withPreTenant } from '@realty/db';
import { sql } from 'kysely';

export const NOT_RLS_BOUND = APP_NOT_RLS_BOUND;

/** The database owner's (superuser's) credentials: only the release step and one-off owner commands hold them. */
export const OWNER_CREDENTIAL_VARS = ['MIGRATION_DATABASE_URL', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_PASSWORD'] as const;

const configError = (message: string) => Object.assign(new Error(message), { name: 'ConfigError' });

/**
 * Under NODE_ENV=production, throws an error named ConfigError that names every owner credential and every libpq
 * variable present (non-empty) in `env`, never a value. Outside production nothing is refused: local development and
 * the tests run both roles from one .env. Runs before anything else reads the environment.
 */
export function assertNoOwnerCredentials(env: Readonly<Record<string, string | undefined>>): void {
  if (env.NODE_ENV !== 'production') return;
  const found = OWNER_CREDENTIAL_VARS.filter((k) => (env[k] ?? '') !== '');
  const libpq = libpqEnvNames(env).filter((k) => !(OWNER_CREDENTIAL_VARS as readonly string[]).includes(k));
  if (found.length === 0 && libpq.length === 0) return;
  const parts: string[] = [];
  if (found.length) parts.push(`the database owner's credentials must not reach the api or the worker: remove ${found.join(', ')} from their environment (they belong to the release step only, docs/DEPLOY.md §3)`);
  if (libpq.length) parts.push(`libpq variables must not be set in production (pg reads them in place of DATABASE_URL's own settings): remove ${libpq.join(', ')}`);
  throw configError(parts.join('; '));
}

/**
 * R-DEPLOY-1: throws an error named ConfigError, naming the check (never a URL, password or host), unless the login
 * is `expectedRole` with the app role model. A connection failure under verify-full becomes
 * "database TLS failed (DATABASE_SSL_MODE=verify-full): <code>".
 */
export async function assertAppRoleModel(db: Database, expectedRole = 'app_user', tls: { mode: 'verify-full' | 'disable' } = { mode: 'disable' }): Promise<void> {
  try {
    (await db.pool.connect()).release();
  } catch (err) {
    if (tls.mode === 'verify-full') throw configError(tlsFailureMessage(err));
    throw err;
  }
  const row = await withPreTenant(async (tx) => (await sql<AppRoleRow>`${sql.raw(APP_ROLE_CHECK_SQL)}`.execute(tx)).rows[0], { db });
  const first = appRoleProblems(row, expectedRole, tls)[0];
  if (first) throw configError(first.message);
}

/** Kept for callers of the batch 5 check: the full R-DEPLOY-1 model, whose first check is the old one. */
export async function assertRlsBoundLogin(db: Database): Promise<void> {
  await assertAppRoleModel(db);
}
