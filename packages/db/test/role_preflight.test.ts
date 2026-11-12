// R-DEPLOY-2 (docs/DATA_MODEL.md §9; DEPLOY §3, §12): the migration owner must not be subject to row-level security.
// Verified on PostgreSQL 16: a CREATEROLE owner without BYPASSRLS fails 0001 at its role block, and if the roles
// already exist its UPDATE on a FORCE-RLS table updates 0 rows, so the 0032/0034/0035/0045 backfills would do
// nothing without an error. These tests run on the local test cluster only, with throwaway realty_trial_<pid>_* roles.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, connectionSettings, withCredentials, withDatabase } from '../src/dbConfig.js';
import { runRelease } from '../src/release.js';
import { runPreflight } from '../src/scripts/preflight.js';
import { MigrationError, migrate } from '../src/migrate.js';
import { forceRlsProbe, inspectOwnerRole } from '../src/rolePreflight.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';
import { type TrialOwner, admin, cleanupTrials, clusterRoleSnapshot, createTrialDb, createTrialOwner, withClient } from './trialOwner.js';

let before: unknown;
let noBypass: TrialOwner;
let bypass: TrialOwner;
let noBypassDb: string;
let bypassDb: string;
let su: TestDb;

beforeAll(async () => {
  before = await clusterRoleSnapshot();
  noBypass = await createTrialOwner('nobypass', 'CREATEROLE NOBYPASSRLS');
  bypass = await createTrialOwner('bypass', 'CREATEROLE BYPASSRLS');
  noBypassDb = await createTrialDb(noBypass, 'nobypass');
  bypassDb = await createTrialDb(bypass, 'bypass');
  su = await createTestDb({ empty: true });
}, 60_000);

afterAll(async () => {
  await su?.drop();
  await cleanupTrials();
  expect(await clusterRoleSnapshot()).toEqual(before);
}, 60_000);

describe('R-DEPLOY-2: the migration owner bypasses row-level security', () => {
  it('R-DEPLOY-2 E475: migrate() refuses a CREATEROLE owner without BYPASSRLS on a fresh database before any write: no realty_migrations schema, nothing applied, the message names the role and not the URL', async () => {
    let err: unknown;
    try {
      await migrate(noBypass.url(noBypassDb), MIGRATIONS_DIR);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    const msg = (err as Error).message;
    expect(msg).toBe(`the migration role ${noBypass.name} is subject to row-level security (not superuser, no BYPASSRLS): migration backfills would update zero rows under FORCE RLS, and 0001 cannot create the BYPASSRLS roles; nothing was applied`);
    expect(msg).not.toContain(noBypass.password);
    expect(msg).not.toContain('localhost');
    await withClient(noBypass.url(noBypassDb), async (c) => {
      expect((await c.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'realty_migrations'`)).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM pg_namespace WHERE nspname IN ('app', 'auth')`)).rowCount).toBe(0);
    });
  });

  it('R-DEPLOY-2 E475: an owner that became subject to RLS after migrating keeps read-only runs (nothing pending) and is refused once a file is pending', async () => {
    // the superuser migrates a database, which the non-bypass role then owns
    await migrate(su.ownerUrl, MIGRATIONS_DIR);
    const dbName = new URL(su.ownerUrl).pathname.slice(1);
    await withClient(su.ownerUrl, async (c) => {
      await c.query(`GRANT CREATE ON DATABASE ${c.escapeIdentifier(dbName)} TO ${c.escapeIdentifier(noBypass.name)}`);
      await c.query(`GRANT ALL ON SCHEMA realty_migrations TO ${c.escapeIdentifier(noBypass.name)}`);
      await c.query(`GRANT SELECT ON realty_migrations.schema_migrations TO ${c.escapeIdentifier(noBypass.name)}`);
    });
    const url = noBypass.url(dbName);
    const r = await migrate(url, MIGRATIONS_DIR);
    expect(r.applied).toEqual([]);
    await withClient(su.ownerUrl, (c) => c.query(`DELETE FROM realty_migrations.schema_migrations WHERE version = (SELECT max(version) FROM realty_migrations.schema_migrations)`));
    await expect(migrate(url, MIGRATIONS_DIR)).rejects.toThrow(`the migration role ${noBypass.name} is subject to row-level security`);
  }, 120_000);

  it('R-DEPLOY-2 E476: the TEMP-table FORCE-RLS probe updates 0 rows for the non-bypass owner and 1 for a BYPASSRLS owner and for the superuser; it leaves nothing behind', async () => {
    const failed = await withClient(noBypass.url(noBypassDb), (c) => forceRlsProbe(c));
    expect(failed).toEqual({ ok: false, reason: 'the FORCE-RLS update probe updated 0 rows, not 1' });
    expect(await withClient(bypass.url(bypassDb), (c) => forceRlsProbe(c))).toEqual({ ok: true });
    expect(await withClient(su.ownerUrl, (c) => forceRlsProbe(c))).toEqual({ ok: true });
    await withClient(bypass.url(bypassDb), async (c) => {
      expect((await c.query(`SELECT 1 FROM pg_class WHERE relname = 'realty_rls_probe'`)).rowCount).toBe(0);
    });
  });

  it('R-DEPLOY-2: inspectOwnerRole reads the owner attributes, CREATE on and ownership of the database, and its standing towards each cluster role', async () => {
    const o = await withClient(bypass.url(bypassDb), (c) => inspectOwnerRole(c));
    expect(o).toMatchObject({ role: bypass.name, su: false, bypass: true, createrole: true, createdb: false, replication: false, createOnDatabase: true, ownsDatabase: true });
    for (const r of ['app_user', 'app_definer', 'app_retention'] as const) expect(o.roles[r]).toMatchObject({ exists: true, admin: false, set: false, usage: false });
    const s = await withClient(su.ownerUrl, (c) => inspectOwnerRole(c));
    expect(s.su).toBe(true);
  });
});

