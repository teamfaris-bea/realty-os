// D9 lane V1-A: the valuation gates and the pack's valuation section (R-CMA-6, R-CMA-7: the licence-pack and
// eligibility parts), clientSoldView (F4, E366), the sold-data coverage view (E372), and the changed schemas
// (R-AST-13). Real Postgres, fakes only. E86, E369 (FEED_STALE), E371; R-MLS-2 kept.
import type { Instant, TenantId } from '@realty/core/foundation';
import { parseLicensePack } from '@realty/core/listings';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, listing } from '../assistant/testing.js';
import { PACK_KEYS, VALUATION_PACK_KEYS } from './admin.js';
import { LISTING_COLS, type ListingRow, type MlsConnectionFacts, type MlsEligibility, VALUATION_SENTENCE, clientSoldView, clientView, mlsEligibility, valuationEligible } from './eligibility.js';
import { LicensePackBody, MlsAdminResponse, PackViewSchema, SoldCoverageSchema } from './routes.js';
import { syncConnection } from './sync.js';
import { REVIEWED_PACK, TEST_ATTRIBUTION, TEST_DISCLAIMER, makeDue, mlsConnection, mlsDeps, pagedFeed, soldReso } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const NOW = Date.parse('2026-11-12T12:00:00Z') as Instant;
const STATEMENT = { text: 'An estimate of value, not an appraisal (test statement).', min_point_size: 12 };
const VALUATION = { agent_cma: true, client_cma: true, automated_notes: true, avm_flag_scope: 'all_client_outputs', statements: { CA: STATEMENT }, reviewed_by_counsel_at: '2026-11-02T00:00:00Z' };
const SOLD_CLIENT_FIELDS = [...REVIEWED_PACK.audiences.client.fields, 'closePrice', 'closeDate', 'yearBuilt'];

function elig(o: { status?: string; pack?: Record<string, unknown>; lastSyncedAt?: Instant | null } = {}): MlsEligibility {
  const c: MlsConnectionFacts = { id: 'c1', status: o.status ?? 'connected', displayName: 'Test MLS feed', lastSyncedAt: o.lastSyncedAt === undefined ? ((NOW - 3_600_000) as Instant) : o.lastSyncedAt, pack: parseLicensePack(o.pack ?? { ...REVIEWED_PACK, valuation: VALUATION }) };
  const fresh = c.lastSyncedAt !== null && NOW - c.lastSyncedAt < 24 * 3_600_000;
  return { connections: [c], clientIds: fresh && c.status === 'connected' ? ['c1'] : [], staleIds: fresh ? [] : ['c1'], pack: (id) => (id === 'c1' ? c.pack : null) };
}

describe('valuationEligible (R-CMA-6, R-CMA-7: licence and eligibility parts)', () => {
  it('R-CMA-6: an agent CMA needs a live connection and valuation.agent_cma; a stale feed does not block it (E369)', () => {
    expect(valuationEligible(elig(), 'c1', 'agent_cma', null, NOW)).toEqual({ ok: true });
    expect(valuationEligible(elig({ lastSyncedAt: (NOW - 3 * 86_400_000) as Instant }), 'c1', 'agent_cma', 'CA', NOW)).toEqual({ ok: true });
    expect(valuationEligible(elig({ pack: { ...REVIEWED_PACK, valuation: { ...VALUATION, reviewed_by_counsel_at: null, statements: {} } } }), 'c1', 'agent_cma', null, NOW)).toEqual({ ok: true });
  });

  it('R-CMA-6 R-CMA-7 E369 E371: every refusal has its code and a sentence in words', () => {
    const cases: [ReturnType<typeof elig>, string | null, 'agent_cma' | 'client_cma' | 'automated_notes', string | null, string][] = [
      [elig(), null, 'agent_cma', 'CA', 'NO_MLS_CONNECTION'],
      [elig(), 'other', 'agent_cma', 'CA', 'NO_MLS_CONNECTION'],
      [elig({ status: 'revoked' }), 'c1', 'agent_cma', 'CA', 'MLS_NOT_LIVE'],
      [elig({ pack: REVIEWED_PACK as unknown as Record<string, unknown> }), 'c1', 'agent_cma', 'CA', 'PACK_DOES_NOT_ALLOW'], // E371: a reviewed pack without the section
      [elig({ pack: { ...REVIEWED_PACK, valuation: { ...VALUATION, client_cma: false } } }), 'c1', 'client_cma', 'CA', 'PACK_DOES_NOT_ALLOW'],
      [elig({ pack: { ...REVIEWED_PACK, valuation: { ...VALUATION, reviewed_by_counsel_at: null } } }), 'c1', 'client_cma', 'CA', 'VALUATION_NOT_REVIEWED'],
      [elig(), 'c1', 'client_cma', 'NV', 'NO_VALUATION_STATEMENT'],
      [elig(), 'c1', 'automated_notes', null, 'NO_VALUATION_STATEMENT'],
      [elig({ pack: { ...REVIEWED_PACK, reviewed_by_counsel_at: null, valuation: VALUATION } }), 'c1', 'client_cma', 'CA', 'MLS_NOT_CLIENT_ELIGIBLE'],
      [elig({ pack: { ...REVIEWED_PACK, disclaimer_text: null, valuation: VALUATION } }), 'c1', 'automated_notes', 'CA', 'MLS_NOT_CLIENT_ELIGIBLE'],
      [elig({ lastSyncedAt: (NOW - 3 * 86_400_000) as Instant }), 'c1', 'client_cma', 'CA', 'FEED_STALE'],
      [elig({ lastSyncedAt: null }), 'c1', 'automated_notes', 'California', 'FEED_STALE'],
    ];
    for (const [e, id, use, region, code] of cases) {
      const r = valuationEligible(e, id, use, region, NOW);
      expect(r, `${use} ${code}`).toEqual({ ok: false, code, sentence: VALUATION_SENTENCE[code as keyof typeof VALUATION_SENTENCE] });
      expect((r as { sentence: string }).sentence.length).toBeGreaterThan(20);
    }
    expect(valuationEligible(elig(), 'c1', 'client_cma', 'CA', NOW)).toEqual({ ok: true });
    expect(valuationEligible(elig(), 'c1', 'automated_notes', 'california', NOW)).toEqual({ ok: true });
  });
});

