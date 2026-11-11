// Database handle: one pg.Pool (connecting as the RLS-bound app_user) plus a Kysely instance.
//
// The pool's connections never carry tenant context outside a transaction: every GUC is set with
// set_config(..., true) inside the transaction that uses it (ARCHITECTURE §3 "Pool hygiene",
// R-TEN-2, R-TEN-3, E57). The Kysely instance is not exported for direct use by request code: the
// only ways in are withTenantTx / withPreTenant / the job functions, which set (or clear) the
// context first.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

export interface DatabaseOptions {
  /** connection string of the application role (DATABASE_URL: app_user) */
  url: string;
  /** pool size (default 10) */
  max?: number;
  applicationName?: string;
  /** per-statement timeout applied to every pooled connection (default 30 s; 0 disables) */
  statementTimeoutMs?: number;
}

// `date` columns stay 'YYYY-MM-DD' strings: the default parser builds a Date at LOCAL midnight of the
// process time zone, which is ambient state no decision may depend on. int8 and numeric stay strings
// (the pg default) so no precision is ever lost; mappers convert where a number is meant.
const DATE_OID = 1082;
const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === DATE_OID && format !== 'binary') return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  },
} as pg.CustomTypesConfig;

export interface Database {
  readonly pool: pg.Pool;
  /** Internal: only db/client functions use this directly (they set the tenant context first). */
  readonly kysely: Kysely<DB>;
  close(): Promise<void>;
}

export function createDatabase(opts: DatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'realty-db',
    types: typeParsers,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    // No JIT for the application's short OLTP statements (lane scale-250k): RLS row estimates and
    // set-returning definers (default 1,000 rows) push cheap queries past jit_above_cost, and compiling
    // them cost up to 600 ms for a 36 ms scoreboard query at 250k contacts.
    options: '-c jit=off',
  });
  // An idle client error (e.g. the server terminated the connection) must not crash the process.
  pool.on('error', () => {});
  const kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  let closed = false;
  return {
    pool,
    kysely,
    async close() {
      if (closed) return;
      closed = true;
      await kysely.destroy();
    },
  };
}

let defaultDb: Database | null = null;

/**
 * Configures the process-wide default database used by the free functions (`withTenantTx`, `jobs`,
 * `applyOwnershipCommand`, …). The API and worker call this once at start-up; tests create their own
 * handles with `createDatabase` and pass them explicitly.
 */
export function configureDatabase(opts: DatabaseOptions | Database): Database {
  defaultDb = 'kysely' in opts ? opts : createDatabase(opts);
  return defaultDb;
}

/** The default database; created lazily from DATABASE_URL when not configured explicitly. */
export function getDatabase(): Database {
  if (defaultDb) return defaultDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('@realty/db: no database configured (call configureDatabase or set DATABASE_URL)');
  defaultDb = createDatabase({ url });
  return defaultDb;
}

export async function closeDefaultDatabase(): Promise<void> {
  const db = defaultDb;
  defaultDb = null;
  await db?.close();
}