describe('R-DEPLOY-4 E477: the release step refuses an owner that lacks what it needs, with nothing changed', () => {
  const appUrlFor = (database: string) => {
    const s = connectionSettings();
    return withCredentials(withDatabase(s.adminUrl, database), s.appUser.user, s.appUser.password);
  };
  const state = (database: string) =>
    admin(async (c) => ({
      schemas: (await c.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('realty_migrations','app','auth') ORDER BY 1`)).rows,
      members: (await c.query(`SELECT count(*)::int AS n FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname LIKE 'realty_trial_%' AND am.set_option`)).rows[0],
    }), database);

  it('E477: a BYPASSRLS owner without ADMIN on the existing app_definer is refused, naming the role and the grant to ask for', async () => {
    const database = await createTrialDb(bypass, 'noadmin');
    await admin((c) => c.query(`GRANT app_user, app_retention TO ${c.escapeIdentifier(bypass.name)} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`));
    const before = await state(database);
    const lines: string[] = [];
    const err = await runRelease({ ownerUrl: bypass.url(database), appUrl: appUrlFor(database), dir: MIGRATIONS_DIR, log: (l) => lines.push(l) }).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe('RolePreflightError');
    expect(err?.message).toContain(`the migration role ${bypass.name} lacks ADMIN OPTION on the existing role app_definer`);
    expect(err?.message).toContain(`GRANT app_definer TO ${bypass.name} WITH ADMIN OPTION`);
    expect(err?.message).not.toContain('app_retention');
    expect(err?.message).toMatch(/nothing was changed$/);
    expect(lines).toEqual([]);
    expect(await state(database)).toEqual(before);
  });

  it('E477: a BYPASSRLS owner without CREATE on the database is refused, naming CREATE on the database', async () => {
    const lacking = await createTrialOwner('nocreate', 'CREATEROLE BYPASSRLS');
    await admin((c) => c.query(`GRANT app_user, app_definer, app_retention TO ${c.escapeIdentifier(lacking.name)} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`));
    const database = await createTrialDb(noBypass, 'notowned'); // owned by another role: no CREATE for `lacking`
    const before = await state(database);
    const err = await runRelease({ ownerUrl: lacking.url(database), appUrl: appUrlFor(database), dir: MIGRATIONS_DIR, log: () => {} }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe(`the migration role ${lacking.name} lacks CREATE on the database: 0001 creates schemas and extensions (ask an administrator to run GRANT CREATE ON DATABASE <database> TO ${lacking.name}, or make it the database owner); nothing was changed`);
    expect(await state(database)).toEqual(before);
  });

  it('R-DEPLOY-2 E475: the release step refuses the non-bypass owner before any change, with no bookkeeping schema created', async () => {
    const err = await runRelease({ ownerUrl: noBypass.url(noBypassDb), appUrl: appUrlFor(noBypassDb), dir: MIGRATIONS_DIR, log: () => {} }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain(`the migration role ${noBypass.name} is subject to row-level security`);
    expect((await state(noBypassDb)).schemas).toEqual([]);
  });
});

describe('R-DEPLOY-2 R-DEPLOY-4: the read-only preflight CLI', () => {
  const catalogs = (database: string) =>
    admin(async (c) => ({
      roles: (await c.query(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles ORDER BY 1`)).rows,
      members: (await c.query(`SELECT roleid, member, admin_option, inherit_option, set_option FROM pg_auth_members ORDER BY 1, 2`)).rows,
      namespaces: (await c.query(`SELECT nspname, nspowner, nspacl::text FROM pg_namespace ORDER BY 1`)).rows,
      defaultAcl: (await c.query(`SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY 1, 2, 3`)).rows,
      extensions: (await c.query(`SELECT extname FROM pg_extension ORDER BY 1`)).rows,
    }), database);
  const run = async (argv: string[], ownerUrl: string | undefined, appUrl?: string) => {
    const out: string[] = [];
    const code = await runPreflight(argv, { ownerUrl, appUrl, out: (l) => out.push(l) });
    return { code, out };
  };

  it('R-DEPLOY-4: --trial on a throwaway database reports every capability for a BYPASSRLS owner of it and leaves pg_roles, pg_auth_members, pg_namespace, pg_default_acl and the extensions identical', async () => {
    const database = await createTrialDb(bypass, 'trial');
    const before = await catalogs(database);
    const r = await run(['--trial'], bypass.url(database));
    expect(r.out).toEqual([
      'trial: server version 16 or later: ok',
      'trial: CREATE on the database: ok',
      'trial: create a NOLOGIN BYPASSRLS role: ok',
      'trial: grant it to the owner WITH INHERIT, SET: ok',
      'trial: create a schema with CREATE for that role: ok',
      'trial: move a SECURITY DEFINER function to that role: ok',
      'trial: FORCE-RLS update probe: ok',
      'trial: CREATE EXTENSION IF NOT EXISTS pgcrypto: ok',
      'trial: CREATE EXTENSION IF NOT EXISTS pg_trgm: ok',
      'trial: CREATE EXTENSION IF NOT EXISTS citext: ok',
      'preflight ok',
    ]);
    expect(r.code).toBe(0);
    expect(await catalogs(database)).toEqual(before);
  });

  it('R-DEPLOY-2 E475 E476: --trial and --owner for the non-bypass owner fail, naming the check, and change nothing', async () => {
    const before = await catalogs(noBypassDb);
    const t = await run(['--trial'], noBypass.url(noBypassDb));
    expect(t.code).toBe(1);
    expect(t.out).toContain('trial: create a NOLOGIN BYPASSRLS role: failed: SQLSTATE 42501');
    expect(t.out).toContain('trial: grant it to the owner WITH INHERIT, SET: not checked: create a NOLOGIN BYPASSRLS role failed');
    expect(t.out).toContain('trial: FORCE-RLS update probe: failed: the FORCE-RLS update probe updated 0 rows, not 1');
    const o = await run(['--owner'], noBypass.url(noBypassDb));
    expect(o.out[0]).toBe(`owner bypasses row-level security: failed: the migration role ${noBypass.name} is subject to row-level security (not superuser, no BYPASSRLS): migration backfills would update zero rows under FORCE RLS, and 0001 cannot create the BYPASSRLS roles; nothing was applied`);
    expect(o.out.at(-1)).toBe('preflight failed: 2 checks');
    expect(o.out.join('\n')).not.toContain(noBypass.password);
    expect(await catalogs(noBypassDb)).toEqual(before);
  });

  it('R-DEPLOY-1: --app before the first release reports the app checks not checked, never ok; a missing URL and an unreachable host fail by variable and code only', async () => {
    const s = connectionSettings();
    const app = withCredentials(withDatabase(s.adminUrl, bypassDb), s.appUser.user, s.appUser.password);
    const r = await run(['--app'], undefined, app);
    expect(r.out).toEqual(['app role checks: not checked: SQLSTATE 42P01: the schema is not migrated yet (run the release step first)', 'preflight ok']);
    const missing = await run(['--owner'], undefined);
    expect(missing.out).toEqual(['owner connection: failed: MIGRATION_DATABASE_URL is not set', 'preflight failed: 1 checks']);
    const down = await run(['--app'], undefined, 'postgres://app_user:secret-pw@127.0.0.1:1/realty');
    expect(down.out[0]).toBe('app connection: failed: cannot connect with DATABASE_URL: ECONNREFUSED');
    expect(down.out.join('\n')).not.toMatch(/secret-pw|127\.0\.0\.1/);
    expect(await run(['--bogus'], undefined)).toEqual({ code: 1, out: ['preflight failed: unknown option --bogus (use --owner, --app, --trial)'] });
  });
});
