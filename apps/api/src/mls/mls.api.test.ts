// api/mls routes, the compliance sweep and the handler registration, through the real server and Postgres
// (fakes only). R-MLS-2, R-MLS-3, R-MLS-4, R-MLS-5, R-OWN-27, R-TEN-1; E81, E85.
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth, inviteViaApi, staleReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, listing } from '../assistant/testing.js';
import { handlers } from '../worker/handlers/index.js';
import { systemActor } from '../worker/systemActor.js';
import { PACK_KEYS } from './admin.js';
import { MLS_JOBS } from './handlers.js';
import { complianceSweepInTx } from './sweep.js';
import { syncConnection } from './sync.js';
import { TEST_ATTRIBUTION, TEST_DISCLAIMER, makeDue, mlsConnection, mlsDeps, mlsRows, pagedFeed, reso } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let admin: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  admin = await inviteViaApi(h, w.owner, 'admin');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const tid = () => w.tenantId as TenantId;
async function sync(conn: string, records: ReturnType<typeof reso>[]) {
  await makeDue(h, conn);
  return syncConnection(mlsDeps(h, { [conn]: pagedFeed([records]) }), tid(), conn);
}

type Competing = { subjectId: string; listings: { id: string; source: string; sourceLabel: string; isTeamListing: boolean; listingBrokerageName: string | null }[]; mirrorMismatches: { teamListingId: string; teamStatus: string; mlsStatus: string }[]; mlsPaused: boolean; mlsDataAsOf: string | null; why: { listing: string; criterion: string }[] };

describe('GET /listings/:id/competing', () => {
  let subject: string;
  let conn: string;
  beforeAll(async () => {
    subject = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94510', priceCents: 50_000_000, beds: 3 });
    const mirrored = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94510', priceCents: 51_000_000, beds: 3 });
    await h.su.query("UPDATE listings SET mls_number = 'M5101' WHERE id = $1", [mirrored]);
    conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await sync(conn, [
      reso(5101, { PostalCode: '94510', ListPrice: 510000, StandardStatus: 'Pending' }), // the team's own listing in the feed (E81)
      reso(5102, { PostalCode: '94510', ListPrice: 495000 }),
      reso(5103, { PostalCode: '94510', ListPrice: 900000 }), // outside the price band
    ]);
  }, 60_000);

  it('R-MLS-5 E81 R-MLS-4: the mirrored team listing counts once (team row authoritative), the status mismatch is shown, MLS rows are labelled with their brokerage', async () => {
    const r = await call<Competing>(w.agents[0]!, 'GET', `/listings/${subject}/competing`);
    expect(r.status).toBe(200);
    const mls = r.body.listings.filter((l) => l.source === 'mls');
    const team = r.body.listings.filter((l) => l.source === 'team');
    expect(team).toHaveLength(1);
    expect(mls).toHaveLength(1);
    expect(mls[0]).toMatchObject({ sourceLabel: 'MLS', isTeamListing: false, listingBrokerageName: 'Other Brokerage (test)' });
    expect(r.body.mirrorMismatches).toEqual([expect.objectContaining({ teamStatus: 'active', mlsStatus: 'pending' })]);
    expect(r.body.mlsPaused).toBe(false);
    expect(r.body.mlsDataAsOf).toMatch(/^MLS data as of /);
    expect(r.body.why.some((x) => x.criterion === 'price_band')).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_?id|confidence/i);
  });

  it('E85 R-MLS-3: with a stale feed the MLS rows pause and the response says so; team listings remain', async () => {
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '3 days' WHERE tenant_id = $1 AND kind = 'mls_feed'", [w.tenantId]);
    try {
      const r = await call<Competing>(w.agents[0]!, 'GET', `/listings/${subject}/competing`);
      expect(r.body.listings.every((l) => l.source === 'team')).toBe(true);
      expect(r.body.listings).toHaveLength(1);
      expect(r.body.mlsPaused).toBe(true);
    } finally {
      await h.su.query("UPDATE integration_connections SET last_synced_at = now() WHERE tenant_id = $1 AND kind = 'mls_feed'", [w.tenantId]);
    }
  });

  it('R-TEN-1: another tenant (even its Owner) gets 404; an unknown id is 404', async () => {
    const other = await h.signup();
    expect((await call(other, 'GET', `/listings/${subject}/competing`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'GET', `/listings/${randomUUID()}/competing`)).status).toBe(404);
  });
});

