// Test helpers for module 71 (imported by *.test.ts only). Synthetic data only: no real MLS, brokerage, person or
// address; fakes only, nothing is sent. Until lane V1-A's sync stores sold facts, sold MLS rows are written here as the
// SYSTEM actor (the 0061 guard lets only it write the valuation columns), exactly as the sync will. Contact addresses are
// written by the superuser fixture pool (no API in this lane writes them).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type LeadsWorld, call, leadsWorld, randomPhone } from '../leads/testing.js';
import { REVIEWED_PACK, mlsConnection } from '../mls/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { addressKey } from './deps.js';

export { call };

export const TEST_STATEMENT = 'Test valuation statement (fixture text, not legal wording).';

/** A licence pack that allows everything a CMA needs, for clients too (fixtures only; VERIFY WITH COUNSEL in real use). */
export function cmaPack(o: { valuation?: Record<string, unknown> | null; clientSold?: boolean; maxStalenessHours?: number; reviewed?: boolean } = {}): Record<string, unknown> {
  const fields = [...REVIEWED_PACK.audiences.client.fields, ...(o.clientSold === false ? [] : ['closePrice', 'closeDate'])];
  return {
    ...REVIEWED_PACK,
    ...(o.reviewed === false ? { reviewed_by_counsel_at: null } : {}),
    max_staleness_hours: o.maxStalenessHours ?? 24,
    audiences: { client: { fields, statuses: ['active', 'coming_soon', 'pending', 'sold'] }, public: { fields: [], statuses: [] } },
    ...(o.valuation === null
      ? {}
      : {
          valuation: {
            reviewed_by_counsel_at: '2026-11-01T00:00:00Z',
            agent_cma: true,
            client_cma: true,
            automated_notes: true,
            avm_flag_scope: 'all_client_outputs',
            statements: { CA: TEST_STATEMENT },
            ...o.valuation,
          },
        }),
  };
}

export interface CmaWorld {
  h: ApiHarness;
  tenantId: string;
  owner: TestClient;
  admin: TestClient;
  teamLead: TestClient;
  agents: TestClient[];
  isa: TestClient;
  tc: TestClient;
  mls: string;
  /** the leads world (intake token, default pond) */
  leads: LeadsWorld;
}

export async function cmaWorld(h: ApiHarness, o: { pack?: Record<string, unknown>; lastSyncedAt?: Date | null } = {}): Promise<CmaWorld> {
  const w = await leadsWorld(h, { agents: 2, rule: false, teamLead: true, others: ['admin', 'isa', 'tc'] });
  const mls = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: o.pack ?? cmaPack(), lastSyncedAt: o.lastSyncedAt === undefined ? new Date() : o.lastSyncedAt });
  const [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  return { h, tenantId: w.tenantId, owner: w.owner, admin, teamLead: w.teamLead!, agents: w.agents, isa, tc, mls, leads: w };
}

