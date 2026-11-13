// mls.sync over the read-only Spark adapter, against a MOCK Spark that reproduces the live shape
// (findings 1-9, docs/SECURITY.md §5.3). A network tripwire fails any real outbound call; MLS_LIVE_CALLS
// is false unless a test turns it on for the mock. Canaries for the key and the X-Api-Key header are
// searched for in every output channel at the end.
import type { TenantId } from '@realty/core/foundation';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import type { MemoryErrorReporter } from '../observability/errors.js';
import { CANARY_KEY_ID, CANARY_TOKEN, REPLICATION_HOST, type Tripwire, installNetworkTripwire, liveClosedProperty, liveProperty, liveSpark } from '../providers/integrations/spark.testing.js';
import { RESULT_SENTENCE } from './spark/service.js';
import { syncDueConnections } from './sync.js';
import { REVIEWED_PACK, mlsDeps, mlsRows } from './testing.js';

let h: ApiHarness;
let wire: Tripwire;
let owner: TestClient;
let records: Record<string, unknown>[] = [];
const spark = liveSpark({ records: () => records, pageSize: 50 });
const bodies: string[] = [];

const setMls = (o: Partial<ApiHarness['config']['mls']>) => {
  h.app.platform.config.mls = { ...h.app.platform.config.mls, ...o };
};
const conn = async () => (await h.su.query<{ id: string; status: string; status_reason: string | null; last_error_code: string | null; sync_cursor: string | null }>("SELECT id, status, status_reason, last_error_code, sync_cursor FROM integration_connections WHERE tenant_id = $1 AND kind = 'mls_feed' ORDER BY created_at DESC LIMIT 1", [owner.tenantId])).rows[0]!;
const due = async () => h.su.query("UPDATE integration_connections SET next_sync_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'mls_feed'", [owner.tenantId]);
const run = async () => {
  await due();
  return syncDueConnections(mlsDeps(h), owner.tenantId as TenantId);
};

beforeAll(async () => {
  wire = installNetworkTripwire();
  h = await createApiHarness({ logLevel: 'info' });
  h.providers.integrations.mlsTransport = spark.fetch;
  // finding 1: the replication host, set through the existing settings
  setMls({ provider: 'spark', liveCalls: true, spark: { baseUrl: `https://${REPLICATION_HOST}`, allowedHosts: [REPLICATION_HOST], authScheme: 'Bearer' } });
  owner = await h.signup();
  await freshReauth(h, owner);
  expect((await call(owner, 'PUT', '/admin/integrations/mls/spark/credential', { accessToken: CANARY_TOKEN, keyLabel: 'crm-key' })).status).toBe(200);
  await freshReauth(h, owner);
  const v = await call<{ result: string }>(owner, 'POST', '/admin/integrations/mls/spark/validate');
  bodies.push(JSON.stringify(v.body));
  expect(v.body.result).toBe('connected');
  await h.su.query("UPDATE integration_connections SET license_pack = $2::jsonb WHERE tenant_id = $1 AND kind = 'mls_feed'", [owner.tenantId, JSON.stringify(REVIEWED_PACK)]);
}, 180_000);
afterEach(() => {
  expect(wire.attempts).toEqual([]);
});
afterAll(async () => {
  await h?.close();
  wire?.restore();
});

