// Per-test-file PostgreSQL databases (docs/CONVENTIONS.md "Test databases").
//
//   const db = await createTestDb();      // beforeAll
//   ... connect as db.appUserUrl (RLS-bound app_user) or db.ownerUrl (superuser, fixtures only) ...
//   await db.drop();                      // afterAll
//
// How it works
// - A template database holds every migration in packages/db/migrations. By default it is named after
//   the migrations' content hash (`realty_template_<first 12 hex>`), so checkouts with different
//   migrations (parallel worktrees, branches) each keep their own template instead of rebuilding a
//   shared one back and forth. Its COMMENT stores the full hash and the build time; a mismatch (a
//   migration was added or changed) rebuilds it from template0. Hash templates unused for
//   TEMPLATE_STALE_AFTER_MS are garbage-collected when nobody holds their lock.
// - Rebuilds hold an EXCLUSIVE advisory lock (in the maintenance database); clones hold the SHARED
//   lock while they copy, so concurrent test runs never clone a half-built template and never rebuild
//   twice.
// - Each call clones a uniquely named database `realty_test_<time>_<pid>_<rand>`; drop() removes it.
//   Databases older than STALE_AFTER_MS left behind by crashed runs are garbage-collected.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  MIGRATIONS_DIR,
  connectionSettings,
  ensureAppUserRole,
  withCredentials,
  withDatabase,
} from '../dbConfig.js';
import { listMigrations, migrate, migrationsHash } from '../migrate.js';

export interface TestDb {
  /** the database name (realty_test_...) */
  name: string;
  /** connect as app_user: NOSUPERUSER NOBYPASSRLS, so every RLS policy applies. Use this for app code. */
  appUserUrl: string;
  /** connect as the owner/superuser: fixtures and assertions that must bypass RLS only. */
  ownerUrl: string;
  /** true when this call (re)built the template database */
  templateRebuilt: boolean;
  /** drops the database (idempotent; terminates leftover connections) */
  drop(): Promise<void>;
}

export interface CreateTestDbOptions {
  /** defaults to packages/db/migrations */
  migrationsDir?: string;
  /** defaults to realty_template_<first 12 hex of the migrations hash> */
  templateName?: string;
  /** clone template0 instead (no migrations applied): for testing the migration runner itself */
  empty?: boolean;
}

export const DEFAULT_TEMPLATE = 'realty_template';
export const TEST_DB_PREFIX = 'realty_test_';
const LOCK_CLASS = 1380270412; // advisory lock namespace "realty template"
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const TEMPLATE_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const HASH_TEMPLATE_RE = /^realty_template_[0-9a-f]{12}$/;
const MARKER_PREFIX = 'realty-template migrations-sha256=';
const BUILT_SEPARATOR = ' built=';

/** The default template for a migrations hash. */
export function hashTemplateName(hash: string): string {
  return `${DEFAULT_TEMPLATE}_${hash.slice(0, 12)}`;
}

/** A template is current when its comment names this hash (with or without a build time). */
function markerMatches(current: string | null, marker: string): boolean {
  return current === marker || (current !== null && current.startsWith(marker + BUILT_SEPARATOR));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isObjectInUse(err: unknown): boolean {
  return (err as { code?: string }).code === '55006';
}

async function retryInUse<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isObjectInUse(err) || attempt >= 40) throw err;
      await sleep(50 + Math.floor(Math.random() * 100) * Math.min(attempt + 1, 5));
    }
  }
}

async function templateMarker(admin: pg.Client, template: string): Promise<string | null> {
  const { rows } = await admin.query<{ marker: string | null }>(
    `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
    [template],
  );
  return rows.length ? (rows[0]!.marker ?? '') : null;
}

async function appUserCanLogin(admin: pg.Client, user: string): Promise<boolean> {
  const { rows } = await admin.query<{ ok: boolean }>(
    `SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AS ok FROM pg_roles WHERE rolname = $1`,
    [user],
  );
  return rows[0]?.ok === true;
}

async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  const ident = admin.escapeIdentifier(name);
  // a template database cannot be dropped until it is unmarked
  const { rows } = await admin.query<{ datistemplate: boolean }>(
    'SELECT datistemplate FROM pg_database WHERE datname = $1',
    [name],
  );
  if (rows[0]?.datistemplate) await admin.query(`ALTER DATABASE ${ident} WITH IS_TEMPLATE false`);
  await retryInUse(() => admin.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`));
}

