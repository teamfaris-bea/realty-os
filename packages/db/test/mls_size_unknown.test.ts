// R-MLS-7, the database part (migration *_mls_size_unknown; E640). Rows stored before the migration with a size that
// cannot be finished living area lose that size and its source: a size read from BuildingAreaTotal (any field of
// core SIZE_FIELDS_NEVER_USED) on any connection, and every size of a Spark connection (its mapping read
// BuildingAreaTotal from the start, and rows stored before size_source existed carry no source). Sizes from anywhere
// else are untouched: team listings (agent-entered), other feeds' LivingArea sizes, lot sizes. Afterwards the
// database refuses a never-used field as a size source. Fixtures are written by the superuser with triggers off
// (connections and MLS rows are the system's to write); the migration itself runs as the owner, triggers on.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIZE_FIELDS_NEVER_USED } from '@realty/core/listings';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { type TestDb, createTestDb } from '../src/testing/index.js';
import { createWorld, suFixture, suRows, uuid, type World } from './world.js';

const THIS_MIGRATION = /_mls_size_unknown\.sql$/;

interface Conn {
  spark: string;
  other: string;
}

/** A Spark connection (external account 'spark:<id>', as saveSparkCredential sets it) and another feed's; a disconnected Spark connection keeps its id. */
async function connections(su: pg.Pool, w: World, sparkDisconnected = false): Promise<Conn> {
  const c = { spark: uuid(), other: uuid() };
  await suFixture(
    su,
    `INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, disconnected_at)
     VALUES ($1, $2, 'mls_feed', $6, 'MLS (Spark, read-only)', $3, $7::timestamptz), ($1, $4, 'mls_feed', 'not_configured', 'Test MLS feed', $5, NULL)`,
    [w.tenantId, c.spark, `spark:${c.spark}`, c.other, `test:${c.other}`, sparkDisconnected ? 'disconnected' : 'not_configured', sparkDisconnected ? new Date().toISOString() : null],
  );
  return c;
}

