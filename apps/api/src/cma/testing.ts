// Test helpers for module 71 (imported by *.test.ts only). Synthetic data only: no real MLS, brokerage, person or
// address; fakes only, nothing is sent. MLS rows reach the database through lane V1-A's real pipeline: each fixture
// sale is a RESO record that V1-A's sync (syncConnection, with a deterministic record feed in place of a provider)
// normalizes and upserts as the system actor, so the address key, the sale facts, the AVM flag and the team-listing
// link are V1-A's. Contact addresses are written by the superuser fixture pool (no API in this lane writes them).
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import type { ResoLike } from '@realty/core/listings';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/index.js';
import { type LeadsWorld, call, leadsWorld, randomPhone } from '../leads/testing.js';
import { syncConnection } from '../mls/sync.js';
import { REVIEWED_PACK, makeDue, mlsConnection, mlsDeps, pagedFeed } from '../mls/testing.js';

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
            statements: { CA: { text: TEST_STATEMENT, min_point_size: 10 } },
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
  status?: 'sold' | 'active' | 'pending' | 'coming_soon' | 'withdrawn' | 'expired';
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
  saleConditions?: ('short_sale' | 'reo' | 'auction' | 'probate')[];
  daysOnMarket?: number | null;
  latE6?: number | null;
  lonE6?: number | null;
  sqft?: number | null;
  beds?: number | null;
  bathsX10?: number | null;
  yearBuilt?: number | null;
  subdivision?: string | null;
  propertyType?: 'single_family' | 'condo' | 'townhouse';
  isLease?: boolean;
  avmDisplayAllowed?: boolean;
  displayAllowed?: boolean;
  brokerage?: string;
}

let seq = 0;
/** Feed modification times: one second apart, in creation order (a later record is newer, as in a real feed). */
const BASE_MODIFIED = Date.now() - 86_400_000;

/**
 * Today's date (UTC) minus `days`, as YYYY-MM-DD. Never use it as "today" for a check the server makes in the tenant's
 * zone (batch 13 to-do, b14 round 2): from UTC midnight until the tenant's midnight it is a day ahead of a tenant west
 * of UTC. Use tenantDaysAgo for that.
 */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The tenant's own date minus `days` (negative: ahead), as YYYY-MM-DD: the database clock read in
 * tenant_settings.default_timezone, which is what the CMA checks compare with (service.ts checkInspectedOn:
 * localDateOf(now, zoneOf(tx)), `now` the transaction's clock_timestamp()). It never reads this process's clock, so a
 * pinned test clock does not move it.
 */
export async function tenantDaysAgo(h: ApiHarness, tenantId: string, days: number): Promise<string> {
  const r = await h.su.query<{ d: string }>(
    `SELECT to_char((clock_timestamp() AT TIME ZONE s.default_timezone)::date - $2::int, 'YYYY-MM-DD') AS d FROM tenant_settings s WHERE s.tenant_id = $1`,
    [tenantId, days],
  );
  if (!r.rows[0]) throw new Error(`tenantDaysAgo: no tenant_settings row for ${tenantId}`);
  return r.rows[0].d;
}

const RESO_STATUS: Record<NonNullable<Sale['status']>, string> = { sold: 'Closed', active: 'Active', pending: 'Pending', coming_soon: 'Coming Soon', withdrawn: 'Withdrawn', expired: 'Expired' };
const RESO_SUBTYPE: Record<NonNullable<Sale['propertyType']>, string> = { single_family: 'Single Family Residence', condo: 'Condominium', townhouse: 'Townhouse' };
const RESO_CONDITION: Record<NonNullable<Sale['saleConditions']>[number], string> = { short_sale: 'Short Sale', reo: 'Real Estate Owned', auction: 'Auction', probate: 'Probate Listing' };
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? null : (c / 100).toFixed(2));
const degrees = (e6: number | null) => (e6 === null ? null : (e6 / 1e6).toFixed(6));