/** A contact owned by `agent`. */
export async function contact(agent: TestClient, name = 'Sam Seller'): Promise<string> {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: name, phones: [randomPhone()] });
  if (r.status !== 201 && r.status !== 200) throw new Error(`contact: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

export async function address(h: ApiHarness, tenantId: string, contactId: string, o: { kind?: 'home' | 'property' | 'mailing' | 'interest'; line1?: string; line2?: string | null; city?: string; region?: string; postalCode?: string; updatedAt?: Date } = {}): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenantId, id, contactId, o.kind ?? 'property', o.line1 ?? '100 Sample Ave', o.line2 ?? null, o.city ?? 'Oakland', o.region ?? 'CA', o.postalCode ?? '94110', o.updatedAt ?? new Date()],
  );
  return id;
}

/** The subject point of the fixtures (synthetic). */
export const HOME = { latE6: 37_750_000, lonE6: -122_420_000 };

export interface Sale {
  mlsNumber?: string;
  status?: string;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
  closePriceCents?: number | null;
  closeDate?: string | null;
  contractDate?: string | null;
  originalListPriceCents?: number | null;
  listPriceCents?: number | null;
  concessionsCents?: number | null;
  saleConditions?: string[];
  daysOnMarket?: number | null;
  latE6?: number | null;
  lonE6?: number | null;
  sqft?: number | null;
  sizeSource?: string | null;
  beds?: number | null;
  bathsX10?: number | null;
  yearBuilt?: number | null;
  subdivision?: string | null;
  propertyType?: string;
  isLease?: boolean;
  avmDisplayAllowed?: boolean;
  displayAllowed?: boolean;
  addressKey?: string | null;
  teamListingId?: string | null;
  brokerage?: string;
  connectionId?: string;
}

let seq = 0;

/** Today's date (UTC) minus `days`, as YYYY-MM-DD. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** One MLS row as the sync stores it (system actor). Returns its id. */
export async function mlsSale(w: Pick<CmaWorld, 'h' | 'tenantId' | 'mls'>, s: Sale = {}): Promise<string> {
  seq += 1;
  const id = randomUUID();
  const n = s.mlsNumber ?? `S${Date.now() % 1_000_000}-${seq}`;
  const line1 = s.line1 ?? `${200 + seq} Sample Ave`;
  const postal = s.postalCode ?? '94110';
  const region = s.region ?? 'CA';
  const key = s.addressKey !== undefined ? s.addressKey : addressKey({ line1, line2: s.line2 ?? null, city: s.city ?? 'Oakland', region, postalCode: postal });
  const status = s.status ?? 'sold';
  const sold = status === 'sold';
  await withTenantTx(
    systemActor(w.tenantId, 'provider'),
    async (tx) => {
      await sql`INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, address_line2, city, region, postal_code, list_price_cents,
                  beds, baths_x10, sqft, property_type, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, team_listing_id,
                  last_seen_in_feed_at, attributes, close_price_cents, close_date, purchase_contract_date, original_list_price_cents, concessions_cents,
                  sale_conditions, days_on_market, latitude_e6, longitude_e6, year_built, subdivision_name, size_source, is_lease, avm_display_allowed, address_key)
                VALUES (app.tenant_id(), ${id}, 'mls', ${n}, ${status}, ${line1}, ${s.line2 ?? null}, ${s.city ?? 'Oakland'}, ${region}, ${postal},
                  ${s.listPriceCents ?? s.originalListPriceCents ?? 50_000_000}, ${s.beds === undefined ? 3 : s.beds}, ${s.bathsX10 === undefined ? 20 : s.bathsX10},
                  ${s.sqft === undefined ? 1400 : s.sqft}, ${s.propertyType ?? 'single_family'}, ${s.connectionId ?? w.mls}, now() - (${seq} * interval '1 second'),
                  ${s.brokerage ?? 'Other Brokerage (test)'}, ${s.displayAllowed ?? true}, ${s.teamListingId ?? null}, now(),
                  ${JSON.stringify({ mls: { listing_key: `K-${n}`, address_display: true, photo_urls: [], photos_count: 0 } })}::jsonb,
                  ${sold ? (s.closePriceCents === undefined ? 50_000_000 : s.closePriceCents) : (s.closePriceCents ?? null)}, ${sold ? (s.closeDate === undefined ? daysAgo(60) : s.closeDate) : (s.closeDate ?? null)}::date,
                  ${s.contractDate ?? null}::date, ${s.originalListPriceCents ?? null}, ${s.concessionsCents ?? null}, ${s.saleConditions ?? []}::text[],
                  ${s.daysOnMarket ?? 20}, ${s.latE6 === undefined ? HOME.latE6 + seq * 10 : s.latE6}, ${s.lonE6 === undefined ? HOME.lonE6 - seq * 10 : s.lonE6},
                  ${s.yearBuilt ?? 1960}, ${s.subdivision === undefined ? 'Sample Heights' : s.subdivision}, ${s.sizeSource === undefined ? 'LivingArea' : s.sizeSource},
                  ${s.isLease ?? false}, ${s.avmDisplayAllowed ?? true}, ${key})`.execute(tx);
    },
    { db: w.h.database },
  );
  return id;
}

/** `n` comparable local sales: around $350/sq ft, 1,200–1,800 sq ft, spread over the last ~10 months. */
export async function localSales(w: Pick<CmaWorld, 'h' | 'tenantId' | 'mls'>, n: number, o: Sale = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sqft = 1200 + ((i * 37) % 600);
    const beds = 2 + (i % 3);
    const days = 10 + ((i * 29) % 290);
    const price = Math.round(sqft * 35_000 * (1 + (300 - days) / 3000)) + (i % 5) * 100_000;
    ids.push(await mlsSale(w, { sqft, beds, bathsX10: 10 + (i % 3) * 5, closeDate: daysAgo(days), contractDate: daysAgo(days + 30), closePriceCents: price, originalListPriceCents: price, ...o }));
  }
  return ids;
}

/** A team listing of `agent` (through the API). */
export async function teamListing(agent: TestClient, o: Record<string, unknown> = {}): Promise<string> {
  const r = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', { addressLine1: '100 Sample Avenue', city: 'Oakland', region: 'CA', postalCode: '94110', status: 'active', propertyType: 'single_family', beds: 3, bathsX10: 20, sqft: 1500, listPriceCents: 55_000_000, ...o });
  if (r.status !== 201) throw new Error(`listing: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.listing.id;
}

export interface CmaBody {
  cma: {
    id: string;
    status: string;
    result: { available: boolean; reason: string | null; sentence: string; valueCents: number | null; lowCents: number | null; highCents: number | null };
    comps: { listingId: string; saleListingId: string; adjustments: { feature: string; amountCents: number }[]; adjustedPriceCents: number; weightBps: number; why: string[]; distanceSentence: string; sourceLabel: string; closePriceCents: number | null; saleConditions: string[] }[];
    notUsed: { listingId: string; reason: string; sentence: string; includable: boolean }[];
    subject: { kind: string; facts: Record<string, { value: unknown; source: string | null }>; saleHistory: { listingId: string }[]; sizeSentence: string; nearMatchDismissed: string[]; include: string[] };
    clientShare: { allowed: boolean; blockers: { code: string; sentence: string; count?: number; listingIds?: string[] }[] };
    nearMatches: { listingId: string; dismissed: boolean; avmDisplayAllowed: boolean }[];
    area: { tierUsed: string | null; tiers: { tier: string; ran: boolean; count: number; limitReached: boolean; sentence: string }[] };
    backtest: { tested: number; sentence: string };
    market: { sentence: string };
    context: { listingId: string }[];
    mlsDataAsOf: string | null;
    mlsDataAsOfSentence: string;
    createdByUserId: string;
    contactId: string | null;
    adjustmentRates: { feature: string; adjusted: boolean; sentence: string }[];
  };
}

export const codes = (b: CmaBody) => b.cma.clientShare.blockers.map((x) => x.code);

export async function oneTap(client: TestClient, contactId: string, body: Record<string, unknown> = {}) {
  return call<CmaBody>(client, 'POST', `/contacts/${contactId}/cma`, body);
}
