// Re-runs the self-check block of 0001_init.sql (§22) against a database with ALL migrations applied,
// so a later migration that adds a table without FORCE RLS, without the RESTRICTIVE tenant_isolation
// policy, without tenant_id leading the PK, or a SECURITY DEFINER function without a pinned
// search_path / reviewed owner fails the test suite (R-TEN-1 R-TEN-4 R-TEN-5 R-AUDIT-7 invariants).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const init = readFileSync(`${MIGRATIONS_DIR}/0001_init.sql`, 'utf8');
const marker = init.indexOf('-- 22. Self-checks');
const selfCheck = init.slice(init.indexOf('DO $$', marker));

describe('schema invariants after all migrations', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('extracts the 0001 self-check block', () => {
    expect(marker).toBeGreaterThan(0);
    expect(selfCheck).toMatch(/SCHEMA SELF-CHECK FAILED/);
  });

  it('0001 §22 self-check holds for the whole migrated schema (R-TEN-5)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      await expect(c.query(selfCheck)).resolves.toBeDefined();
    } finally {
      await c.end();
    }
  });

  it('detects a violating table (the check is live, not vacuous)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE TABLE public.bad_tenant_table (tenant_id uuid NOT NULL, id uuid, PRIMARY KEY (tenant_id, id))');
      await expect(c.query(selfCheck)).rejects.toThrow(/rls:bad_tenant_table.*tenant_policy:bad_tenant_table/);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});
