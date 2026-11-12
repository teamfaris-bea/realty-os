// Runs packages/db/test/rls_smoke_ads.sql (the platform:ads pack and its two SECURITY INVOKER gates, module 52)
// unchanged through runPsqlScript against a fresh createTestDb() database, like rls_smoke_p23.test.ts does for
// rls_smoke_p23.sql. The script switches to app_user (SET LOCAL ROLE) for every application step and rolls back, so it
// connects with the owner URL. No test names the migration's file: the orchestrator renumbers it at merge.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_ads.sql', import.meta.url)), 'utf8');

/** Each rule and edge case the script proves, named in at least one passing check. */
const IDS = ['R-ADS-7', 'R-ADS-8', 'R-ADS-9', 'R-ADS-10', 'E440', 'E441', 'E442', 'E443', 'E444', 'E455'];

describe('rls_smoke_ads.sql (platform:ads and its gates)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('passes every ads pack check: R-ADS-7 R-ADS-8 R-ADS-9 R-ADS-10 E440 E441 E442 E443 E444 E455', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(40);
    expect(passes.at(-1)).toBe('PASS  ALL ADS PACK SMOKE CHECKS PASSED');
  });

  it('proves each rule and edge case in at least one passing check', () => {
    for (const id of IDS) expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${id}\\b`).test(n)), id).toBe(true);
  });

  it('R-ADS-7: leaves the database unchanged and the pack unreviewed (the script rolls back)', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string; reviewed: string | null; vendor: string | null }>(
        `SELECT (SELECT count(*) FROM tenants) AS n, reviewed_by_counsel_at AS reviewed, rules->>'vendor_ready_at' AS vendor
           FROM jurisdiction_packs WHERE key = 'platform:ads'`);
      expect(rows).toEqual([{ n: '0', reviewed: null, vendor: null }]);
    } finally {
      await c.end();
    }
  });
});
