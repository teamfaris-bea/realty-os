// Start-up guards shared by both entrypoints (src/main.ts and src/worker/main.ts; docs/DEPLOY.md §2
// "Start-up refusals"):
//   - the process must log in as the RLS-bound app role. A superuser or BYPASSRLS login would read and write every
//     tenant's rows, so the API and the worker refuse to start on one;
//   - under NODE_ENV=production the process must not even HOLD the database owner's credentials (batch 5 review F2,
//     DEPLOY §3): docker-compose.prod.yml gave the internet-facing api and worker the env file with the superuser URL
//     and password, and nothing refused it (the role check above looks at DATABASE_URL only). An environment leak or
//     code execution in either process would have been a superuser login: every guard, the append-only and audit
//     tables, and COPY ... TO PROGRAM on the database host. They refuse to start, naming the variable, never its value.
import { type Database, withPreTenant } from '@realty/db';
import { sql } from 'kysely';

export const NOT_RLS_BOUND = 'DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)';

/** The database owner's (superuser's) credentials: only the release step and one-off owner commands hold them. */
export const OWNER_CREDENTIAL_VARS = ['MIGRATION_DATABASE_URL', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_PASSWORD'] as const;

/**
 * Under NODE_ENV=production, throws an error named ConfigError that names every owner credential present (non-empty)
 * in `env`, never a value. Outside production nothing is refused: local development and the tests run both roles from
 * one .env. Runs before anything else reads the environment.
 */
export function assertNoOwnerCredentials(env: Readonly<Record<string, string | undefined>>): void {
  if (env.NODE_ENV !== 'production') return;
  const found = OWNER_CREDENTIAL_VARS.filter((k) => (env[k] ?? '') !== '');
  if (found.length === 0) return;
  throw Object.assign(new Error(`the database owner's credentials must not reach the api or the worker: remove ${found.join(', ')} from their environment (they belong to the release step only, docs/DEPLOY.md §3)`), { name: 'ConfigError' });
}

/** Throws an error named ConfigError (its message names DATABASE_URL, never its value) unless the login is RLS-bound. */
export async function assertRlsBoundLogin(db: Database): Promise<void> {
  const role = await withPreTenant(async (tx) => (await sql<{ su: boolean; bypass: boolean }>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`.execute(tx)).rows[0], { db });
  if (!role || role.su || role.bypass) throw Object.assign(new Error(NOT_RLS_BOUND), { name: 'ConfigError' });
}
