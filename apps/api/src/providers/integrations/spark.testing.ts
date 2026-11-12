// Test-only mock Spark RESO server and a network tripwire (imported by *.test.ts only; no real Spark call
// is ever made by the suite). The mock is a transport (SparkFetch): it records every request it receives
// and answers from a handler; the tripwire makes any real outbound connection fail the test.
import net from 'node:net';
import tls from 'node:tls';
import type { SparkFetch } from './spark.js';

/** An obvious fake: the suites search every output channel for it. */
export const CANARY_TOKEN = 'CANARY-spark-token-DO-NOT-USE-0000';

export interface MockCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect: string;
}

export type MockReply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string | Uint8Array };

export interface MockSpark {
  fetch: SparkFetch;
  calls: MockCall[];
  handler: (c: MockCall) => MockReply | Promise<MockReply>;
}

export function mockSpark(handler: MockSpark['handler'] = () => ({ status: 200, body: { value: [] } })): MockSpark {
  const m: MockSpark = {
    calls: [],
    handler,
    fetch: async (url, init) => {
      const c: MockCall = { url: new URL(url), method: init.method, headers: { ...init.headers }, redirect: init.redirect };
      m.calls.push(c);
      const r = await m.handler(c);
      const body = r.raw !== undefined ? r.raw : r.body === undefined ? null : JSON.stringify(r.body);
      return new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
    },
  };
  return m;
}

/** A RESO Property record (all fields the adapter maps; no LivingArea, as in the live feed: finding 5). */
export function property(i: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ListingKey: `LK${String(i).padStart(4, '0')}`,
    ListingId: `MLS${i}`,
    StandardStatus: 'Active',
    ListPrice: 400000 + i,
    StreetNumber: String(100 + i),
    StreetName: 'Example',
    StreetSuffix: 'St',
    City: 'Exampleton',
    StateOrProvince: 'ZZ',
    PostalCode: '00000',
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    BuildingAreaTotal: 1500.4,
    PropertyType: 'Residential',
    ListOfficeName: 'Example Brokerage',
    ModificationTimestamp: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    ...o,
  };
}

// ---- the live shape (docs/SECURITY.md §5.3; findings 1-9 of the 2026-11-11 read-only check) ------------
//
// Field names are standard RESO plus two synthetic local fields; no real MLS, account or local field name.

export const STANDARD_HOST = 'sparkapi.com';
export const REPLICATION_HOST = 'replication.sparkapi.com';
/** An obvious fake key identifier the mock echoes in X-Api-Key on every response (finding 8). */
export const CANARY_KEY_ID = 'CANARY-spark-key-id-0000';
export const REPLICATION_403 = { error: { code: 403, message: 'This key is restricted from accessing this endpoint. Please use replication.sparkapi.com' } };
export const BUSY_503 = { error: { code: 503, message: 'The requested operation took too long to perform.' } };