/** One fixture sale as the RESO record an MLS feed sends (synthetic; standard RESO field names). */
export function saleReso(s: Sale = {}): ResoLike {
  seq += 1;
  const n = s.mlsNumber ?? `S${Date.now() % 1_000_000}-${seq}`;
  const status = s.status ?? 'sold';
  const sold = status === 'sold';
  return {
    ListingKey: `CK-${n}`,
    ListingId: n,
    StandardStatus: RESO_STATUS[status],
    ListPrice: dollars(s.listPriceCents ?? s.originalListPriceCents ?? 50_000_000),
    UnparsedAddress: s.line1 ?? `${200 + seq} Sample Ave`,
    UnitNumber: s.line2 ?? null,
    City: s.city ?? 'Oakland',
    StateOrProvince: s.region ?? 'CA',
    PostalCode: s.postalCode ?? '94110',
    BedroomsTotal: s.beds === undefined ? 3 : s.beds,
    BathroomsTotalInteger: s.bathsX10 === undefined ? 2 : s.bathsX10 === null ? null : s.bathsX10 / 10,
    LivingArea: s.sqft === undefined ? 1400 : s.sqft,
    PropertyType: s.isLease ? 'Residential Lease' : 'Residential',
    PropertySubType: RESO_SUBTYPE[s.propertyType ?? 'single_family'],
    ListOfficeName: s.brokerage ?? 'Other Brokerage (test)',
    ModificationTimestamp: new Date(BASE_MODIFIED + seq * 1000).toISOString(),
    InternetEntireListingDisplayYN: s.displayAllowed ?? true,
    InternetAddressDisplayYN: true,
    ClosePrice: sold ? dollars(s.closePriceCents === undefined ? 50_000_000 : s.closePriceCents) : dollars(s.closePriceCents),
    CloseDate: sold ? (s.closeDate === undefined ? daysAgo(60) : s.closeDate) : (s.closeDate ?? null),
    PurchaseContractDate: s.contractDate ?? null,
    OriginalListPrice: dollars(s.originalListPriceCents),
    ConcessionsAmount: dollars(s.concessionsCents),
    SpecialListingConditions: s.saleConditions?.map((c) => RESO_CONDITION[c]) ?? null,
    DaysOnMarket: s.daysOnMarket === undefined ? 20 : s.daysOnMarket,
    Latitude: degrees(s.latE6 === undefined ? HOME.latE6 + seq * 10 : s.latE6),
    Longitude: degrees(s.lonE6 === undefined ? HOME.lonE6 - seq * 10 : s.lonE6),
    YearBuilt: s.yearBuilt === undefined ? 1960 : s.yearBuilt,
    SubdivisionName: s.subdivision === undefined ? 'Sample Heights' : s.subdivision,
    InternetAutomatedValuationDisplayYN: (s.avmDisplayAllowed ?? true) ? 'Y' : 'N',
  };
}

/**
 * Feeds RESO records through lane V1-A's sync for the world's connection, exactly as a provider run would (the
 * connection made due, one fenced run, every record normalized and upserted by the system actor). Every record must
 * be stored. Returns the listing ids, in the records' order. The run moves last_synced_at to now, as a real run does.
 */
export async function syncSales(w: Pick<CmaWorld, 'h' | 'tenantId' | 'mls'>, records: ResoLike[]): Promise<string[]> {
  await makeDue(w.h, w.mls);
  const r = await syncConnection(mlsDeps(w.h, { [w.mls]: pagedFeed([records]) }), w.tenantId as TenantId, w.mls);
  if (r.outcome !== 'synced' || r.skippedInvalid !== 0 || r.inserted + r.updated !== records.length) throw new Error(`fixture sync: ${JSON.stringify(r)}`);
  const numbers = records.map((x) => String(x['ListingId']));
  const rows = (await w.h.su.query<{ id: string; mls_number: string }>("SELECT id, mls_number FROM listings WHERE tenant_id = $1 AND source = 'mls' AND mls_number = ANY ($2::text[])", [w.tenantId, numbers])).rows;
  const byNumber = new Map(rows.map((x) => [x.mls_number, x.id]));
  return numbers.map((n) => byNumber.get(n)!);
}

/** One MLS record stored through V1-A's sync. Returns its listing id. */
export async function mlsSale(w: Pick<CmaWorld, 'h' | 'tenantId' | 'mls'>, s: Sale = {}): Promise<string> {
  return (await syncSales(w, [saleReso(s)]))[0]!;
}

/** `n` comparable local sales (one sync run): around $350/sq ft, 1,200–1,800 sq ft, spread over the last ~10 months. */
export async function localSales(w: Pick<CmaWorld, 'h' | 'tenantId' | 'mls'>, n: number, o: Sale = {}): Promise<string[]> {
  const records: ResoLike[] = [];
  for (let i = 0; i < n; i++) {
    const sqft = 1200 + ((i * 37) % 600);
    const beds = 2 + (i % 3);
    const days = 10 + ((i * 29) % 290);
    const price = Math.round(sqft * 35_000 * (1 + (300 - days) / 3000)) + (i % 5) * 100_000;
    records.push(saleReso({ sqft, beds, bathsX10: 10 + (i % 3) * 5, closeDate: daysAgo(days), contractDate: daysAgo(days + 30), closePriceCents: price, originalListPriceCents: price, ...o }));
  }
  return syncSales(w, records);
}