type PackView = { values: { key: string; value: unknown; counselReviewed: boolean }[]; reviewedByCounselAt: string | null; unreviewedCount: number; sentence: string };
type AdminView = { connections: { id: string; status: string; clientDisplay: boolean; clientDisplaySentence: string; feedStale: boolean; mlsDataAsOf: string; licensePack: PackView }[] };

function packBody(o: { reviewed?: boolean | ((k: string) => boolean); attribution?: string } = {}) {
  const r = (k: string) => (typeof o.reviewed === 'function' ? o.reviewed(k) : o.reviewed ?? true);
  const values: Record<string, unknown> = {
    max_staleness_hours: 24,
    attribution_text: o.attribution ?? TEST_ATTRIBUTION,
    disclaimer_text: TEST_DISCLAIMER,
    allow_rehost_photos: false,
    require_listing_brokerage: true,
    client_fields: ['status', 'listPrice', 'beds', 'baths', 'locality', 'address', 'photos'],
    client_statuses: ['active', 'coming_soon'],
    public_fields: [],
    public_statuses: [],
  };
  return Object.fromEntries(PACK_KEYS.map((k) => [k, { value: values[k], counselReviewed: r(k) }]));
}

describe('MLS admin and the licence-pack editor (Owner/Admin, each value marked counsel-reviewed or not)', () => {
  let conn: string;
  beforeAll(async () => {
    conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: {}, lastSyncedAt: new Date() });
  });
  const put = async (c: TestClient, body: unknown, id = conn) => {
    await freshReauth(h, c);
    return call<{ licensePack: PackView }>(c, 'PUT', `/admin/mls/connections/${id}/license-pack`, body);
  };
  const viewOf = async (c: TestClient) => (await call<AdminView>(c, 'GET', '/admin/mls')).body.connections.find((x) => x.id === conn)!;

  it('R-MLS-2: the empty pack shows nothing to clients and says why, value by value', async () => {
    const v = await viewOf(w.owner);
    expect(v.clientDisplay).toBe(false);
    expect(v.clientDisplaySentence).toMatch(/not counsel-reviewed/);
    expect(v.licensePack.unreviewedCount).toBe(PACK_KEYS.length);
    expect(v.licensePack.values.map((x) => x.key)).toEqual([...PACK_KEYS]);
    expect(v.licensePack.values.every((x) => x.counselReviewed === false)).toBe(true);
  });

  it('R-MLS-2: one unreviewed value keeps the whole pack unreviewed (nothing to clients); all reviewed stamps it; the same pack again keeps the stamp; a change re-stamps it', async () => {
    const partial = await put(admin, packBody({ reviewed: (k) => k !== 'disclaimer_text' }));
    expect(partial.status).toBe(200);
    expect(partial.body.licensePack).toMatchObject({ reviewedByCounselAt: null, unreviewedCount: 1 });
    expect((await viewOf(admin)).clientDisplay).toBe(false);
    const full = await put(w.owner, packBody());
    expect(full.body.licensePack.reviewedByCounselAt).not.toBeNull();
    expect((await viewOf(w.owner)).clientDisplay).toBe(true);
    const again = await put(w.owner, packBody());
    expect(again.body.licensePack.reviewedByCounselAt).toBe(full.body.licensePack.reviewedByCounselAt);
    await h.su.query("UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{reviewed_by_counsel_at}', '\"2026-01-01T00:00:00.000Z\"') WHERE id = $1", [conn]);
    const changed = await put(w.owner, packBody({ attribution: 'A different attribution (test).' }));
    expect(changed.body.licensePack.reviewedByCounselAt).not.toBe('2026-01-01T00:00:00.000Z');
    const audits = (await h.su.query<{ reason: string; changes: unknown }>("SELECT reason, changes FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'integration.changed' ORDER BY seq", [w.tenantId, conn])).rows;
    expect(audits.map((a) => a.reason)).toEqual(['LICENSE_PACK_CHANGED', 'LICENSE_PACK_CHANGED', 'LICENSE_PACK_CHANGED', 'LICENSE_PACK_CHANGED']);
    expect(JSON.stringify(audits)).not.toContain('different attribution'); // keys only, never the texts
  });

  it('R-MLS-3: a stale feed pauses client display and the view says "MLS data as of …"', async () => {
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '2 days' WHERE id = $1", [conn]);
    const v = await viewOf(w.owner);
    expect([v.feedStale, v.clientDisplay]).toEqual([true, false]);
    expect(v.clientDisplaySentence).toMatch(/paused/);
    expect(v.mlsDataAsOf).toMatch(/^MLS data as of /);
  });

  it('the body is strict: unknown keys, a missing mark, an unknown field or status, a tenant id are refused', async () => {
    for (const body of [{ ...packBody(), tenantId: w.tenantId }, { ...packBody(), attribution_text: { value: 'x' } }, { ...packBody(), client_fields: { value: ['ssn'], counselReviewed: true } }, { ...packBody(), client_statuses: { value: ['leased'], counselReviewed: true } }]) {
      expect((await put(w.owner, body)).status).toBe(422);
    }
  });

  it('R-PERM-13 R-PERM-5: re-auth is required to edit; agents and team leads see 404 for the view and the editor; support cannot', async () => {
    await staleReauth(h, w.owner);
    const stale = await call(w.owner, 'PUT', `/admin/mls/connections/${conn}/license-pack`, packBody());
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
    const lead = await inviteViaApi(h, w.owner, 'team_lead');
    for (const c of [w.agents[0]!, lead]) {
      expect((await call(c, 'GET', '/admin/mls')).status).toBe(404);
      expect((await put(c, packBody())).status).toBe(404);
    }
  });

  it('R-TEN-1: another tenant cannot see or edit this connection (404), and its view lists none of it', async () => {
    const other = await h.signup();
    expect((await put(other, packBody())).status).toBe(404);
    expect((await call<AdminView>(other, 'GET', '/admin/mls')).body.connections).toEqual([]);
  });
});

