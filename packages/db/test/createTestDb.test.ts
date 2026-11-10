// The per-test database helper: isolation, the RLS-bound app_user URL, concurrency, template rebuild
// on a migrations content-hash change (advisory-locked, exactly one rebuild under contention).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, dropTemplate, hashTemplateName, type TestDb } from '../src/testing/index.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrationsHash } from '../src/migrate.js';

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

describe('createTestDb', () => {
  const created: TestDb[] = [];
  afterAll(async () => {
    await Promise.all(created.map((d) => d.drop()));
  });

  it('gives each caller its own fully migrated database, also when called concurrently', async () => {
    const dbs = await Promise.all([createTestDb(), createTestDb(), createTestDb(), createTestDb()]);
    created.push(...dbs);
    expect(new Set(dbs.map((d) => d.name)).size).toBe(4);
    for (const d of dbs) {
      const rows = await query<{ name: string }>(d.ownerUrl, 'SELECT name FROM realty_migrations.schema_migrations ORDER BY version');
      expect(rows.map((r) => r.name)).toContain('0001_init.sql');
    }
    // writes in one database are invisible in another
    await query(dbs[0]!.ownerUrl, `CREATE TABLE public.only_here (x int)`);
    const elsewhere = await query<{ n: string }>(dbs[1]!.ownerUrl, `SELECT count(*) AS n FROM pg_class WHERE relname = 'only_here'`);
    expect(Number(elsewhere[0]!.n)).toBe(0);
  });

  it('appUserUrl connects as the RLS-bound app_user, which sees no tenant rows without context', async () => {
    const d = await createTestDb();
    created.push(d);
    const rows = await query<{ who: string; sup: boolean; bypass: boolean; n: string }>(
      d.appUserUrl,
      `SELECT current_user AS who, r.rolsuper AS sup, r.rolbypassrls AS bypass, (SELECT count(*) FROM tenants) AS n
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ who: 'app_user', sup: false, bypass: false, n: '0' });
    await expect(query(d.appUserUrl, `INSERT INTO tenants (id) VALUES (gen_random_uuid())`)).rejects.toThrow();
  });

  it('drop() removes the database and is idempotent', async () => {
    const d = await createTestDb();
    await d.drop();
    await d.drop();
    const { adminUrl } = await import('../src/dbConfig.js').then((m) => m.connectionSettings());
    const rows = await query<{ n: string }>(adminUrl, `SELECT count(*) AS n FROM pg_database WHERE datname = '${d.name}'`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('rebuilds the template exactly once when the migrations content hash changes, even under concurrency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const templateName = `realty_template_selftest_${process.pid}_${Date.now().toString(36)}`;
    try {
      writeFileSync(join(dir, '0001_selftest_base.sql'), 'CREATE TABLE selftest_a (id int PRIMARY KEY);\n');
      const first = await Promise.all([1, 2, 3].map(() => createTestDb({ migrationsDir: dir, templateName })));
      created.push(...first);
      expect(first.filter((d) => d.templateRebuilt)).toHaveLength(1);

      const again = await createTestDb({ migrationsDir: dir, templateName });
      created.push(again);
      expect(again.templateRebuilt).toBe(false);

      writeFileSync(join(dir, '0002_selftest_more.sql'), 'CREATE TABLE selftest_b (id int PRIMARY KEY);\n');
      const second = await Promise.all([1, 2, 3].map(() => createTestDb({ migrationsDir: dir, templateName })));
      created.push(...second);
      expect(second.filter((d) => d.templateRebuilt)).toHaveLength(1);
      for (const d of second) {
        const rows = await query<{ t: string }>(d.ownerUrl, `SELECT to_regclass('public.selftest_b')::text AS t`);
        expect(rows[0]!.t).toBe('selftest_b');
      }

      // editing a file also changes the hash
      writeFileSync(join(dir, '0002_selftest_more.sql'), 'CREATE TABLE selftest_c (id int PRIMARY KEY);\n');
      const third = await createTestDb({ migrationsDir: dir, templateName });
      created.push(third);
      expect(third.templateRebuilt).toBe(true);
      const rows = await query<{ b: string | null; c: string | null }>(
        third.ownerUrl,
        `SELECT to_regclass('public.selftest_b')::text AS b, to_regclass('public.selftest_c')::text AS c`,
      );
      expect(rows[0]).toEqual({ b: null, c: 'selftest_c' });
    } finally {
      await dropTemplate(templateName);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a broken migration fails clearly and leaves no half-built template behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const templateName = `realty_template_selftest_bad_${process.pid}_${Date.now().toString(36)}`;
    try {
      writeFileSync(join(dir, '0001_selftest_bad.sql'), 'CREATE TABLE ok_one (id int);\nSELEC broken;\n');
      await expect(createTestDb({ migrationsDir: dir, templateName })).rejects.toThrow(/0001_selftest_bad\.sql:2/);
      const { adminUrl } = await import('../src/dbConfig.js').then((m) => m.connectionSettings());
      const rows = await query<{ n: string }>(adminUrl, `SELECT count(*) AS n FROM pg_database WHERE datname = '${templateName}'`);
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await dropTemplate(templateName);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the default template after the migrations hash, so different checkouts never share one', async () => {
    const d = await createTestDb();
    created.push(d);
    const hash = migrationsHash(listMigrations(MIGRATIONS_DIR));
    const { adminUrl } = await import('../src/dbConfig.js').then((m) => m.connectionSettings());
    const rows = await query<{ marker: string | null }>(
      adminUrl,
      `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = '${hashTemplateName(hash)}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.marker).toMatch(new RegExp(`^realty-template migrations-sha256=${hash} built=\\d+$`));
  });

  it('drops hash templates built more than 3 days ago, and only those', async () => {
    const { adminUrl } = await import('../src/dbConfig.js').then((m) => m.connectionSettings());
    const stale = 'realty_template_000000000000';
    const fresh = 'realty_template_00000000000f';
    for (const [name, built] of [[stale, 1], [fresh, Date.now()]] as const) {
      await query(adminUrl, `DROP DATABASE IF EXISTS ${name}`);
      await query(adminUrl, `CREATE DATABASE ${name} TEMPLATE template0`);
      await query(adminUrl, `COMMENT ON DATABASE ${name} IS 'realty-template migrations-sha256=x built=${built}'`);
    }
    try {
      const d = await createTestDb();
      created.push(d);
      const rows = await query<{ datname: string }>(adminUrl, `SELECT datname FROM pg_database WHERE datname IN ('${stale}', '${fresh}')`);
      expect(rows.map((r) => r.datname)).toEqual([fresh]);
    } finally {
      await query(adminUrl, `DROP DATABASE IF EXISTS ${stale}`);
      await query(adminUrl, `DROP DATABASE IF EXISTS ${fresh}`);
    }
  });

  it('empty: true clones template0 with no migrations applied', async () => {
    const d = await createTestDb({ empty: true });
    created.push(d);
    const rows = await query<{ t: string | null }>(d.ownerUrl, `SELECT to_regclass('public.tenants')::text AS t`);
    expect(rows[0]!.t).toBeNull();
  });
});
