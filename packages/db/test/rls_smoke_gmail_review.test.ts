// Runs packages/db/test/rls_smoke_gmail_review.sql (the D2 review fixes: the migration after the D2 one that hardens
// its Gmail and Meta objects) unchanged through runPsqlScript against a fresh createTestDb() database, like
// rls_smoke_gmail.test.ts does for rls_smoke_gmail.sql. The script switches to app_user (SET LOCAL ROLE) for every
// application step and rolls back, so it connects with the owner URL. No test names the fix migration's file: the
// orchestrator may renumber it at merge.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_gmail_review.sql', import.meta.url)), 'utf8');

/** The findings of the D2 post-merge review with a database part (#6: the platform:gmail notes); each check names its finding. */
const FINDINGS = ['D2 review #1', 'D2 review #2', 'D2 review #3', 'D2 review #4', 'D2 review #5', 'D2 review #6'];

describe('rls_smoke_gmail_review.sql (D2 review fixes)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every D2 review check: R-GMAIL-6 R-GMAIL-9 R-GMAIL-12 R-GMAIL-13 R-PAR-12 R-TEN-11 R-INT-3 E201 E220 E221', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(11);
    expect(passes.at(-1)).toBe('PASS  ALL D2 REVIEW FIX SMOKE CHECKS PASSED');
  });

  it('proves each finding of the D2 review in at least one passing check', () => {
    for (const finding of FINDINGS) {
      expect(notices.some((n) => n.startsWith('PASS') && n.includes(`(${finding}`)), finding).toBe(true);
    }
  });

  it('can only fail through pg_temp.fail (the switch that ran every check against the schema without the fixes)', () => {
    expect(SMOKE_SQL.match(/RAISE EXCEPTION 'FAIL/g)).toHaveLength(1);
    expect(SMOKE_SQL).toContain("CREATE FUNCTION pg_temp.fail(p_msg text)");
  });

  it('leaves the database unchanged (the script rolls back)', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string; reviewed: string }>(
        `SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM users) AS n,
                (SELECT count(*) FROM jurisdiction_packs WHERE key LIKE 'platform:%' AND reviewed_by_counsel_at IS NOT NULL) AS reviewed`);
      expect(Number(rows[0]!.n)).toBe(0);
      expect(Number(rows[0]!.reviewed)).toBe(0);
    } finally {
      await c.end();
    }
  });
});
