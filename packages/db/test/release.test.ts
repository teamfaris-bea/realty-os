// The release step (docs/DEPLOY.md §3) refuses an app login other than app_user before it changes anything.
// Deploy rehearsal: with DATABASE_URL user realty_app it created that role, applied every migration, then failed
// "permission denied for table tenants", leaving a migrated database and a stray role behind.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, appRoleAlterations, connectionSettings, ensureAppUserRole, withCredentials, withDatabase } from '../src/dbConfig.js';
import { runRelease } from '../src/release.js';
import { inspectCreateWindow, openCreateWindow } from '../src/rolePreflight.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';
import { type TrialOwner, admin, cleanupTrials, clusterRoleSnapshot, createTrialDb, createTrialOwner, withClient } from './trialOwner.js';

const release = join(dirname(fileURLToPath(import.meta.url)), '../src/scripts/release.ts');
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb({ empty: true });
});
afterAll(async () => {
  await db?.drop();
});

async function one<T extends pg.QueryResultRow>(url: string, q: string, params: unknown[] = []): Promise<T | undefined> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows[0];
  } finally {
    await c.end();
  }
}

describe('release step', () => {
  it('refuses a DATABASE_URL that does not log in as app_user, before creating a role or applying a migration', async () => {
    const role = `realty_app_${process.pid}`;
    const appUrl = new URL(db.ownerUrl);
    appUrl.username = role;
    appUrl.password = 'rehearsal-only-password';
    const r = spawnSync(process.execPath, ['--import', 'tsx', release], { env: { ...process.env, MIGRATION_DATABASE_URL: db.ownerUrl, DATABASE_URL: appUrl.href }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release failed: DATABASE_URL must log in as app_user');
    expect(r.stderr + r.stdout).not.toContain('rehearsal-only-password');
    expect(await one(db.ownerUrl, `SELECT 1 FROM pg_namespace WHERE nspname = 'realty_migrations'`)).toBeUndefined();
    expect(await one(connectionSettings().adminUrl, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).toBeUndefined();
  }, 70_000);
});

// R-DEPLOY-3 (E478): ensureAppUserRole changes only what the owner may change. Run as a throwaway CREATEROLE BYPASSRLS
// owner on a throwaway role name, never the shared app_user.
describe('R-DEPLOY-3: ensureAppUserRole as a non-superuser owner', () => {
  let trial: TrialOwner;
  let trialCdb: TrialOwner;
  let trialDb: string;
  let snapshot: unknown;
  const attrs = (name: string) => admin(async (c) => (await c.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication FROM pg_roles WHERE rolname = $1`, [name])).rows[0]);
  const target = { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false };
  /** a throwaway role with `extra` attributes that `owner` administers */
  const appRole = async (tag: string, extra: string, owners: TrialOwner[]) => {
    const name = `realty_trial_${process.pid}_app_${tag}`;
    await admin(async (c) => {
      await c.query(`CREATE ROLE ${c.escapeIdentifier(name)} ${extra}`);
      for (const o of owners) await c.query(`GRANT ${c.escapeIdentifier(name)} TO ${c.escapeIdentifier(o.name)} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
    });
    return name;
  };
  const ensureAs = (o: TrialOwner, role: string) => withClient(o.url(trialDb), (c) => ensureAppUserRole(c, { user: role, password: 'trial-only-password' }));

  beforeAll(async () => {
    snapshot = await clusterRoleSnapshot();
    trial = await createTrialOwner('owner3', 'CREATEROLE BYPASSRLS');
    trialCdb = await createTrialOwner('owner3cdb', 'CREATEROLE BYPASSRLS CREATEDB');
    trialDb = await createTrialDb(trial, 'ensure');
  }, 60_000);
  afterAll(async () => {
    await cleanupTrials();
    expect(await clusterRoleSnapshot()).toEqual(snapshot);
  }, 60_000);

  it('R-DEPLOY-3 E478: a wrong INHERIT or CREATEROLE is fixed by an owner without CREATEDB or REPLICATION, and LOGIN and the password are set', async () => {
    const role = await appRole('inherit', 'NOLOGIN INHERIT CREATEROLE', [trial]);
    await ensureAs(trial, role);
    expect(await attrs(role)).toEqual(target);
    await withClient(withCredentials(trial.url(trialDb), role, 'trial-only-password'), async (c) => expect((await c.query('SELECT current_user AS u')).rows[0]).toEqual({ u: role }));
  });

  it('R-DEPLOY-3 E478: a wrong CREATEDB is refused for an owner without CREATEDB, naming CREATEDB and the statement to ask for, with nothing changed; an owner with CREATEDB fixes it', async () => {
    const role = await appRole('cdb', 'NOLOGIN CREATEDB INHERIT', [trial, trialCdb]);
    const err = await ensureAs(trial, role).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe('AppRoleAttributeError');
    expect(err?.message).toBe(`${role} has CREATEDB and the owner role cannot remove it (PG16 lets only a role with CREATEDB change it): ask an administrator to run ALTER ROLE ${role} NOCREATEDB`);
    expect(await attrs(role)).toMatchObject({ rolcanlogin: false, rolcreatedb: true, rolinherit: true });
    await ensureAs(trialCdb, role);
    expect(await attrs(role)).toEqual(target);
  });

  it('R-DEPLOY-3 E478: a SUPERUSER app role is refused naming SUPERUSER before any ALTER is attempted', async () => {
    const role = await appRole('su', 'NOLOGIN SUPERUSER', [trial]);
    const err = await ensureAs(trial, role).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe(`${role} has SUPERUSER and the owner role cannot remove it (PG16 lets only a superuser change it): ask an administrator to run ALTER ROLE ${role} NOSUPERUSER`);
    expect(await attrs(role)).toMatchObject({ rolsuper: true, rolcanlogin: false });
  });

  it('R-DEPLOY-3: the pure rule set: a superuser owner may change every attribute; SUPERUSER first, then BYPASSRLS, CREATEDB, REPLICATION by attribute', () => {
    const f = { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false };
    const all = { rolcanlogin: false, rolsuper: true, rolbypassrls: true, rolcreatedb: true, rolcreaterole: true, rolinherit: true, rolreplication: true };
    expect(appRoleAlterations('r', all, { ...f, rolsuper: true })).toEqual(['LOGIN', 'NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEDB', 'NOCREATEROLE', 'NOINHERIT', 'NOREPLICATION']);
    expect(appRoleAlterations('r', { ...f, rolcanlogin: true }, f)).toEqual(['LOGIN']);
    expect(appRoleAlterations('r', { ...f, rolbypassrls: true, rolinherit: true }, { ...f, rolbypassrls: true })).toEqual(['LOGIN', 'NOBYPASSRLS', 'NOINHERIT']);
    expect(() => appRoleAlterations('r', { ...f, rolreplication: true }, { ...f, rolbypassrls: true })).toThrow(/r has REPLICATION .*ALTER ROLE r NOREPLICATION/);
    expect(() => appRoleAlterations('r', { ...f, rolbypassrls: true }, f)).toThrow(/r has BYPASSRLS/);
  });
});

// R-DEPLOY-4 (E479): the release step for a non-superuser CREATEROLE BYPASSRLS owner without CREATEDB, end to end on
// fresh databases it owns. The cluster roles already exist (the test cluster's), so the fixture gives the owner ADMIN
// on them exactly as if it had created them (PG16: ADMIN OPTION, INHERIT FALSE, SET FALSE).
describe('R-DEPLOY-4: the release step as a non-superuser BYPASSRLS owner', () => {
  let owner: TrialOwner;
  let snapshot: unknown;
  const appUrlFor = (database: string) => {
    const s = connectionSettings();
    return withCredentials(withDatabase(s.adminUrl, database), s.appUser.user, s.appUser.password);
  };
  const run = async (database: string, dir = MIGRATIONS_DIR) => {
    const lines: string[] = [];
    const err = await runRelease({ ownerUrl: owner.url(database), appUrl: appUrlFor(database), dir, log: (l) => lines.push(l) }).then(() => null, (e: unknown) => e as Error);
    return { lines, err };
  };
  const catalog = (database: string) =>
    admin(async (c) => ({
      foreignDefiners: (await c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema') AND r.rolname NOT IN ('app_definer','app_retention')`)).rows[0].n,
      definerFns: (await c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.prosecdef AND r.rolname IN ('app_definer','app_retention')`)).rows[0].n,
      createGrants: (await c.query(`SELECT count(*)::int AS n FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.privilege_type = 'CREATE' AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('app_definer','app_retention'))`)).rows[0].n,
      defaultAcl: (await c.query(`SELECT count(*)::int AS n FROM pg_default_acl`)).rows[0].n,
    }), database);

  beforeAll(async () => {
    snapshot = await clusterRoleSnapshot();
    owner = await createTrialOwner('owner', 'CREATEROLE BYPASSRLS NOCREATEDB');
    await admin((c) => c.query(`GRANT app_user, app_definer, app_retention TO ${c.escapeIdentifier(owner.name)} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`));
  }, 60_000);
  afterAll(async () => {
    await cleanupTrials();
    expect(await clusterRoleSnapshot()).toEqual(snapshot);
  }, 60_000);

  it('R-DEPLOY-4 E479: release ok, every SECURITY DEFINER function owned by a definer role, no CREATE grant or default ACL left; a second run prints 0 applied and release ok; a window left open by a crash is closed first', async () => {
    const database = await createTrialDb(owner, 'release');
    const first = await run(database);
    expect(first.err).toBeNull();
    expect(first.lines.slice(0, 4)).toEqual([
      'cluster roles: app_user, app_definer, app_retention present',
      `definer roles: membership granted to ${owner.name} (SET, INHERIT)`,
      'app role: app_user aligned (LOGIN, the password from DATABASE_URL)',
      'schema CREATE window opened for app_definer, app_retention',
    ]);
    const n = first.lines.filter((l) => l.startsWith('applied ')).length;
    expect(n).toBeGreaterThan(50);
    expect(first.lines.slice(-4)).toEqual(['schema CREATE window closed', `migrations: ${n} applied, 0 already applied`, 'post-checks: definer ownership, schema CREATE grants and definer roles ok', 'release ok: app connects as app_user, RLS-bound']);
    const cat = await catalog(database);
    expect(cat).toMatchObject({ foreignDefiners: 0, createGrants: 0, defaultAcl: 0 });
    expect(cat.definerFns).toBeGreaterThan(50);
    expect(first.lines.join('\n')).not.toContain(owner.password);

    const second = await run(database);
    expect(second.err).toBeNull();
    expect(second.lines).toContain(`migrations: 0 applied, ${n} already applied`);
    expect(second.lines.at(-1)).toBe('release ok: app connects as app_user, RLS-bound');
    expect(second.lines).toContain(`definer roles: ${owner.name} is already a member (SET, INHERIT)`);

    // crash path: a window opened by hand (as a run killed inside migrate() leaves it)
    await withClient(owner.url(database), (c) => openCreateWindow(c, () => {}));
    expect((await catalog(database)).createGrants).toBeGreaterThan(0);
    const third = await run(database);
    expect(third.err).toBeNull();
    expect(third.lines[0]).toBe('schema CREATE window left open by an earlier run: closed');
    expect(await catalog(database)).toMatchObject({ createGrants: 0, defaultAcl: 0 });
  }, 300_000);

  it('R-DEPLOY-4 E479: when the last migration fails the release exits with the error and the CREATE window is closed', async () => {
    const database = await createTrialDb(owner, 'fail');
    const dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, '9999_trial_fails.sql'), 'SELECT 1 / 0;\n');
      const r = await run(database, dir);
      expect(r.err?.message).toMatch(/^9999_trial_fails\.sql(:1)?: division by zero$/);
      expect(r.lines.at(-1)).toBe('schema CREATE window closed');
      expect(await catalog(database)).toMatchObject({ createGrants: 0, defaultAcl: 0 });
      expect(await withClient(owner.url(database), (c) => inspectCreateWindow(c))).toEqual({ defaultAcl: false, schemas: [], open: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('R-DEPLOY-4: the superuser path keeps its output: only the applied lines, the migrations count and release ok (the new checks print nothing)', async () => {
    const su = await createTestDb({ empty: true });
    try {
      const s = connectionSettings();
      const r = spawnSync(process.execPath, ['--import', 'tsx', release], { env: { ...process.env, MIGRATION_DATABASE_URL: su.ownerUrl, DATABASE_URL: withCredentials(su.ownerUrl, s.appUser.user, s.appUser.password) }, encoding: 'utf8', timeout: 120_000 });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      const n = lines.length - 2;
      for (const l of lines.slice(0, n)) expect(l).toMatch(/^applied \d{4}_[a-z0-9_-]+\.sql \(\d+ ms\)$/);
      expect(lines.slice(n)).toEqual([`migrations: ${n} applied, 0 already applied`, 'release ok: app connects as app_user, RLS-bound']);
    } finally {
      await su.drop();
    }
  }, 150_000);
});