/** $metadata: five entity sets, no Media set; Media is a navigation property of Property (findings 2, 6). */
export const LIVE_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="ResoSchema" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EnumType Name="OnlyOneEnum"><Member Name="A" Value="0"/></EnumType>
<EntityType Name="Property"><Key><PropertyRef Name="ListingKey"/></Key>
<Property Name="ListingKey" Type="Edm.String"/><Property Name="ModificationTimestamp" Type="Edm.DateTimeOffset"/>
<Property Name="PhotosChangeTimestamp" Type="Edm.DateTimeOffset"/><Property Name="StandardStatus" Type="Edm.String"/>
<Property Name="ListPrice" Type="Edm.Decimal"/><Property Name="BuildingAreaTotal" Type="Edm.Decimal"/>
<Property Name="PhotosCount" Type="Edm.Int64"/><Property Name="InternetEntireListingDisplayYN" Type="Edm.Boolean"/>
<Property Name="InternetAddressDisplayYN" Type="Edm.Boolean"/><Property Name="InternetConsumerCommentYN" Type="Edm.Boolean"/>
<Property Name="InternetAutomatedValuationDisplayYN" Type="Edm.Boolean"/><Property Name="ListAgentEmail" Type="Edm.String"/>
<Property Name="ListAgentDirectPhone" Type="Edm.String"/>
<NavigationProperty Name="Media" Type="Collection(ResoSchema.Media)"/><NavigationProperty Name="OpenHouse" Type="Collection(ResoSchema.OpenHouse)"/>
<NavigationProperty Name="OpenHouses" Type="Collection(ResoSchema.OpenHouse)"/><NavigationProperty Name="HistoryTransactional" Type="Collection(ResoSchema.HistoryTransactional)"/>
</EntityType>
<EntityType Name="Media"><Key><PropertyRef Name="MediaKey"/></Key><Property Name="MediaKey" Type="Edm.String"/><Property Name="ShortDescription" Type="Edm.String"/>
<Property Name="MediaURL" Type="Edm.String"/><Property Name="LongDescription" Type="Edm.String"/><Property Name="MediaHTML" Type="Edm.String"/>
<Property Name="MediaCategory" Type="Edm.String"/><Property Name="OriginatingSystemMediaKey" Type="Edm.String"/><Property Name="ResourceRecordID" Type="Edm.String"/>
<Property Name="Permission" Type="Collection(Edm.String)"/><Property Name="PreferredPhotoYN" Type="Edm.Boolean"/><Property Name="Order" Type="Edm.Int64"/>
<Property Name="ResourceRecordKey" Type="Edm.String"/></EntityType>
<EntityContainer Name="Default"><EntitySet Name="Property" EntityType="ResoSchema.Property"/><EntitySet Name="Member" EntityType="ResoSchema.Member"/>
<EntitySet Name="Office" EntityType="ResoSchema.Office"/><EntitySet Name="OpenHouse" EntityType="ResoSchema.OpenHouse"/><EntitySet Name="Lookup" EntityType="ResoSchema.Lookup"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

/** One Media entry as the live feed returns it (finding 3: Order is Edm.Int64). */
export function liveMedia(listingKey: string, order: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MediaKey: `MK-${listingKey}-${order}`,
    ShortDescription: null,
    MediaURL: `https://photos.example.invalid/${listingKey}/${order}.jpg`,
    LongDescription: null,
    MediaHTML: null,
    MediaCategory: 'Photo',
    OriginatingSystemMediaKey: `OSMK-${order}`,
    ResourceRecordID: listingKey,
    Permission: ['Public'],
    PreferredPhotoYN: order === 1,
    Order: order,
    ResourceRecordKey: listingKey,
    ...o,
  };
}

/**
 * A Property record in the live shape (findings 4-6): declared RESO fields, undeclared extras, field-level
 * permission annotations (one withholding the remarks), BuildingAreaTotal (no LivingArea), an empty
 * AboveGradeFinishedArea and empty list-agent contact fields. Media only when `expand` is set.
 */
export function liveProperty(i: number, o: Record<string, unknown> = {}, expand = true): Record<string, unknown> {
  const key = `LK${String(i).padStart(4, '0')}`;
  const base: Record<string, unknown> = {
    ...property(i),
    PhotosChangeTimestamp: '2026-10-31T00:00:00Z',
    PhotosCount: 2,
    InternetEntireListingDisplayYN: true,
    InternetAddressDisplayYN: true,
    InternetConsumerCommentYN: false,
    InternetAutomatedValuationDisplayYN: false,
    AboveGradeFinishedArea: null,
    ListAgentEmail: null,
    ListAgentDirectPhone: '',
    PublicRemarks: 'WITHHELD-REMARKS-MARKER bright corner home',
    'PublicRemarks@Core.Permissions': 'None',
    'ListPrice@Core.Permissions': 'Read',
    // fields $metadata does not declare (the live record carried hundreds)
    ZZ_SyntheticLocalCode: 'Q7',
    ZZ_SyntheticLocalFlag: 'Y',
    'ZZ_SyntheticLocalFlag@Core.Permissions': ['Read'],
    ...o,
  };
  if (expand) base['Media'] = [liveMedia(key, 2), liveMedia(key, 1)];
  return base;
}