/**
 * Sets when the feed last synced (E369's stale feed). A connection-state fixture, not a listing write: the sync above
 * moves last_synced_at to now on every run, so a stale feed is made after its records are stored.
 */
export async function feedLastSyncedAt(w: Pick<CmaWorld, 'h' | 'mls'>, at: Date): Promise<void> {
  await w.h.su.query('UPDATE integration_connections SET last_synced_at = $2 WHERE id = $1', [w.mls, at]);
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
    methodVersion: string;
    result: { available: boolean; reason: string | null; sentence: string; sentences: string[]; valueCents: number | null; lowCents: number | null; highCents: number | null };
    comps: { listingId: string; saleListingId: string; adjustments: { feature: string; amountCents: number }[]; adjustedPriceCents: number; weightBps: number; why: string[]; labels: string[]; includedByAgent: boolean; distanceM: number | null; sourceLabel: string; closePriceCents: number | null; saleConditions: string[]; facts: { beds: number | null; sqft: number | null; sizeSource: string | null } }[];
    notUsed: { listingId: string; reason: string; sentence: string; includable: boolean }[];
    subjectSales: { listingId: string }[];
    subject: { kind: string; facts: Record<string, { value: unknown; source: string | null }>; saleHistory: { listingId: string }[]; sizeSentence: string; factSentences: string[]; nearMatchDismissed: string[]; include: string[]; exclude: string[] };
    clientShare: { ready: boolean; sharingAvailable: false; sentence: string; blockers: { code: string; sentence: string; count?: number; listingIds?: string[] }[] };
    nearMatches: { listingId: string; dismissed: boolean; avmDisplayAllowed: boolean | null }[];
    area: { tier: string | null; tiersSkipped: string[]; reads: { tier: string; ran: boolean; rows: number; limitReached: boolean }[]; recordsLeftOut: number; sentences: string[] };
    backtest: { salesTested: number; sentence: string };
    market: { rates: { feature: string; applied: boolean; sentence: string }[]; sentences: string[] };
    context: { listingId: string }[];
    mlsDataAsOf: string | null;
    mlsDataAsOfSentence: string;
    createdByUserId: string;
    contactId: string | null;
  };
}

export const codes = (b: CmaBody) => b.cma.clientShare.blockers.map((x) => x.code);

export async function oneTap(client: TestClient, contactId: string, body: Record<string, unknown> = {}) {
  return call<CmaBody>(client, 'POST', `/contacts/${contactId}/cma`, body);
}

// ---- V2-A sharing fixtures (append only; synthetic, fakes only) ---------------------------------------------------

export interface ShareWorld extends CmaWorld {
  /** the agent of agents[0]'s email identity (a verified fixture domain; the fake email provider records every send) */
  identityId: string;
}

/**
 * A CMA world whose agents[0] can send email: a verified fixture sending domain on the fake provider, an identity for
 * agents[0], and the brokerage's postal address (the email footer). Nothing real is configured or sent.
 */
export async function shareWorld(h: ApiHarness, o: Parameters<typeof cmaWorld>[1] = {}): Promise<ShareWorld> {
  const w = await cmaWorld(h, o);
  const { freshReauth, suFixture } = await import('../leads/testing.js');
  await freshReauth(h, w.owner);
  const domain = `mail-${randomUUID().slice(0, 8)}.example.test`;
  h.providers.email.verifiedDomains.add(domain);
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain });
  if (dom.status !== 201) throw new Error(`sending domain: ${dom.status} ${JSON.stringify(dom.body)}`);
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  const ident = await call<{ identity: { id: string } }>(w.owner, 'POST', '/email-identities', { fromAddress: `agent-${randomUUID().slice(0, 6)}@${domain}`, displayName: 'Agent A (test)', userId: w.agents[0]!.userId, domainId: dom.body.domain.id });
  if (ident.status !== 201) throw new Error(`identity: ${ident.status} ${JSON.stringify(ident.body)}`);
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Sample Plaza, Oakland, CA 94110', brokerage_legal_name = 'Sample Brokerage (test)' WHERE tenant_id = $1", values: [w.tenantId] }]);
  return { ...w, identityId: ident.body.identity.id };
}

