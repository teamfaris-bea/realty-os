// R-DEPLOY-2 (docs/DATA_MODEL.md §9; DEPLOY §3, §12): the migration owner must not be subject to row-level security.
// Verified on PostgreSQL 16: a CREATEROLE owner without BYPASSRLS fails 0001 at its role block, and if the roles
// already exist its UPDATE on a FORCE-RLS table updates 0 rows, so the 0032/0034/0035/0045 backfills would do
// nothing without an error. These tests run on the local test cluster only, with throwaway realty_trial_<pid>_* roles.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { MigrationError, migrate } from '../src/migrate.js';
import { forceRlsProbe, inspectOwnerRole } from '../src/rolePreflight.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';
import { type TrialOwner, cleanupTrials, clusterRoleSnapshot, createTrialDb, createTrialOwner, withClient } from './trialOwner.js';

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