/**
 * A closed sale in the live shape (D9): liveProperty plus the RESO sale and property fields the sold-data sync stores.
 * Synthetic values only. Longitude is western (negative) text, as live feeds send it.
 */
export function liveClosedProperty(i: number, o: Record<string, unknown> = {}, expand = true): Record<string, unknown> {
  return liveProperty(
    i,
    {
      StandardStatus: 'Closed',
      ClosePrice: 395000 + i * 100,
      CloseDate: '2026-09-15',
      PurchaseContractDate: '2026-08-20',
      OriginalListPrice: 410000 + i * 100,
      ConcessionsAmount: 5000,
      SpecialListingConditions: 'Standard',
      DaysOnMarket: 26,
      Latitude: 32.7801234,
      Longitude: '-79.9305678',
      YearBuilt: 2003,
      LotSizeAcres: 0.15,
      LotSizeUnits: 'Acres',
      SubdivisionName: 'Example Commons',
      GarageSpaces: 2,
      PoolPrivateYN: false,
      Stories: 1.5,
      InternetAutomatedValuationDisplayYN: true,
      'ClosePrice@Core.Permissions': 'Read',
      ...o,
    },
    expand,
  );
}

export interface LiveSparkOptions {
  /** records the Property set holds (sorted by the mock like Spark: ModificationTimestamp, ListingKey) */
  records?: () => Record<string, unknown>[];
  /** largest page the mock honours (Spark may honour less than $top asks) */
  pageSize?: number;
  /** answer the next n Property requests with the transient 503 (finding 7) */
  busyNext?: number;
  /** whether $select inside $expand is honoured (VERIFY): false strips nothing either way */
  honourExpandSelect?: boolean;
}

/**
 * A mock Spark that reproduces the live shape: the standard host refuses a replication key (403 naming the
 * replication host); the replication host serves $metadata and Property (no Media entity set: 404), expands
 * Media only on request, pages with an absolute nextLink on the replication host, and echoes an X-Api-Key
 * header on every response.
 */