async function rebuildTemplate(
  admin: pg.Client,
  template: string,
  migrationsDir: string,
  marker: string,
  adminUrl: string,
  appUser: { user: string; password: string },
): Promise<void> {
  const ident = admin.escapeIdentifier(template);
  await dropDatabase(admin, template);
  await admin.query(`CREATE DATABASE ${ident} TEMPLATE template0 ENCODING 'UTF8'`);
  try {
    await ensureAppUserRole(admin, appUser);
    await migrate(withDatabase(adminUrl, template), migrationsDir);
    await admin.query(`COMMENT ON DATABASE ${ident} IS ${admin.escapeLiteral(marker + BUILT_SEPARATOR + Date.now())}`);
    // nobody may connect to the template: a stray connection would block every clone
    await admin.query(`ALTER DATABASE ${ident} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  } catch (err) {
    await dropDatabase(admin, template).catch(() => {});
    throw err;
  }
}

/** Drops hash-named templates built more than TEMPLATE_STALE_AFTER_MS ago that nobody is using. */
async function collectStaleTemplates(admin: pg.Client, keep: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string; marker: string | null }>(
    `SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname LIKE 'realty\\_template\\_%'`,
  );
  const now = Date.now();
  for (const { datname, marker } of rows) {
    if (datname === keep || !HASH_TEMPLATE_RE.test(datname)) continue;
    const built = Number(marker?.split(BUILT_SEPARATOR)[1]);
    if (!Number.isFinite(built) || now - built <= TEMPLATE_STALE_AFTER_MS) continue;
    // only when no clone or rebuild holds this template's lock right now
    const { rows: got } = await admin.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [LOCK_CLASS, datname]);
    if (!got[0]?.ok) continue;
    try {
      await dropDatabase(admin, datname).catch(() => {});
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_CLASS, datname]);
    }
  }
}

async function collectStale(admin: pg.Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${TEST_DB_PREFIX}%`],
  );
  const now = Date.now();
  for (const { datname } of rows) {
    const stamp = /^realty_test_([0-9a-z]+)_/.exec(datname)?.[1];
    const created = stamp ? parseInt(stamp, 36) : NaN;
    if (Number.isFinite(created) && now - created > STALE_AFTER_MS) {
      await dropDatabase(admin, datname).catch(() => {});
    }
  }
}

/**
 * Creates an isolated, fully migrated database for one test file.
 * Safe to call concurrently from many processes.
 */
export async function createTestDb(opts: CreateTestDbOptions = {}): Promise<TestDb> {
  const { adminUrl, appUser } = connectionSettings();
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const hash = opts.empty ? '' : migrationsHash(listMigrations(migrationsDir));
  const template = opts.templateName ?? hashTemplateName(hash);
  const name = `${TEST_DB_PREFIX}${Date.now().toString(36)}_${process.pid}_${randomBytes(4).toString('hex')}`;
  let templateRebuilt = false;

  const admin = new pg.Client({ connectionString: adminUrl, application_name: 'realty-test-db' });
  await admin.connect();
  try {
    await collectStale(admin);
    if (!opts.empty && opts.templateName === undefined) await collectStaleTemplates(admin, template);
    if (opts.empty) {
      await retryInUse(() => admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0 ENCODING 'UTF8'`));
    } else {
      const marker = MARKER_PREFIX + hash;
      for (let round = 0; ; round++) {
        await admin.query('SELECT pg_advisory_lock_shared($1, hashtext($2))', [LOCK_CLASS, template]);
        let cloned = false;
        try {
          if (markerMatches(await templateMarker(admin, template), marker) && (await appUserCanLogin(admin, appUser.user))) {
            await retryInUse(() =>
              admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${admin.escapeIdentifier(template)}`),
            );
            cloned = true;
          }
        } finally {
          await admin.query('SELECT pg_advisory_unlock_shared($1, hashtext($2))', [LOCK_CLASS, template]);
        }
        if (cloned) break;
        if (round >= 3) throw new Error(`createTestDb: template ${template} could not be prepared`);
        await admin.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_CLASS, template]);
        try {
          const current = await templateMarker(admin, template);
          if (!markerMatches(current, marker) || !(await appUserCanLogin(admin, appUser.user))) {
            await rebuildTemplate(admin, template, migrationsDir, marker, adminUrl, appUser);
            templateRebuilt = true;
          }
        } finally {
          await admin.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_CLASS, template]);
        }
      }
    }
  } finally {
    await admin.end();
  }

  const ownerUrl = withDatabase(adminUrl, name);
  const appUserUrl = withCredentials(ownerUrl, appUser.user, appUser.password);
  let dropped = false;
  return {
    name,
    ownerUrl,
    appUserUrl,
    templateRebuilt,
    async drop() {
      if (dropped) return;
      const c = new pg.Client({ connectionString: adminUrl, application_name: 'realty-test-db' });
      await c.connect();
      try {
        await dropDatabase(c, name);
        dropped = true;
      } finally {
        await c.end();
      }
    },
  };
}

/** Drops a template database created with a custom templateName (helper for the helper's own tests). */
export async function dropTemplate(templateName: string): Promise<void> {
  if (templateName === DEFAULT_TEMPLATE) throw new Error('refusing to drop the shared template');
  const { adminUrl } = connectionSettings();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await dropDatabase(admin, templateName);
  } finally {
    await admin.end();
  }
}
