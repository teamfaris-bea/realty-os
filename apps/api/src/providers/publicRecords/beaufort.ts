// The Beaufort County connector (owner decision D10; R-HOME-6; E565, E573, E575-E579, E588). It fills module 50's
// source-neutral PublicRecordsProvider (apps/api/src/predict/provider.ts): there is no second records adapter.
//
//  - `lookup` (the property lookup module 50's pass makes for every owned home) always throws not_configured
//    (PUBLIC_RECORDS_PROPERTY_LOOKUP_OFF): the county connector serves only recognised homeowners (D10), never predict.
//  - `lookupHomeowner` with live calls off throws not_configured (PUBLIC_RECORDS_LIVE_CALLS_OFF) before it builds any
//    request. An address outside Beaufort and the shared ZIPs is "not available" with no request. An address whose
//    tokens fail the strict patterns is rejected (ADDRESS_INVALID) before any request.
//  - Resolution: (1) the address point layer by the normalized street tokens; (2) the parcel polygon containing that
//    point, for the PIN, the owners and the tax-mail address; (3) only with useGisfileTable, the sale date and price by
//    PIN. Zero matches is no_record, more than one is ambiguous. Every value goes through core's strict
//    parseHomeownerRecord, so nothing beyond the closed field list survives.
//  - Input is ONE postal address (R-INT-1). Nothing is logged: no address, owner, PIN or county response.
// Every path and field is in fields.ts and is VERIFY.
import type { Clock } from '@realty/core/foundation';
import { connectorCountyOf, countyOf, parseHomeownerRecord, type HomeownerLookup } from '@realty/core/homeowner';
import { normalizeAddress, type PostalAddress } from '@realty/core/predict';
import type { PublicRecordLookup, PublicRecordsProvider } from '../../predict/provider.js';
import { ProviderError } from '../types.js';
import { ADDRESS_LAYER, BEAUFORT_DEFAULT_HOSTS, BEAUFORT_SERVICES_ROOT, BEAUFORT_SOURCE, GISFILE_TABLE, PARCEL_LAYER, USE_GISFILE_TABLE_DEFAULT } from './fields.js';
import { COUNTY_MAX_REQUESTS_PER_LOOKUP, CountyRateLimiter, checkCountyBaseUrl, countyGetJson, type CountyFetch } from './http.js';

export interface BeaufortOptions {
  /** PUBLIC_RECORDS_LIVE_CALLS: false ⇒ no request ever leaves the process */
  liveCalls: boolean;
  allowedHosts?: readonly string[];
  clock: Clock;
  fetch?: CountyFetch;
  sleep?: (ms: number) => Promise<void>;
  /** step 3 (sale date and price); off by default (VERIFY) */
  useGisfileTable?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  minIntervalMs?: number;
}

export const BEAUFORT_STATUS_OFF = 'Public records: Beaufort County GIS connector; live lookups are off on this platform';
export const BEAUFORT_STATUS_ON = 'Public records: Beaufort County GIS connector; live lookups are on on this platform';

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const STREET_TYPES = new Set(['st', 'ave', 'blvd', 'rd', 'dr', 'ln', 'ct', 'pl', 'ter', 'cir', 'pkwy', 'hwy', 'sq', 'trl', 'way']);
const TOKEN_RE = /^[A-Z0-9 ]{1,60}$/;
const NUMBER_RE = /^\d{1,6}[A-Z]?$/;

export interface StreetParts {
  number: string;
  preDirection: string | null;
  name: string;
  type: string | null;
  postDirection: string | null;
  unit: string | null;
  city: string;
  region: string;
  zip: string;
}