/** One MLS row (superuser fixture, triggers off), as the sync stored it. Returns its id. */
async function mlsRow(su: pg.Pool, w: World, conn: string, o: { n: string; sqft: number | null; sizeSource: string | null; version: 1 | 2 }): Promise<string> {
  const id = uuid();
  await suFixture(
    su,
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                           property_type, mls_connection_id, mls_modified_at, listing_brokerage_name, lot_sqft, size_source, mls_normalize_version)
     VALUES ($1, $2, 'mls', $3, 'sold', '1 Sample Rd', 'Exampleton', 'ZZ', '00000', 40000000, 3, 20, $4, 'single_family', $5,
             '2026-11-10T10:00:00Z', 'Other Brokerage (test)', 6534, $6, $7)`,
    [w.tenantId, id, o.n, o.sqft, conn, o.sizeSource, o.version],
  );
  return id;
}

async function teamRow(su: pg.Pool, w: World, sqft: number): Promise<string> {
  const id = uuid();
  await suFixture(
    su,
    `INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, list_price_cents, beds, sqft, listing_agent_user_id)
     VALUES ($1, $2, 'team', 'active', '12 Sample St', 'Exampleton', 'ZZ', '00000', 72500000, 3, $3, $4)`,
    [w.tenantId, id, sqft, w.agents[0]!.id],
  );
  return id;
}

describe('R-MLS-7 E640: stored sizes that cannot be finished living area', () => {
  let dir: string;
  let db: TestDb;
  let app: Database;
  let su: pg.Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // a database at the migration before this one (later ones are applied with it below)
    dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const all = listMigrations(MIGRATIONS_DIR);
    const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
    expect(at).toBeGreaterThan(0);
    for (const m of all.slice(0, at)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
    db = await createTestDb({ migrationsDir: dir });
    app = createDatabase({ url: db.appUserUrl, max: 4 });
    su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
    su.on('error', () => {});
    const a = await createWorld(app, { agents: 1 });
    const b = await createWorld(app, { agents: 1 });
    const ca = await connections(su, a);
    const cb = await connections(su, b, true);
    ids['sparkTotal'] = await mlsRow(su, a, ca.spark, { n: 'S1', sqft: 2100, sizeSource: 'BuildingAreaTotal', version: 2 });
    ids['sparkV1'] = await mlsRow(su, a, ca.spark, { n: 'S2', sqft: 2100, sizeSource: null, version: 1 });
    ids['sparkLiving'] = await mlsRow(su, a, ca.spark, { n: 'S3', sqft: 1850, sizeSource: 'LivingArea', version: 2 });
    ids['otherTotal'] = await mlsRow(su, a, ca.other, { n: 'O1', sqft: 2600, sizeSource: 'BuildingAreaTotal', version: 2 });
    ids['otherLiving'] = await mlsRow(su, a, ca.other, { n: 'O2', sqft: 1850, sizeSource: 'LivingArea', version: 2 });
    ids['otherV1'] = await mlsRow(su, a, ca.other, { n: 'O3', sqft: 1400, sizeSource: null, version: 1 });
    ids['team'] = await teamRow(su, a, 1650);
    ids['otherTenantSpark'] = await mlsRow(su, b, cb.spark, { n: 'S1', sqft: 2300, sizeSource: 'BuildingAreaTotal', version: 2 });

    const applied = await migrate(db.ownerUrl, MIGRATIONS_DIR);
    expect(applied.applied[0]).toMatch(THIS_MIGRATION);
  }, 600_000);
  afterAll(async () => {
    await app?.close();
    await su?.end();
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const row = async (id: string) =>
    (await suRows<{ sqft: number | null; size_source: string | null; lot_sqft: string; beds: number; list_price_cents: string; mls_modified_at: Date | null; mls_normalize_version: number }>(su, 'SELECT sqft, size_source, lot_sqft, beds, list_price_cents, mls_modified_at, mls_normalize_version FROM listings WHERE id = $1', [id]))[0]!;

  it('E640 R-MLS-7: every Spark size (BuildingAreaTotal, no source, even LivingArea) and every BuildingAreaTotal size is nulled with its source, in every tenant; the rest of each row is unchanged', async () => {
    for (const k of ['sparkTotal', 'sparkV1', 'sparkLiving', 'otherTotal', 'otherTenantSpark']) {
      const r = await row(ids[k]!);
      expect([k, r.sqft, r.size_source]).toEqual([k, null, null]);
      expect([k, r.lot_sqft, r.beds, r.list_price_cents, r.mls_modified_at?.toISOString()]).toEqual([k, '6534', 3, '40000000', '2026-11-10T10:00:00.000Z']);
    }
    expect((await row(ids['sparkV1']!)).mls_normalize_version).toBe(1); // the backfill still re-reads it
  });

  it('E640 R-MLS-7: sizes from other sources are untouched: an agent-entered team size, another feed\'s LivingArea size and its pre-0061 size', async () => {
    expect(await row(ids['team']!)).toMatchObject({ sqft: 1650, size_source: null });
    expect(await row(ids['otherLiving']!)).toMatchObject({ sqft: 1850, size_source: 'LivingArea' });
    expect(await row(ids['otherV1']!)).toMatchObject({ sqft: 1400, size_source: null });
  });

  it('E640 R-MLS-7: no price history was written', async () => {
    expect(await suRows(su, 'SELECT 1 FROM listing_price_history WHERE listing_id = ANY ($1::uuid[])', [Object.values(ids)])).toEqual([]);
  });

  it('E640 R-MLS-7: afterwards the database refuses every never-used field as a size source, in any letter case (CHECK listings_size_source_not_total)', async () => {
    for (const f of [...SIZE_FIELDS_NEVER_USED, 'buildingareatotal']) {
      const err = await su.query('UPDATE listings SET size_source = $2 WHERE id = $1', [ids['otherLiving'], f]).then(() => null, (e: { code?: string; constraint?: string }) => e);
      expect([f, err?.code, err?.constraint]).toEqual([f, '23514', 'listings_size_source_not_total']);
    }
    await su.query("UPDATE listings SET size_source = 'AboveGradeFinishedArea' WHERE id = $1", [ids['otherLiving']]); // a candidate field is allowed
    expect((await row(ids['otherLiving']!)).size_source).toBe('AboveGradeFinishedArea');
  });
});