let emailN = 0;
/** A synthetic email address on the reserved example domain. */
export function fixtureEmail(): string {
  emailN += 1;
  return `seller-${Date.now() % 1_000_000}-${emailN}@example.test`;
}

/** A seller of `agent` with an email, a property address and an earlier MLS sale of the home (the CMA's facts). */
export async function emailSeller(w: CmaWorld, agent: TestClient, o: { name?: string; line1?: string; email?: string | null } = {}): Promise<{ c: string; email: string | null; line1: string }> {
  const email = o.email === undefined ? fixtureEmail() : o.email;
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: o.name ?? 'Sam Seller', firstName: (o.name ?? 'Sam Seller').split(' ')[0], phones: [randomPhone()], ...(email === null ? {} : { emails: [email] }), confirmDistinct: true });
  if (r.status !== 201 && r.status !== 200) throw new Error(`contact: ${r.status} ${JSON.stringify(r.body)}`);
  const c = r.body.contact.id;
  const line1 = o.line1 ?? `${1000 + Math.floor(Math.random() * 8000)} Sample Avenue`;
  await address(w.h, w.tenantId, c, { kind: 'property', line1 });
  await mlsSale(w, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
  return { c, email, line1 };
}

/** Records platform:cma's counsel review in THIS test database only, for `fn`, and clears it again (D9, D11). */
export async function withPlatformCmaCleared<T>(h: ApiHarness, fn: () => Promise<T>): Promise<T> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'");
  try {
    return await fn();
  } finally {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
  }
}

export interface PreviewBody {
  preview: {
    cmaId: string;
    contentSha256: string;
    reportSha256: string | null;
    subject: string | null;
    reportText: string | null;
    body: string | null;
    recipients: { contactId: string; firstName: string; relationship: string; emails: { id: string; address: string; status: string }[] }[];
    recipientContactId: string | null;
    toPointId: string | null;
    decision: { outcome: string; reasons: string[]; explanation: string } | null;
    warnings: { code: string; role: string; codePoints?: string[] }[];
    statement: { ok: boolean; part: string | null; reason: string | null; codePoints: string[] };
    tooLong: { parts: { role: string; chars: number }[] } | null;
    disclosureMissing: string[];
    fairHousing: { hard: { termId: string; where: string }[]; soft: { termId: string; where: string }[] };
    blockers: { code: string; sentence: string }[];
    stale: string | null;
    canShare: boolean;
    sentence: string | null;
  };
}

export async function sharePreview(client: TestClient, cmaId: string, q: { recipientContactId?: string; toPointId?: string } = {}) {
  const qs = new URLSearchParams(q as Record<string, string>).toString();
  return call<PreviewBody>(client, 'GET', `/cma/${cmaId}/share-preview${qs ? `?${qs}` : ''}`);
}

export interface ShareBodyOut {
  cma: CmaBody['cma'] & { share: { sharedByUserId: string; message: { id: string; status: string; statusReason: string | null; sentence: string } | null } | null; pdfAvailable: boolean; contentSha256: string };
  message: { id: string; status: string; result: string };
}

/** POST /cma/:id/share with what the preview showed (overrides for the stale and recipient cases). */
export async function shareFrom(client: TestClient, p: PreviewBody['preview'], o: Partial<{ recipientContactId: string; toPointId: string; contentSha256: string; reportSha256: string }> = {}) {
  return call<ShareBodyOut>(client, 'POST', `/cma/${p.cmaId}/share`, { recipientContactId: p.recipientContactId, toPointId: p.toPointId, contentSha256: p.contentSha256, reportSha256: p.reportSha256, ...o });
}

/** The share with dispatch:false (tests only, unreachable over HTTP): the email stays queued for the sweep and R-GATE-14 tests. */
export async function shareQueued(h: ApiHarness, client: TestClient, pv: PreviewBody['preview']) {
  const { shareCma } = await import('./share.js');
  const actor = client.actor();
  return shareCma((fn) => withTenantTx(actor, (tx, now) => fn(tx, now as number, actor), { db: h.app.platform.db }), depsFromPlatform(h.app.platform), actor, pv.cmaId, { recipientContactId: pv.recipientContactId!, toPointId: pv.toPointId!, contentSha256: pv.contentSha256, reportSha256: pv.reportSha256! }, { dispatch: false, recheck: async () => {} });
}