/** The street parts from normalizeAddress's tokens, uppercased; ADDRESS_INVALID (before any request) when they fail. */
export function streetParts(a: PostalAddress): StreetParts {
  const n = normalizeAddress(a);
  if (n === null) throw new ProviderError('rejected', 'ADDRESS_INVALID');
  const [line1, unitPart, city, region, zip] = n.split('|') as [string, string, string, string, string];
  const words = line1.split(' ');
  const number = (words.shift() ?? '').toUpperCase();
  let postDirection: string | null = null;
  let type: string | null = null;
  let preDirection: string | null = null;
  if (words.length > 1 && DIRECTIONS.has(words.at(-1)!)) postDirection = words.pop()!.toUpperCase();
  if (words.length > 1 && STREET_TYPES.has(words.at(-1)!)) type = words.pop()!.toUpperCase();
  if (words.length > 1 && DIRECTIONS.has(words[0]!)) preDirection = words.shift()!.toUpperCase();
  const name = words.join(' ').toUpperCase();
  const unit = unitPart === '' ? null : unitPart.replace(/^unit /, '').toUpperCase();
  const ok = NUMBER_RE.test(number) && TOKEN_RE.test(name) && [preDirection, type, postDirection, unit].every((x) => x === null || TOKEN_RE.test(x));
  if (!ok) throw new ProviderError('rejected', 'ADDRESS_INVALID');
  return { number, preDirection, name, type, postDirection, unit, city, region, zip };
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const eqOrEmpty = (field: string, v: string | null) => (v === null ? `(${field} IS NULL OR ${field} = '')` : `${field} = ${q(v)}`);

/** The step-1 where clause (built only from checked tokens; quotes doubled as a second guard). */
export function addressWhere(p: StreetParts): string {
  return [
    `${ADDRESS_LAYER.number} = ${q(p.number)}`,
    eqOrEmpty(ADDRESS_LAYER.preDirection, p.preDirection),
    `${ADDRESS_LAYER.name} = ${q(p.name)}`,
    eqOrEmpty(ADDRESS_LAYER.type, p.type),
    eqOrEmpty(ADDRESS_LAYER.postDirection, p.postDirection),
  ].join(' AND ');
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const features = (body: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(body.features) ? body.features.filter(isObj) : []);
const attr = (f: Record<string, unknown>, k: string): unknown => (isObj(f.attributes) ? f.attributes[k] : undefined);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

export class BeaufortGisRecords implements PublicRecordsProvider {
  readonly configured: boolean;
  /** the county connector is never a test source: with live calls off it is not configured and asks nobody */
  readonly test = false;
  readonly statusText: string;
  readonly #root: string;
  readonly #fetch: CountyFetch;
  readonly #limiter: CountyRateLimiter;
  readonly #clock: Clock;
  readonly #useGisfile: boolean;
  readonly #timeoutMs: number | undefined;
  readonly #maxBytes: number | undefined;
  /** requests made (count only; tests read it) */
  requests = 0;

  constructor(o: BeaufortOptions) {
    // refuses start-up when the code constant's host is not on the allow-list (or is not https)
    this.#root = checkCountyBaseUrl(BEAUFORT_SERVICES_ROOT, o.allowedHosts ?? BEAUFORT_DEFAULT_HOSTS);
    this.configured = o.liveCalls;
    this.statusText = o.liveCalls ? BEAUFORT_STATUS_ON : BEAUFORT_STATUS_OFF;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#clock = o.clock;
    this.#limiter = new CountyRateLimiter(() => o.clock.now(), o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), o.minIntervalMs);
    this.#useGisfile = o.useGisfileTable ?? USE_GISFILE_TABLE_DEFAULT;
    this.#timeoutMs = o.timeoutMs;
    this.#maxBytes = o.maxBytes;
  }

  /** Module 50's property lookup: the county connector never serves it (decision (b); R-PRED-2 unchanged). */
  async lookup(): Promise<PublicRecordLookup> {
    throw new ProviderError('not_configured', 'PUBLIC_RECORDS_PROPERTY_LOOKUP_OFF');
  }

  async lookupHomeowner(address: PostalAddress): Promise<HomeownerLookup> {
    if (!this.configured) throw new ProviderError('not_configured', 'PUBLIC_RECORDS_LIVE_CALLS_OFF');
    if (connectorCountyOf(countyOf(address)) !== 'sc-beaufort') return { status: 'not_available', detail: 'no_record' };
    const parts = streetParts(address);
    let budget = COUNTY_MAX_REQUESTS_PER_LOOKUP;
    const get = async (path: string, params: Record<string, string>) => {
      if (budget-- <= 0) throw new ProviderError('rejected', 'COUNTY_REQUEST_BUDGET');
      this.requests++;
      const o = { fetch: this.#fetch, limiter: this.#limiter, ...(this.#timeoutMs ? { timeoutMs: this.#timeoutMs } : {}), ...(this.#maxBytes ? { maxBytes: this.#maxBytes } : {}) };
      return countyGetJson(o, `${this.#root}/${path}/query`, params);
    };

    // 1. the address point
    const outFields = [ADDRESS_LAYER.number, ADDRESS_LAYER.preDirection, ADDRESS_LAYER.name, ADDRESS_LAYER.type, ADDRESS_LAYER.postDirection, ADDRESS_LAYER.unit, ADDRESS_LAYER.city, ADDRESS_LAYER.zip].filter((x): x is string => x !== null);
    const points = features(await get(ADDRESS_LAYER.path, { where: addressWhere(parts), outFields: outFields.join(','), returnGeometry: 'true', outSR: '4326' }))
      .filter((f) => (parts.unit === null ? true : text(attr(f, ADDRESS_LAYER.unit))?.toUpperCase() === parts.unit));
    if (points.length === 0) return { status: 'not_available', detail: 'no_record' };
    if (points.length > 1) return { status: 'not_available', detail: 'ambiguous' };
    const pt = points[0]!;
    const g = isObj(pt.geometry) ? pt.geometry : null;
    const x = g && typeof g.x === 'number' && Number.isFinite(g.x) ? g.x : null;
    const y = g && typeof g.y === 'number' && Number.isFinite(g.y) ? g.y : null;
    if (x === null || y === null) return { status: 'not_available', detail: 'no_record' };

    // 2. the parcel containing the point
    const parcels = features(await get(PARCEL_LAYER.path, {
      geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: [PARCEL_LAYER.pin, PARCEL_LAYER.owner1, PARCEL_LAYER.owner2, PARCEL_LAYER.mailing].join(','), returnGeometry: 'false',
    }));
    if (parcels.length === 0) return { status: 'not_available', detail: 'no_record' };
    if (parcels.length > 1) return { status: 'not_available', detail: 'ambiguous' };
    const parcel = parcels[0]!;
    const pin = text(attr(parcel, PARCEL_LAYER.pin));

    // 3. sale date and price by PIN (off by default)
    const homeowner: Record<string, unknown> = { owner_mailing_address: attr(parcel, PARCEL_LAYER.mailing) };
    if (this.#useGisfile && pin !== null && /^[A-Za-z0-9._:-]{1,120}$/.test(pin)) {
      const rows = features(await get(GISFILE_TABLE.path, { where: `${GISFILE_TABLE.pin} = ${q(pin)}`, outFields: [GISFILE_TABLE.saleDate, GISFILE_TABLE.salePrice].join(','), returnGeometry: 'false' }));
      if (rows.length === 1) {
        const d = attr(rows[0]!, GISFILE_TABLE.saleDate);
        const p = attr(rows[0]!, GISFILE_TABLE.salePrice);
        if (typeof d === 'number' && Number.isFinite(d)) homeowner.last_transfer_date = new Date(d).toISOString().slice(0, 10);
        if (typeof p === 'number' && Number.isSafeInteger(p * 100)) homeowner.last_transfer_price_cents = p * 100;
      }
    }

    // the record's address: the layer's street parts; city and ZIP from the layer when mapped, else from the request
    // (the street match was unique county-wide)
    const pa = [ADDRESS_LAYER.number, ADDRESS_LAYER.preDirection, ADDRESS_LAYER.name, ADDRESS_LAYER.type, ADDRESS_LAYER.postDirection].map((k) => text(attr(pt, k))).filter((s): s is string => s !== null);
    const unit = text(attr(pt, ADDRESS_LAYER.unit));
    const city = ADDRESS_LAYER.city ? text(attr(pt, ADDRESS_LAYER.city)) : address.city;
    const zip = ADDRESS_LAYER.zip ? text(attr(pt, ADDRESS_LAYER.zip)) : parts.zip;
    const raw = {
      address: { line1: pa.join(' '), line2: unit ? `UNIT ${unit}` : null, city, region: 'SC', postalCode: zip },
      ownerNames: [attr(parcel, PARCEL_LAYER.owner1), attr(parcel, PARCEL_LAYER.owner2)],
      source: BEAUFORT_SOURCE,
      providerRef: pin,
      homeowner,
    };
    return parseHomeownerRecord(raw, { today: new Date(this.#clock.now()).toISOString().slice(0, 10) });
  }
}
