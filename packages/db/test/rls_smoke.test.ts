// Port of packages/db/test/rls_smoke.sql (BUILD_PLAN module 7: "Port rls_smoke.sql into Vitest").
// The SQL file stays the single source of the checks; this test runs it unchanged through
// runPsqlScript against a fresh createTestDb() database. The script itself switches to app_user
// (SET LOCAL ROLE) for every application step, so it connects with the owner URL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke.sql', import.meta.url)), 'utf8');
const DATA_MODEL = readFileSync(fileURLToPath(new URL('../../../docs/DATA_MODEL.md', import.meta.url)), 'utf8');

// Rules DATA_MODEL §4 marks as enforced by the database and proven by the smoke suite alone
// ("[DB, smoke]"-style brackets with no core/api part outstanding).
const SMOKE_PROVEN = [
  'R-TEN-1', 'R-TEN-2', 'R-TEN-4', 'R-TEN-8', 'R-TEN-10', 'R-PERM-4', 'R-PERM-7', 'R-PERM-10',
  'R-AUDIT-1', 'R-AUDIT-2', 'R-AUDIT-7', 'R-OWN-2', 'R-OWN-3', 'R-CONSENT-6', 'R-CONSENT-19',
  'R-GATE-1', 'R-AST-1', 'R-DATA-4', 'R-DATA-5',
] as const;

function ruleBrackets(id: string): string[] {
  const section = DATA_MODEL.slice(DATA_MODEL.indexOf('## 4. Business rules'), DATA_MODEL.indexOf('## 5. Edge cases'));
  const part = section.split(/\n(?=- \*\*R-)|\n(?=###)/).find((p) => p.startsWith(`- **${id}**`));
  return part ? [...part.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!) : [];
}

describe('rls_smoke.sql ported to Vitest', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every smoke check on a fresh per-test database: R-TEN-1 R-TEN-2 R-TEN-4 R-TEN-8 R-TEN-10 R-PERM-4 R-PERM-7 R-PERM-10 R-AUDIT-1 R-AUDIT-2 R-AUDIT-7 R-OWN-2 R-OWN-3 R-CONSENT-6 R-CONSENT-19 R-GATE-1 R-AST-1 R-DATA-4 R-DATA-5', async () => {
    const { notices } = await runPsqlScript(db.ownerUrl, SMOKE_SQL);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    expect(passes.length).toBeGreaterThanOrEqual(89 + 1); // 89 checks (DATA_MODEL header) + the final marker
    expect(passes.at(-1)).toBe('PASS  ALL RLS SMOKE CHECKS PASSED');
  });

  it('leaves the database unchanged (the script rolls back)', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM tenants');
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('claims only rules that DATA_MODEL marks as proven by the smoke suite', () => {
    for (const id of SMOKE_PROVEN) {
      const brackets = ruleBrackets(id);
      expect(brackets.some((b) => /\bsmoke\b/.test(b)), `${id} is not marked smoke in DATA_MODEL`).toBe(true);
      expect(brackets.some((b) => /\b(core|api)\b/.test(b)), `${id} also needs core/api tests`).toBe(false);
    }
  });
});
