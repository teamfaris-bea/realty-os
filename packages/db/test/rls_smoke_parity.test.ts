// Runs packages/db/test/rls_smoke_parity.sql (the FUB parity schema proof) unchanged through runPsqlScript
// against a fresh createTestDb() database, like rls_smoke_p23.test.ts. The script switches to app_user
// (SET LOCAL ROLE) for every application step and rolls back, so it connects with the owner URL.
// Rule ids are named here only where the SQL proves the rule as DATA_MODEL §13 states it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_parity.sql', import.meta.url)), 'utf8');

describe('rls_smoke_parity.sql (FUB parity schema)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every parity smoke check: R-PAR-1 R-PAR-2 R-PAR-3 R-PAR-4 R-PAR-6 R-PAR-7 R-PAR-8 R-PAR-9 R-PAR-11 R-PAR-12 R-PAR-13 R-PAR-14 R-PAR-15 R-PAR-17 R-PAR-18 R-PAR-19 E165 E168 E169 E170 E171 E177 E181 E184 E185 E189 E192 R-PAR-21 R-PAR-23 R-PAR-24 R-PAR-26 R-PAR-27 R-PAR-28 R-PAR-30 R-PAR-31 R-PAR-32 R-PAR-33 R-PAR-34 R-PAR-35 R-PAR-36 R-PAR-37 R-PAR-38 R-PAR-39 R-PAR-40', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(85);
    expect(passes.at(-1)).toBe('PASS  ALL FUB PARITY RLS SMOKE CHECKS PASSED');
  });

  it('a contact\'s tags, notes and custom field values are visible exactly when the contact is, for every role', () => {
    for (const probe of [
      'agent 2 sees Carol\'s tags and not Alice\'s',
      'the Team Lead sees the tags of the team\'s people',
      'the TC sees only Alice\'s tag',
      'the Admin sees every contact\'s tags',
      'is not notified and cannot read the note',
      'the TC on Alice\'s deal reads her notes',
      'agent 2 reads the field definitions but none of Alice\'s values',
      'the TC reads Alice\'s values through her deal',
      'tenant B reads none of tenant A\'s tags',
      'tenant B reads none of tenant A\'s fields or values',
      'reads 0 tenant A rows from every parity table',
    ]) {
      expect(notices.some((n) => n.startsWith('PASS') && n.includes(probe)), probe).toBe(true);
    }
  });

  it('covers every applied security-review finding with at least one adversarial case (ARCHITECTURE §20, FUB parity review)', () => {
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
      expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${id}\\b`).test(n)), id).toBe(true);
    }
  });

  it('leaves the database unchanged (the script rolls back)', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string }>('SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM tags) AS n');
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await c.end();
    }
  });
});
