// The release step (docs/DEPLOY.md §3) refuses an app login other than app_user before it changes anything.
// Deploy rehearsal: with DATABASE_URL user realty_app it created that role, applied every migration, then failed
// "permission denied for table tenants", leaving a migrated database and a stray role behind.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoleAlterations, connectionSettings, ensureAppUserRole, withCredentials } from '../src/dbConfig.js';
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
