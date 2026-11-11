// Runs packages/db/test/rls_smoke_gmail.sql (the D2 migration proof: Meta publishing only, Gmail inbox sync)
// unchanged through runPsqlScript against a fresh createTestDb() database, like rls_smoke_p23.test.ts does for
// rls_smoke_p23.sql. The script switches to app_user (SET LOCAL ROLE) for every application step and rolls back,
// so it connects with the owner URL. Rule ids are named here only where the SQL proves the rule as DATA_MODEL §9
// states it. R-GMAIL-10 (live inbound pauses automation) is enforced by the API alone, so it is not listed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_gmail.sql', import.meta.url)), 'utf8');

/** Every D2 rule with a database part (DATA_MODEL §9 "Gmail inbox sync" and R-MKT-12). */
const DB_RULES = [
  'R-GMAIL-1', 'R-GMAIL-2', 'R-GMAIL-3', 'R-GMAIL-4', 'R-GMAIL-5', 'R-GMAIL-6', 'R-GMAIL-7', 'R-GMAIL-8', 'R-GMAIL-9',
  'R-GMAIL-11', 'R-GMAIL-12', 'R-GMAIL-13', 'R-GMAIL-14', 'R-MKT-12',
];

/** Every security-review finding on the D2 migration that changed the schema (S-D2-7 and S-D2-8 a-c were docs-only). */
const REVIEW_FINDINGS = ['S-D2-1', 'S-D2-2', 'S-D2-3', 'S-D2-4', 'S-D2-5', 'S-D2-6', 'S-D2-8'];

describe('rls_smoke_gmail.sql (D2: Meta publishing only, Gmail inbox sync)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every D2 smoke check: R-GMAIL-1 R-GMAIL-2 R-GMAIL-3 R-GMAIL-4 R-GMAIL-5 R-GMAIL-6 R-GMAIL-7 R-GMAIL-8 R-GMAIL-9 R-GMAIL-11 R-GMAIL-12 R-GMAIL-13 R-GMAIL-14 R-MKT-12 R-DATA-7 R-TEN-1 R-TEN-2 S-D2-1 S-D2-2 S-D2-3 S-D2-4 S-D2-5 S-D2-6 S-D2-8 E201 E203 E204 E208 E209 E210 E211 E212 E215 E216 E220 E221 E222 E223 E224 E225 E227 E228 E229', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(187);
    expect(passes.at(-1)).toBe('PASS  ALL D2 GMAIL RLS SMOKE CHECKS PASSED');
  });

  it('proves every database-enforced D2 rule in at least one passing check', () => {
    for (const id of DB_RULES) {
      expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${id}\\b(?!-?\\d)`).test(n)), id).toBe(true);
    }
  });

  it('proves every schema fix of the D2 security review in at least one passing check', () => {
    for (const id of REVIEW_FINDINGS) {
      expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${id}\\b(?!-?\\d)`).test(n)), id).toBe(true);
    }
  });

  it('covers cross-tenant denial for every new table', () => {
    expect(notices.some((n) => n.startsWith('PASS') && n.includes('cross-tenant denial') && n.includes('every D2 table'))).toBe(true);
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
