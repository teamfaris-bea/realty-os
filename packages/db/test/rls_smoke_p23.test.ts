// Runs packages/db/test/rls_smoke_p23.sql (the 0018 Phase 2-3 schema proof) unchanged through runPsqlScript
// against a fresh createTestDb() database, like rls_smoke.test.ts does for rls_smoke.sql. The script switches
// to app_user (SET LOCAL ROLE) for every application step and rolls back, so it connects with the owner URL.
// Rule ids are named here only where the SQL proves the rule as DATA_MODEL §9 states it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_p23.sql', import.meta.url)), 'utf8');

describe('rls_smoke_p23.sql (0018 Phase 2-3 schema)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every Phase 2-3 smoke check: R-INT-3 R-INT-6 R-CHAN-2 R-CHAN-4 R-INBOX-3 R-MLS-1 R-MKT-1 R-MKT-2 R-MKT-5 R-MKT-8 R-FH-1 R-NURT-1 R-AST-21 R-SELL-3 R-TXN-1 R-TXN-5 R-CAL-1 R-OWNER-5 R-VOICE-1 R-VOICE-2 R-VOICE-4 R-VOICE-9 R-COACH-3 R-PRED-1 R-PRED-5 R-ADS-1 R-ADS-2 R-ADS-3 R-DOC-3 R-DOC-4 R-DATA-7 R-PORTAL-1 R-PORTAL-2 R-PORTAL-3 R-PORTAL-5 R-PORTAL-6 E76 E129 E140 E144 E147 E150', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(175);
    expect(passes.at(-1)).toBe('PASS  ALL PHASE 2-3 RLS SMOKE CHECKS PASSED');
  });

  it('R-PORTAL-1 E129: the generated client sweep covered every table outside the allowlist', () => {
    expect(notices.some((n) => n.startsWith('PASS  R-PORTAL-1 E129'))).toBe(true);
    expect(notices.some((n) => n.includes('cross-tenant denial'))).toBe(true);
    expect(notices.some((n) => n.includes('cross-deal denial'))).toBe(true);
  });

  it('covers every round-2 review finding with at least one adversarial case', () => {
    // ARCHITECTURE §20 "Phase 2-3 design review, round 2": each applied finding is proven by name in the SQL
    for (const id of ['S1', 'S2', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'F4', 'F9', 'F14']) {
      expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${id}\\b`).test(n)), id).toBe(true);
    }
  });

  it('leaves the database unchanged (the script rolls back)', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string }>('SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM prediction_models) AS n');
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await c.end();
    }
  });
});
