// Runs packages/db/test/rls_smoke_homeowner.sql (the homeowner-profile migration proof, owner decision D10)
// unchanged through runPsqlScript against a fresh createTestDb() database, like rls_smoke_p23.test.ts. The script
// switches to app_user (SET LOCAL ROLE) for every application step and rolls back. No test names the migration's
// file: the orchestrator renumbers it at merge.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_homeowner.sql', import.meta.url)), 'utf8');

describe('rls_smoke_homeowner.sql (homeowner profiles, D10)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every homeowner smoke check: R-HOME-1 R-HOME-2 R-HOME-3 R-HOME-4 R-HOME-7 R-HOME-8 R-HOME-9 E570 E571 E583 E584 E587 E589', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(45);
    expect(passes.at(-1)).toBe('PASS  ALL HOMEOWNER RLS SMOKE CHECKS PASSED');
  });

  it('E583: the client principal check ran and found rows that exist', () => {
    expect(notices.some((n) => n.startsWith('PASS  R-HOME-8 E583'))).toBe(true);
    expect(notices.some((n) => n.startsWith('PASS  E583: the rows the client could not read do exist'))).toBe(true);
  });

  it('can only fail through pg_temp.fail', () => {
    expect(SMOKE_SQL.match(/RAISE EXCEPTION 'FAIL/g)).toHaveLength(1);
  });

  it('R-HOME-10: the outreach pack ships unreviewed, and the migration leaves no row behind the script', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string; reviewed: Date | null; rules: unknown }>(
        `SELECT (SELECT count(*) FROM homeowner_profiles) + (SELECT count(*) FROM tenants) AS n, reviewed_by_counsel_at AS reviewed, rules
           FROM jurisdiction_packs WHERE key = 'platform:public_records_outreach' AND status = 'published'`);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.n)).toBe(0);
      expect(rows[0]!.reviewed).toBeNull();
      expect(rows[0]!.rules).toEqual({ states: ['SC'] });
    } finally {
      await c.end();
    }
  });
});