export function liveSpark(o: LiveSparkOptions = {}): MockSpark & { opts: LiveSparkOptions } {
  const opts: LiveSparkOptions = { pageSize: 50, busyNext: 0, ...o };
  const headers = { 'x-api-key': CANARY_KEY_ID };
  const m = mockSpark((c) => {
    if (c.url.hostname === STANDARD_HOST) return { status: 403, body: REPLICATION_403, headers };
    if (c.url.hostname !== REPLICATION_HOST) return { status: 404, body: { error: { code: 404, message: 'unknown host' } }, headers };
    if (c.url.pathname === '/Reso/OData/$metadata') return { status: 200, raw: LIVE_METADATA, headers: { ...headers, 'content-type': 'application/xml' } };
    if (c.url.pathname !== '/Reso/OData/Property') return { status: 404, body: { error: { code: 404, message: 'Resource not found' } }, headers };
    if ((opts.busyNext ?? 0) > 0) {
      opts.busyNext! -= 1;
      return { status: 503, body: BUSY_503, headers };
    }
    const sp = c.url.searchParams;
    const top = Math.min(Number(sp.get('$top') ?? '10'), opts.pageSize ?? 50);
    const skip = Number(sp.get('$skip') ?? '0');
    const select = sp.get('$select');
    const expand = sp.get('$expand');
    let all = (opts.records?.() ?? []).map((r) => ({ ...r }));
    all.sort((a, b) => (String(a['ModificationTimestamp']) + String(a['ListingKey']) < String(b['ModificationTimestamp']) + String(b['ListingKey']) ? -1 : 1));
    const f = sp.get('$filter') ?? '';
    const byKey = /^ListingKey eq '([^']*)'$/.exec(f);
    const after = /^ModificationTimestamp gt (\S+) or \(ModificationTimestamp eq \S+ and ListingKey gt '([^']*)'\)$/.exec(f);
    if (byKey) all = all.filter((r) => r['ListingKey'] === byKey[1]);
    else if (after) {
      const ts = new Date(after[1]!).toISOString();
      all = all.filter((r) => {
        const rts = new Date(String(r['ModificationTimestamp'])).toISOString();
        return rts > ts || (rts === ts && String(r['ListingKey']) > after[2]!);
      });
    }
    const pageRows = all.slice(skip, skip + top).map((r) => {
      const out: Record<string, unknown> = { ...r };
      if (!expand || !/^Media(\(|$)/.test(expand)) delete out['Media'];
      else if (opts.honourExpandSelect && /\$select=/.test(expand) && Array.isArray(out['Media'])) {
        const keep = /\$select=([^)]*)/.exec(expand)![1]!.split(',');
        out['Media'] = (out['Media'] as Record<string, unknown>[]).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => keep.includes(k))));
      }
      if (select) {
        const keep = new Set(select.split(','));
        if (expand) keep.add('Media');
        for (const k of Object.keys(out)) if (!keep.has(k.split('@')[0]!)) delete out[k];
      }
      return out;
    });
    const body: Record<string, unknown> = { '@odata.context': `https://${REPLICATION_HOST}/Reso/OData/$metadata#Property`, value: pageRows };
    // finding 9: a $top=1 request (the probe) carries no nextLink and no count
    if (top > 1 && skip + top < all.length) {
      const next = new URL(c.url.href);
      next.searchParams.set('$skip', String(skip + top));
      body['@odata.nextLink'] = next.href;
    }
    return { status: 200, body, headers };
  });
  return Object.assign(m, { opts });
}

export interface Tripwire {
  attempts: string[];
  restore(): void;
}

/**
 * Real outbound traffic fails: global fetch throws, and TCP/TLS connects to anything but loopback (the test
 * Postgres) throw. Every attempt is recorded so a test can assert none happened.
 */
export function installNetworkTripwire(): Tripwire {
  const attempts: string[] = [];
  const origFetch = globalThis.fetch;
  const origConnect = net.Socket.prototype.connect;
  const origTls = tls.connect;
  const loopback = (h: unknown) => h === undefined || h === 'localhost' || h === '127.0.0.1' || h === '::1' || (typeof h === 'string' && h.startsWith('/'));
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(`fetch ${String(input instanceof URL ? input.href : typeof input === 'string' ? input : 'request')}`);
    throw new Error('network access is forbidden in tests');
  }) as typeof fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const a = args[0] as { host?: string; path?: string } | number | string;
    const host = typeof a === 'object' && a !== null ? (a.path ?? a.host) : typeof args[1] === 'string' ? args[1] : typeof a === 'string' ? a : undefined;
    if (!loopback(host)) {
      attempts.push(`connect ${String(host)}`);
      throw new Error('network access is forbidden in tests');
    }
    return (origConnect as (...x: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  (tls as { connect: unknown }).connect = (...args: unknown[]) => {
    const a = args[0] as { host?: string } | number;
    const host = typeof a === 'object' ? a.host : args[1];
    if (!loopback(host)) {
      attempts.push(`tls ${String(host)}`);
      throw new Error('network access is forbidden in tests');
    }
    return (origTls as (...x: unknown[]) => tls.TLSSocket)(...args);
  };
  return {
    attempts,
    restore() {
      globalThis.fetch = origFetch;
      net.Socket.prototype.connect = origConnect;
      (tls as { connect: unknown }).connect = origTls;
    },
  };
}
