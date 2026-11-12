// Runs packages/db/test/rls_smoke_cma.sql (the D9 S0 CMA schema step: cma_reports, the listings sale and property
// columns, the integration_connections backfill state and the platform:cma pack) unchanged through runPsqlScript
// against a fresh createTestDb() database, like rls_smoke_gmail_review.test.ts does for its script. The script switches
// to app_user (SET LOCAL ROLE) for every application step and rolls back, so it connects with the owner URL. No test
// names the S0 migration's file: the orchestrator assigns its number at merge.
//
// The geo_cell parity check (R-CMA-1) compares the generated column with geoCellOf() below, a pure copy of the
// migration's expression. core/listings geoCell() belongs to lane V1-A (its owned paths; its tests repeat this parity
// against the core function), so S0 adds no core code and tests the database against this reference instead.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runPsqlScript, type TestDb } from '../src/testing/index.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_cma.sql', import.meta.url)), 'utf8');

/** The S0 rules the script proves (each in at least one passing check). */
const RULES = ['R-CMA-1', 'R-CMA-6', 'R-CMA-7', 'R-CMA-8', 'R-TEN-1', 'R-PERM-11', 'R-PORTAL-1', 'R-INT-6', 'R-DATA-7'];

/** Microdegrees per cell side: about one mile of latitude. */
const CELL_E6 = 14493;
/**
 * The cell of a coordinate pair, as the S0 generated column computes it:
 * ((floor(lat / 14493.0) + 6300) * 25000 + (floor(lon / 14493.0) + 12500))::integer. The division is real, not
 * integer: Math.trunc (like SQL integer division) would put -1 and +1 µ° in the same cell and double the cells at 0.
 */
function geoCellOf(latE6: number | null, lonE6: number | null): number | null {
  if (latE6 === null || lonE6 === null) return null;
  return (Math.floor(latE6 / CELL_E6) + 6300) * 25000 + (Math.floor(lonE6 / CELL_E6) + 12500);
}

/** Coordinates that matter: the poles and the antimeridian, 0, ±1 µ° around it, and both sides of cell edges. */
const TABLE: [number, number][] = [
  [0, 0], [1, 1], [-1, -1], [1, -1], [-1, 1],
  [90_000_000, 180_000_000], [-90_000_000, -180_000_000], [90_000_000, -180_000_000], [-90_000_000, 180_000_000],
  [90_000_000, 0], [-90_000_000, 0], [0, 180_000_000], [0, -180_000_000],
  [CELL_E6, CELL_E6], [CELL_E6 - 1, CELL_E6 - 1], [CELL_E6 + 1, -CELL_E6 - 1], [-CELL_E6, -CELL_E6], [-CELL_E6 + 1, -CELL_E6 + 1],
  [-CELL_E6 - 1, CELL_E6 + 1], [2 * CELL_E6, -2 * CELL_E6], [-2 * CELL_E6 - 1, 2 * CELL_E6 - 1],
  [32_776_500, -79_931_100], [-33_868_800, 151_209_300], [64_146_600, -21_942_600], [-54_801_900, -68_303_000],
  [89_999_999, 179_999_999], [-89_999_999, -179_999_999],
];