describe('clientSoldView (F4, E366) and the client rules for sold rows (R-MLS-2, E86)', () => {
  const rowsOf = (tx: Tx, n: string) => sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.mls_number = ${n} ORDER BY l.source`.execute(tx);
  async function mirrored(n: number, pack: Record<string, unknown>, o: Record<string, unknown> = {}) {
    const team = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94661', status: 'sold' });
    await h.su.query('UPDATE listings SET mls_number = $2 WHERE id = $1', [team, `M${n}`]);
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack, lastSyncedAt: new Date() });
    await makeDue(h, conn);
    await syncConnection(mlsDeps(h, { [conn]: pagedFeed([[soldReso(n, { PostalCode: '94661', ...o })]]) }), w.tenantId as TenantId, conn);
    return withTenantTx(w.agents[0]!.actor(), async (tx, now) => {
      const [m, t] = (await rowsOf(tx, `M${n}`)).rows;
      return { e: await mlsEligibility(tx, now), mirror: m!, team: t! };
    }, { db: h.database });
  }
  const soldPack = { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { fields: SOLD_CLIENT_FIELDS, statuses: ['active', 'sold'] } } };

  it('E366 R-MLS-5: a display-allowed mirror under a reviewed pack listing the sold fields is shown with the team row\'s facts and the MLS close price; clientView still refuses the mirror', async () => {
    const { e, mirror, team } = await mirrored(6601, soldPack);
    expect([mirror.source, team.source, mirror.team_listing_id]).toEqual(['mls', 'team', team.id]);
    expect(clientView(e, mirror)).toBeNull();
    const v = clientSoldView(e, mirror, team)!;
    expect(v).toMatchObject({ id: team.id, source: 'team', sourceLabel: 'Team', status: 'sold', closePriceCents: 51_160_100, closeDate: '2026-09-30', yearBuilt: 1962, attribution: TEST_ATTRIBUTION, disclaimer: TEST_DISCLAIMER });
    expect(v.address?.line1).toBe(team.address_line1);
    expect(v).not.toHaveProperty('subdivisionName'); // not listed in the pack
  });

  it('E86 R-MLS-2: display_allowed false, a stale feed, a pack without the sold fields or without sold, or a lease give null', async () => {
    const off = await mirrored(6602, soldPack, { InternetEntireListingDisplayYN: false });
    expect(clientSoldView(off.e, off.mirror, off.team)).toBeNull();
    const noFields = await mirrored(6603, REVIEWED_PACK as unknown as Record<string, unknown>);
    expect(clientSoldView(noFields.e, noFields.mirror, noFields.team)).toBeNull();
    const noSold = await mirrored(6604, { ...soldPack, audiences: { ...soldPack.audiences, client: { fields: SOLD_CLIENT_FIELDS, statuses: ['active'] } } });
    expect(clientSoldView(noSold.e, noSold.mirror, noSold.team)).toBeNull();
    const lease = await mirrored(6605, soldPack, { PropertyType: 'Residential Lease' });
    expect(clientSoldView(lease.e, lease.mirror, lease.team)).toBeNull();
    const ok = await mirrored(6606, soldPack);
    expect(clientSoldView(ok.e, ok.mirror, ok.team)).not.toBeNull();
    const stale = { ...ok.e, clientIds: [] };
    expect(clientSoldView(stale, ok.mirror, ok.team)).toBeNull();
    // the wrong team row
    expect(clientSoldView(ok.e, ok.mirror, off.team)).toBeNull();
  });
});

describe('the pack\'s valuation section in the editor (E371) and sold-data coverage', () => {
  type View = { connections: { id: string; licensePack: { reviewedByCounselAt: string | null; valuation: { values: { key: string; value: unknown; counselReviewed: boolean }[]; reviewedByCounselAt: string | null; unreviewedCount: number; sentence: string } }; soldData: z.infer<typeof SoldCoverageSchema> }[] };
  const viewOf = async (c: TestClient, id: string) => (await call<View>(c, 'GET', '/admin/mls')).body.connections.find((x) => x.id === id)!;
  const put = async (id: string, body: unknown) => {
    await freshReauth(h, w.owner);
    return call<{ licensePack: View['connections'][number]['licensePack'] }>(w.owner, 'PUT', `/admin/mls/connections/${id}/license-pack`, body);
  };
  const displayBody = (pack: typeof REVIEWED_PACK) => {
    const values: Record<string, unknown> = {
      max_staleness_hours: pack.max_staleness_hours,
      attribution_text: pack.attribution_text,
      disclaimer_text: pack.disclaimer_text,
      allow_rehost_photos: pack.allow_rehost_photos,
      require_listing_brokerage: pack.require_listing_brokerage,
      client_fields: pack.audiences.client.fields,
      client_statuses: pack.audiences.client.statuses,
      public_fields: pack.audiences.public.fields,
      public_statuses: pack.audiences.public.statuses,
    };
    return Object.fromEntries(PACK_KEYS.map((k) => [k, { value: values[k], counselReviewed: true }]));
  };
  const valuationBody = (o: { reviewed?: boolean; agent?: boolean; statements?: unknown[] } = {}) => ({
    agent_cma: { value: o.agent ?? true, counselReviewed: o.reviewed ?? true },
    client_cma: { value: true, counselReviewed: o.reviewed ?? true },
    automated_notes: { value: false, counselReviewed: o.reviewed ?? true },
    avm_flag_scope: { value: 'all_client_outputs', counselReviewed: o.reviewed ?? true },
    statements: { value: o.statements ?? [{ region: 'CA', text: 'SECRET-STATEMENT-TEXT test estimate wording.', minPointSize: 12 }], counselReviewed: o.reviewed ?? true },
  });

  it('E371 R-CMA-6: an existing reviewed pack keeps reviewedByCounselAt when the section is added; the section has its own stamp; a PUT without valuation keys keeps the stored section', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
    await put(conn, displayBody(REVIEWED_PACK));
    const display0 = (await viewOf(w.owner, conn)).licensePack.reviewedByCounselAt;
    expect(display0).not.toBeNull();
    const v0 = (await viewOf(w.owner, conn)).licensePack.valuation;
    expect(v0).toMatchObject({ reviewedByCounselAt: null, unreviewedCount: VALUATION_PACK_KEYS.length });
    expect(v0.values.map((x) => [x.key, x.value])).toEqual([['agent_cma', false], ['client_cma', false], ['automated_notes', false], ['avm_flag_scope', 'all_client_outputs'], ['statements', []]]);
    expect(v0.sentence).toMatch(/Agent CMAs need an Owner or Admin to record/);

    const partial = await put(conn, { ...displayBody(REVIEWED_PACK), valuation: valuationBody({ reviewed: false }) });
    expect(partial.status).toBe(200);
    expect(partial.body.licensePack.reviewedByCounselAt).toBe(display0);
    expect(partial.body.licensePack.valuation.reviewedByCounselAt).toBeNull();
    const full = await put(conn, { ...displayBody(REVIEWED_PACK), valuation: valuationBody() });
    const stamp = full.body.licensePack.valuation.reviewedByCounselAt;
    expect([full.body.licensePack.reviewedByCounselAt, stamp !== null]).toEqual([display0, true]);
    // module 41's editor sends the nine display keys only: the section is kept unchanged
    const kept = await put(conn, displayBody(REVIEWED_PACK));
    expect(kept.body.licensePack.valuation.reviewedByCounselAt).toBe(stamp);
    const stored = (await h.su.query('SELECT license_pack FROM integration_connections WHERE id = $1', [conn])).rows[0].license_pack;
    expect(stored.valuation).toMatchObject({ agent_cma: true, client_cma: true, statements: { CA: { min_point_size: 12 } }, reviewed_by_counsel_at: stamp });
    // the same section again keeps its stamp; a change re-stamps it; an unreviewed value clears it
    expect((await put(conn, { ...displayBody(REVIEWED_PACK), valuation: valuationBody() })).body.licensePack.valuation.reviewedByCounselAt).toBe(stamp);
    await h.su.query("UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,reviewed_by_counsel_at}', '\"2026-01-01T00:00:00.000Z\"') WHERE id = $1", [conn]);
    expect((await put(conn, { ...displayBody(REVIEWED_PACK), valuation: valuationBody({ agent: false }) })).body.licensePack.valuation.reviewedByCounselAt).not.toBe('2026-01-01T00:00:00.000Z');
    // audited with keys only, never the statement text
    const audits = (await h.su.query<{ changes: unknown }>("SELECT changes FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND reason = 'LICENSE_PACK_CHANGED' ORDER BY seq", [w.tenantId, conn])).rows;
    expect(JSON.stringify(audits)).toMatch(/valuation_reviewed/); // the section's review state is tracked; values are never stored
    expect(JSON.stringify(audits)).not.toMatch(/SECRET-STATEMENT-TEXT/);
  });

  it('E371: strict body: an unknown region, a duplicate state, a size outside 6–36, a missing mark or an unknown valuation key is refused', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const st = (o: Record<string, unknown>) => ({ ...displayBody(REVIEWED_PACK), valuation: valuationBody({ statements: [{ region: 'CA', text: 'x', minPointSize: 12, ...o }] }) });
    for (const body of [
      st({ region: 'ZZ' }),
      st({ minPointSize: 5 }),
      st({ minPointSize: 37 }),
      st({ text: '' }),
      { ...displayBody(REVIEWED_PACK), valuation: valuationBody({ statements: [{ region: 'CA', text: 'a', minPointSize: 12 }, { region: 'CA', text: 'b', minPointSize: 12 }] }) },
      { ...displayBody(REVIEWED_PACK), valuation: { ...valuationBody(), agent_cma: { value: true } } },
      { ...displayBody(REVIEWED_PACK), valuation: { ...valuationBody(), everything: { value: true, counselReviewed: true } } },
    ]) {
      expect((await put(conn, body)).status).toBe(422);
    }
  });

  it('E372: GET /admin/mls shows sold-data coverage over the newest sold rows: count, oldest close date, the share carrying each fact', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
    await makeDue(h, conn);
    await syncConnection(mlsDeps(h, { [conn]: pagedFeed([[soldReso(7701, { CloseDate: '2025-12-01' }), soldReso(7702, { YearBuilt: null, Latitude: null, Longitude: null, SpecialListingConditions: null }), soldReso(7703, { CloseDate: null, InternetAutomatedValuationDisplayYN: 'N' }), soldReso(7704, { StandardStatus: 'Active' })]]) }), w.tenantId as TenantId, conn);
    const d = (await viewOf(w.owner, conn)).soldData;
    expect(d).toMatchObject({ rows: 3, sampleLimit: 5000, oldestCloseDate: '2025-12-01', backfillPending: false });
    expect(d.shares).toEqual({ closePrice: 100, closeDate: 67, contractDate: 100, location: 67, yearBuilt: 67, lotSize: 100, subdivision: 100, saleConditions: 67, avmDisplayAllowed: 67 });
    expect(d.sentence).toMatch(/^3 recent sold MLS records; 100% carry a close price and 67% a location\.$/);
    expect(JSON.stringify(d)).not.toMatch(/confidence|score|tenant/i);
  });

  it('R-TEN-1: another tenant\'s admin view lists none of these connections or their coverage', async () => {
    const other = await h.signup();
    expect((await call<View>(other, 'GET', '/admin/mls')).body.connections).toEqual([]);
  });
});

describe('R-AST-13: the changed schemas', () => {
  it('R-AST-13 R-TEN-3: GET /admin/mls and the licence-pack PUT carry no confidence, score or tenant id (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries({ MlsAdminResponse, PackViewSchema, SoldCoverageSchema, LicensePackBody })) {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"score"|"points"/);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
