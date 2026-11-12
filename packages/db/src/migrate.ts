// Migration runner (tooling; owned by db/client afterwards, see docs/CONVENTIONS.md).
//
// - Applies <dir>/*.sql in lexical order. File names must be NNNN_<module>_<what>.sql with a unique
//   4-digit prefix.
// - Each file runs in ONE transaction together with its schema_migrations row, so a failing file
//   leaves nothing behind.
// - Applied files are recorded in realty_migrations.schema_migrations with a sha256 checksum.
//   An applied file whose content changed, an applied file that disappeared, or a pending file that
//   sorts before an applied one is an error: applied migrations are never edited or reordered.
// - The bookkeeping table lives in its own schema (not public): 0001's self-check requires every
//   public table to have RLS, and app_user gets no access to it.
// - Concurrent runners against one database serialize on an advisory lock.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { rlsSubjectMessage } from './rolePreflight.js';

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:[_-][a-z0-9]+)*)\.sql$/;
const LOCK_KEY = 1380270413; // arbitrary constant, "realty migrate"

export interface MigrationFile {
  /** file name, e.g. 0001_init.sql */
  name: string;
  /** 4-digit prefix, e.g. 0001 */
  version: string;
  sql: string;
  /** sha256 hex of the file bytes */
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrateOptions {
  log?: (line: string) => void;
  /** pg's ssl option (packages/db/src/tls.ts pgSsl): every production client passes the same one */
  ssl?: pg.ClientConfig['ssl'];
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function listMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const seen = new Map<string, string>();
  return names.map((name) => {
    const m = MIGRATION_FILE_PATTERN.exec(name);
    if (!m) {
      throw new MigrationError(
        `migration file name "${name}" must match NNNN_<module>_<what>.sql (lowercase, digits, _ or -)`,
      );
    }
    const version = m[1]!;
    const dup = seen.get(version);
    if (dup) throw new MigrationError(`duplicate migration number ${version}: "${dup}" and "${name}"`);
    seen.set(version, name);
    const bytes = readFileSync(join(dir, name));
    return {
      name,
      version,
      sql: bytes.toString('utf8'),
      checksum: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

/** Content hash of a migration set: changes whenever any file is added, removed, renamed or edited. */
export function migrationsHash(files: readonly MigrationFile[]): string {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.name}\0${f.checksum}\n`);
  return h.digest('hex');
}

function lineOf(sql: string, position: number | undefined): number | undefined {
  if (!position || position < 1) return undefined;
  let line = 1;
  for (let i = 0; i < position - 1 && i < sql.length; i++) if (sql.charCodeAt(i) === 10) line++;
  return line;
}

export async function migrate(url: string, dir: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = listMigrations(dir);
  const client = new pg.Client({ connectionString: url, application_name: 'realty-migrate', ...(opts.ssl !== undefined ? { ssl: opts.ssl } : {}) });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // R-DEPLOY-2 (E475): an owner subject to row-level security would run the backfills against FORCE-RLS tables
    // and update zero rows without an error. Refused before anything is written; a read-only run (nothing pending)
    // still works.
    const owner = (
      await client.query<{ role: string; bound: boolean; booked: boolean }>(
        `SELECT current_user::text AS role, NOT (r.rolsuper OR r.rolbypassrls) AS bound,
                to_regclass('realty_migrations.schema_migrations') IS NOT NULL AS booked
           FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0]!;
    if (owner.bound && !owner.booked) throw new MigrationError(rlsSubjectMessage(owner.role));
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS realty_migrations;
      REVOKE ALL ON SCHEMA realty_migrations FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS realty_migrations.schema_migrations (
        version     text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
        name        text NOT NULL UNIQUE,
        checksum    text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
        duration_ms integer NOT NULL
      );`);
    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM realty_migrations.schema_migrations ORDER BY version',
    );
    const byVersion = new Map(files.map((f) => [f.version, f]));
    for (const r of rows) {
      const f = byVersion.get(r.version);
      if (!f) throw new MigrationError(`applied migration ${r.name} is missing from ${dir}`);
      if (f.name !== r.name) throw new MigrationError(`applied migration ${r.name} was renamed to ${f.name}`);
      if (f.checksum !== r.checksum) {
        throw new MigrationError(
          `applied migration ${r.name} was edited (checksum mismatch). Never edit an applied migration; add a new one.`,
        );
      }
    }
    const applied = new Set(rows.map((r) => r.version));
    const lastApplied = rows.length ? rows[rows.length - 1]!.version : null;
    const pending = files.filter((f) => !applied.has(f.version));
    for (const f of pending) {
      if (lastApplied && f.version < lastApplied) {
        throw new MigrationError(
          `pending migration ${f.name} sorts before already-applied ${lastApplied}; renumber it to the next free number`,
        );
      }
    }
    if (owner.bound && pending.length > 0) throw new MigrationError(rlsSubjectMessage(owner.role));
    const done: string[] = [];
    for (const f of pending) {
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query(
          'INSERT INTO realty_migrations.schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
          [f.version, f.name, f.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const e = err as { message?: string; position?: string };
        const line = lineOf(f.sql, e.position ? Number(e.position) : undefined);
        throw new MigrationError(`${f.name}${line ? `:${line}` : ''}: ${e.message ?? String(err)}`, { cause: err });
      }
      log(`applied ${f.name} (${Date.now() - started} ms)`);
      done.push(f.name);
    }
    return { applied: done, alreadyApplied: rows.map((r) => r.name) };
  } finally {
    await client.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    await client.end();
  }
}