describe('rls_smoke_cma.sql (D9 S0: the CMA schema)', () => {
  let db: TestDb;
  let notices: string[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    notices = (await runPsqlScript(db.ownerUrl, SMOKE_SQL)).notices;
  });
  afterAll(async () => {
    await db?.drop();
  });

  /** geo_cell as stored for each pair: rows inserted as the owner with triggers and foreign keys off, then rolled back. */
  async function storedCells(pairs: readonly (readonly [number | null, number | null])[]): Promise<(number | null)[]> {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica'); // no tenant, membership or price-history rows needed
      const { rows } = await c.query<{ n: number; geo_cell: number | null }>(
        `WITH input AS (SELECT * FROM unnest($1::int[], $2::int[]) WITH ORDINALITY AS t(lat, lon, n)),
              stored AS (
                INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id,
                                      latitude_e6, longitude_e6, attributes)
                SELECT gen_random_uuid(), gen_random_uuid(), 'team', 'sold', 'x', 'x', 'SC', '29900', gen_random_uuid(), lat, lon,
                       jsonb_build_object('n', n)
                  FROM input
                RETURNING (attributes->>'n')::int AS n, geo_cell)
         SELECT n, geo_cell FROM stored ORDER BY n`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
      return rows.map((r) => r.geo_cell);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('passes every S0 smoke check: R-CMA-1 R-CMA-6 R-CMA-7 R-CMA-8 R-TEN-1 R-PERM-11 R-PORTAL-1 R-INT-6 R-DATA-7 R-MLS-1 E377', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    const passes = notices.filter((n) => n.startsWith('PASS'));
    expect(passes.length).toBeGreaterThanOrEqual(36);
    expect(passes.at(-1)).toBe('PASS  ALL CMA S0 SMOKE CHECKS PASSED');
  });

  it('proves each S0 rule in at least one passing check', () => {
    for (const rule of RULES) {
      expect(notices.some((n) => n.startsWith('PASS') && new RegExp(`\\b${rule}\\b`).test(n)), rule).toBe(true);
    }
  });

  it('can only fail through pg_temp.fail (one RAISE of FAIL)', () => {
    expect(SMOKE_SQL.match(/RAISE EXCEPTION 'FAIL/g)).toHaveLength(1);
    expect(SMOKE_SQL).toContain('CREATE FUNCTION pg_temp.fail(p_msg text)');
  });

  it('leaves the database unchanged (the script rolls back)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string; reviewed: string }>(
        `SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM users) + (SELECT count(*) FROM cma_reports) AS n,
                (SELECT count(*) FROM jurisdiction_packs WHERE key LIKE 'platform:%' AND reviewed_by_counsel_at IS NOT NULL) AS reviewed`);
      expect(Number(rows[0]!.n)).toBe(0);
      expect(Number(rows[0]!.reviewed)).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('R-CMA-1: the reference cell function folds toward minus infinity and spans the documented range', () => {
    expect(geoCellOf(-1, -1)).not.toBe(geoCellOf(1, 1));
    expect(geoCellOf(-1, 0)).toBe(geoCellOf(0, 0)! - 25000);
    expect(geoCellOf(0, -1)).toBe(geoCellOf(0, 0)! - 1);
    expect(geoCellOf(-90_000_000, -180_000_000)).toBe(2_250_080);
    expect(geoCellOf(90_000_000, 180_000_000)).toBe(312_749_919);
    expect(312_749_919).toBeLessThan(2 ** 31);
    expect(geoCellOf(null, 5)).toBeNull();
  });

  it('R-CMA-1: geo_cell equals the reference geoCell on a coordinate table with negatives, 0, the poles and cell edges', async () => {
    const pairs: [number | null, number | null][] = [...TABLE, [null, null]];
    const cells = await storedCells(pairs);
    expect(cells).toEqual(pairs.map(([lat, lon]) => geoCellOf(lat, lon)));
    // the extremes of the range are the poles at the antimeridian
    expect(Math.min(...cells.filter((x): x is number => x !== null))).toBe(2_250_080);
    expect(Math.max(...cells.filter((x): x is number => x !== null))).toBe(312_749_919);
  });

  it('R-CMA-1: geo_cell equals the reference geoCell on 2,000 random coordinates', async () => {
    const pairs = fc.sample(
      fc.tuple(fc.integer({ min: -90_000_000, max: 90_000_000 }), fc.integer({ min: -180_000_000, max: 180_000_000 })),
      { numRuns: 2000, seed: 20261112 },
    );
    const cells = await storedCells(pairs);
    expect(cells).toEqual(pairs.map(([lat, lon]) => geoCellOf(lat, lon)));
  });
});
