// Start-up guard shared by both entrypoints (src/main.ts and src/worker/main.ts; docs/DEPLOY.md §2
// "Start-up refusals"): the process must log in as the RLS-bound app role. A superuser or BYPASSRLS login
// would read and write every tenant's rows, so the API and the worker refuse to start on one.
import { type Database, withPreTenant } from '@realty/db';
import { sql } from 'kysely';

export const NOT_RLS_BOUND = 'DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)';

/** Throws an error named ConfigError (its message names DATABASE_URL, never its value) unless the login is RLS-bound. */
export async function assertRlsBoundLogin(db: Database): Promise<void> {
  const role = await withPreTenant(async (tx) => (await sql<{ su: boolean; bypass: boolean }>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`.execute(tx)).rows[0], { db });
  if (!role || role.su || role.bypass) throw Object.assign(new Error(NOT_RLS_BOUND), { name: 'ConfigError' });
}