describe('mls.sync over Spark (live shape)', () => {
  it('reads the replication host in bounded pages with $expand=Media; fields as the live feed serves them', async () => {
    records = Array.from({ length: 120 }, (_, i) => liveProperty(i + 1, { ModificationTimestamp: `2026-11-10T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z` }));
    spark.calls.length = 0;
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'synced', inserted: 120, skippedInvalid: 0 });
    expect(spark.calls).toHaveLength(3); // 50 + 50 + 20, nextLinks on the replication host
    for (const c of spark.calls) {
      expect([c.method, c.url.hostname, c.url.pathname, c.redirect]).toEqual(['GET', REPLICATION_HOST, '/Reso/OData/Property', 'manual']);
      expect(c.url.searchParams.get('$expand')).toBe('Media');
    }
    const row = (await mlsRows(h, owner.tenantId!)).find((x) => x.mls_number === 'MLS1')!;
    expect(row.sqft).toBeNull(); // R-MLS-7 E598 (finding 5): BuildingAreaTotal is never read as size, and no Spark size field is confirmed
    expect(row.description).toBeNull(); // finding 4: PublicRemarks withheld by its permission annotation
    expect(row.display_allowed).toBe(true);
    expect((row.attributes['mls'] as { photo_urls: string[] }).photo_urls).toEqual(['https://photos.example.invalid/LK0001/1.jpg', 'https://photos.example.invalid/LK0001/2.jpg']); // finding 2/3
    expect(JSON.stringify(await mlsRows(h, owner.tenantId!))).not.toMatch(/WITHHELD-REMARKS-MARKER|ZZ_Synthetic/);
    expect((await conn()).sync_cursor).toMatch(/\|LK0120$/);
  });

  it('resumes from the cursor: only newer records are read; nothing is re-inserted', async () => {
    records.push(liveProperty(121, { ModificationTimestamp: '2026-11-10T11:00:00Z' }));
    spark.calls.length = 0;
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'synced', inserted: 1, updated: 0 });
    expect(spark.calls[0]!.url.searchParams.get('$filter')).toMatch(/^ModificationTimestamp gt 2026-11-10T10:01:59.000Z/);
  });

  it('R-CMA-1 R-MLS-7 E598 (D9): mock closed sales with the new RESO fields flow through Spark records(); every field is a column; the size is unknown (BuildingAreaTotal and LivingArea unread); annotation keys never reach normalize', async () => {
    records.push(
      liveClosedProperty(130, { ModificationTimestamp: '2026-11-10T11:02:00Z', LivingArea: 1850 }), // R-MLS-7: LivingArea is not read either (VERIFY WITH MLS)
      liveClosedProperty(131, { ModificationTimestamp: '2026-11-10T11:03:00Z', 'YearBuilt@Core.Permissions': 'None', Longitude: -79.9305678 }),
    );
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'synced', inserted: 2, skippedInvalid: 0 });
    const rows = (await h.su.query("SELECT mls_number, status, sqft, close_price_cents, close_date::text AS close_date, purchase_contract_date::text AS contract_date, latitude_e6, longitude_e6, year_built, lot_sqft, subdivision_name, sale_conditions, concessions_cents, avm_display_allowed, stories_x10, size_source, address_key, mls_normalize_version, attributes::text AS attrs FROM listings WHERE tenant_id = $1 AND mls_number IN ('MLS130','MLS131') ORDER BY mls_number", [owner.tenantId])).rows;
    expect(rows[0]).toMatchObject({ status: 'sold', close_price_cents: '40800000', close_date: '2026-09-15', contract_date: '2026-08-20', latitude_e6: 32_780_123, longitude_e6: -79_930_568, year_built: 2003, lot_sqft: '6534', subdivision_name: 'Example Commons', sale_conditions: ['standard'], concessions_cents: '500000', avm_display_allowed: true, stories_x10: 15, sqft: null, size_source: null, address_key: '230 example st||exampleton|zz|00000', mls_normalize_version: 2 });
    expect(rows[1]).toMatchObject({ year_built: null, longitude_e6: -79_930_568 }); // withheld by its permission annotation
    expect(JSON.stringify(rows)).not.toMatch(/@Core|Permissions|ZZ_Synthetic/);
  });

  it('finding 7: a transient 503 is retried inside the budget and the sync succeeds', async () => {
    records.push(liveProperty(122, { ModificationTimestamp: '2026-11-10T11:05:00Z' }));
    spark.opts.busyNext = 1;
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'synced', inserted: 1 });
  });

  it('finding 1: pointed at the standard host, the sync fails with REPLICATION_ENDPOINT_REQUIRED, the connection degrades and the Owner reads plain words', async () => {
    setMls({ spark: { baseUrl: 'https://sparkapi.com', allowedHosts: ['sparkapi.com', REPLICATION_HOST], authScheme: 'Bearer' } });
    try {
      const [r] = await run();
      expect(r).toMatchObject({ outcome: 'failed', code: 'REPLICATION_ENDPOINT_REQUIRED' });
      expect(await conn()).toMatchObject({ status: 'degraded', last_error_code: 'REPLICATION_ENDPOINT_REQUIRED' });
      const v = await call<{ connection: { statusSentence: string } }>(owner, 'GET', '/admin/integrations/mls/spark');
      bodies.push(JSON.stringify(v.body));
      expect(v.body.connection.statusSentence).toContain(RESULT_SENTENCE['REPLICATION_ENDPOINT_REQUIRED']!);
    } finally {
      setMls({ spark: { baseUrl: `https://${REPLICATION_HOST}`, allowedHosts: [REPLICATION_HOST], authScheme: 'Bearer' } });
    }
    const [ok] = await run();
    expect(ok!.outcome).toBe('synced');
    expect((await conn()).status).toBe('connected');
  });

  it('MLS_LIVE_CALLS=false: no request leaves the process; the run records LIVE_CALLS_DISABLED', async () => {
    setMls({ liveCalls: false });
    try {
      spark.calls.length = 0;
      const [r] = await run();
      expect(r).toMatchObject({ outcome: 'failed', code: 'LIVE_CALLS_DISABLED' });
      expect(spark.calls).toHaveLength(0);
      expect(wire.attempts).toEqual([]);
      // nothing was decrypted either: no credential read happened for this run (the feed refused before openSparkFeed)
      expect((await conn()).last_error_code).toBe('LIVE_CALLS_DISABLED');
    } finally {
      setMls({ liveCalls: true });
    }
  });

  it('finding 8: the key and the X-Api-Key value appear in no log line, error report, audit row, DB row or API response', async () => {
    const all = [...h.logs, JSON.stringify((h.app.platform.errorReporter as MemoryErrorReporter).events), ...bodies];
    for (const line of all) {
      expect(line).not.toContain(CANARY_TOKEN);
      expect(line).not.toContain(CANARY_KEY_ID);
    }
    const tables = (await h.su.query<{ s: string; t: string }>("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'")).rows;
    const hits: string[] = [];
    for (const { s, t } of tables) {
      const n = await h.su.query(`SELECT 1 FROM (SELECT r::text AS x FROM ${JSON.stringify(s)}.${JSON.stringify(t)} r) q WHERE x LIKE $1 OR x LIKE $2 LIMIT 1`, [`%${CANARY_TOKEN}%`, `%${CANARY_KEY_ID}%`]);
      if (n.rowCount) hits.push(`${s}.${t}`);
    }
    expect(hits).toEqual([]);
  });
});
