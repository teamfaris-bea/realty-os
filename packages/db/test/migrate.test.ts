// Migration runner: lexical order, one transaction per file, checksum bookkeeping, refusal to run
// edited / missing / out-of-order / duplicate-numbered migrations.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, listMigrations, migrate, migrationsHash } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

async function rows<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

describe('migrate()', () => {
  let db: TestDb;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDb({ empty: true });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'realty-mig-'));
    await rows(db.ownerUrl, 'DROP SCHEMA IF EXISTS realty_migrations CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('applies files in lexical order once, recording name and sha256 checksum', async () => {
    writeFileSync(join(dir, '0002_b_second.sql'), 'INSERT INTO log VALUES (2);');
    writeFileSync(join(dir, '0001_a_first.sql'), 'CREATE TABLE log (n int); INSERT INTO log VALUES (1);');
    const r1 = await migrate(db.ownerUrl, dir);
    expect(r1.applied).toEqual(['0001_a_first.sql', '0002_b_second.sql']);
    const r2 = await migrate(db.ownerUrl, dir);
    expect(r2.applied).toEqual([]);
    expect(await rows(db.ownerUrl, 'SELECT n FROM log ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }]);
    const recorded = await rows<{ name: string; checksum: string }>(
      db.ownerUrl,
      'SELECT name, checksum FROM realty_migrations.schema_migrations ORDER BY version',
    );
    expect(recorded.map((r) => r.name)).toEqual(['0001_a_first.sql', '0002_b_second.sql']);
    expect(recorded[0]!.checksum).toBe(listMigrations(dir)[0]!.checksum);
  });

  it('runs each file in one transaction: a failing file leaves nothing behind and is not recorded', async () => {
    writeFileSync(join(dir, '0001_a_ok.sql'), 'CREATE TABLE a (n int);');
    writeFileSync(join(dir, '0002_b_bad.sql'), 'CREATE TABLE b (n int);\nINSERT INTO missing VALUES (1);');
    await expect(migrate(db.ownerUrl, dir)).rejects.toThrow(/0002_b_bad\.sql:2: relation "missing" does not exist/);
    const t = await rows<{ a: string | null; b: string | null }>(db.ownerUrl, `SELECT to_regclass('a')::text AS a, to_regclass('b')::text AS b`);
    expect(t[0]).toEqual({ a: 'a', b: null });
    const recorded = await rows(db.ownerUrl, 'SELECT name FROM realty_migrations.schema_migrations');
    expect(recorded).toEqual([{ name: '0001_a_ok.sql' }]);
  });

  it('refuses an edited applied migration (checksum mismatch)', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (n int);');
    await migrate(db.ownerUrl, dir);
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (n bigint);');
    await expect(migrate(db.ownerUrl, dir)).rejects.toThrow(/was edited \(checksum mismatch\)/);
  });

  it('refuses a missing applied migration and an out-of-order pending one', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0003_c.sql'), 'SELECT 1;');
    await migrate(db.ownerUrl, dir);
    writeFileSync(join(dir, '0002_b.sql'), 'SELECT 1;');
    await expect(migrate(db.ownerUrl, dir)).rejects.toThrow(/sorts before already-applied 0003/);
    unlinkSync(join(dir, '0002_b.sql'));
    unlinkSync(join(dir, '0003_c.sql'));
    await expect(migrate(db.ownerUrl, dir)).rejects.toThrow(/0003_c\.sql is missing/);
  });

  it('rejects duplicate numbers and badly named files before touching the database', () => {
    writeFileSync(join(dir, '0002_api_admin.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0002_api_leads.sql'), 'SELECT 1;');
    expect(() => listMigrations(dir)).toThrow(MigrationError);
    expect(() => listMigrations(dir)).toThrow(/duplicate migration number 0002/);
    rmSync(join(dir, '0002_api_leads.sql'));
    writeFileSync(join(dir, '3_Bad Name.sql'), 'SELECT 1;');
    expect(() => listMigrations(dir)).toThrow(/must match NNNN_<module>_<what>\.sql/);
  });

  it('serializes concurrent runners on one database (each file applied exactly once)', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE once (n int); INSERT INTO once VALUES (1);');
    writeFileSync(join(dir, '0002_b.sql'), 'INSERT INTO once VALUES (2);');
    const results = await Promise.all([migrate(db.ownerUrl, dir), migrate(db.ownerUrl, dir), migrate(db.ownerUrl, dir)]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(await rows(db.ownerUrl, 'SELECT n FROM once ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('the repository migrations are well-formed and hash deterministically', () => {
    const files = listMigrations(MIGRATIONS_DIR);
    expect(files[0]!.name).toBe('0001_init.sql');
    expect(migrationsHash(files)).toBe(migrationsHash(listMigrations(MIGRATIONS_DIR)));
    expect(files.every((f) => !/^\s*\\/m.test(f.sql))).toBe(true); // plain SQL, no psql meta-commands
  });
});