describe('mls.compliance_sweep and the handlers (R-OWN-27)', () => {
  it('both handlers are registered, periodic per tenant (sync every 60 s, standalone)', () => {
    const sync = handlers.find((x) => x.kind === MLS_JOBS.sync)!;
    const sweep = handlers.find((x) => x.kind === MLS_JOBS.complianceSweep)!;
    expect([sync.mode, sync.every?.ms]).toEqual(['standalone', 60_000]);
    expect(sweep.every?.ms).toBe(5 * 60_000);
  });

  it('E85: a connected feed that went stale is degraded with MLS_FEED_STALE; E81: a team listing added later links its MLS copy', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await sync(conn, [reso(8501, { PostalCode: '94850' })]);
    const team = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94850' });
    await h.su.query("UPDATE listings SET mls_number = 'M8501' WHERE id = $1", [team]);
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '3 days' WHERE id = $1", [conn]);
    const r = await withTenantTx(systemActor(tid(), 'worker'), (tx, now) => complianceSweepInTx(tx, systemActor(tid(), 'worker'), now), { db: h.database });
    expect(r.degraded).toContain(conn);
    expect(r.mirrorsLinked).toBeGreaterThanOrEqual(1);
    expect((await h.su.query('SELECT status, status_reason FROM integration_connections WHERE id = $1', [conn])).rows[0]).toEqual({ status: 'degraded', status_reason: 'MLS_FEED_STALE' });
    expect((await mlsRows(h, w.tenantId)).find((x) => x.mls_number === 'M8501')!.team_listing_id).toBe(team);
    // idempotent
    const again = await withTenantTx(systemActor(tid(), 'worker'), (tx, now) => complianceSweepInTx(tx, systemActor(tid(), 'worker'), now), { db: h.database });
    expect(again.degraded).not.toContain(conn);
  });

  it("R-TEN-1: another tenant's sweep touches none of this tenant's connections, rows or alerts", async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '3 days' WHERE id = $1", [conn]);
    const other = await h.signup();
    const oid = other.tenantId as TenantId;
    const r = await withTenantTx(systemActor(oid, 'worker'), (tx, now) => complianceSweepInTx(tx, systemActor(oid, 'worker'), now), { db: h.database });
    expect(r).toEqual({ degraded: [], canceledAlerts: 0, canceledCmaShares: 0, mirrorsLinked: 0, canceledHomeValueNotes: 0 });
    expect((await h.su.query('SELECT status FROM integration_connections WHERE id = $1', [conn])).rows[0]).toEqual({ status: 'connected' });
  });
});
