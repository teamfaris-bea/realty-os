// Read-only Spark RESO Web API adapter (docs/DEPLOY.md and docs/SECURITY.md "Spark MLS (read-only)").
//
//   const feed = new SparkResoMlsFeed({ baseUrl, allowedHosts, authScheme, liveCalls, accessToken });
//   await feed.changes(cursor, 200)     incremental by ModificationTimestamp (ties by ListingKey)
//   await feed.media(listingKey)        photo references (URLs only; never re-hosted here, R-MLS-4)
//   await feed.probe()                  the single validation request (no retry)
//
// Safety rules, all enforced HERE (the adapter layer), not by callers:
//  - GET only: any other method is refused before anything else happens (METHOD_NOT_ALLOWED).
//  - https only, default port, no userinfo, host on the configured allow-list, path on SPARK_PATHS
//    exactly; every @odata.nextLink is re-checked against the same rules before it is fetched.
//  - Redirects are never followed (redirect: 'manual'; any 3xx is REDIRECT_REFUSED), so the token never
//    leaves the configured host.
//  - Per-request timeout, response size cap, 429/5xx/network backoff with jitter inside a retry budget.
//  - Kill switch: with liveCalls false NO request leaves the process (LIVE_CALLS_DISABLED), even with a token.
//  - The access token is only ever placed in the Authorization header. Errors carry codes and HTTP status
//    only: never the token, a header, a URL with a query, or a response body.
//
// VERIFY with Spark (public docs as read by the owner; nothing here was tried against a live account):
//  - the Authorization scheme ("Bearer" or "OAuth"; SPARK_AUTH_SCHEME, default Bearer);
//  - whether a full background sync must use Spark's separate replication endpoint (SPARK_API_BASE_URL);
//  - the largest $top Spark accepts, $orderby on ListingKey, and the composite $filter used for the cursor;
//  - how Media is exposed (a Media resource filtered by ResourceRecordKey vs. $expand=Media on Property);
//  - which RESO fields each MLS actually populates (records missing a required field are skipped).
import { priceToCents } from '@realty/core/listings';
import { ProviderError } from '../types.js';
import type { LicensePack, MediaRef, MlsFeed, MlsPage, ResoListing } from './types.js';

/** The only paths the adapter may request (exact match). Member/Office/OpenHouse are not needed by core/listings. */
export const SPARK_PATHS = ['/Reso/OData/$metadata', '/Reso/OData/Property', '/Reso/OData/Media'] as const;

export const SPARK_ERROR_CODES = [
  'LIVE_CALLS_DISABLED',
  'METHOD_NOT_ALLOWED',
  'PATH_NOT_ALLOWED',
  'HOST_NOT_ALLOWED',
  'REDIRECT_REFUSED',
  'INVALID_CREDENTIALS',
  'NOT_LICENSED_OR_ROLE_INSUFFICIENT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UNREACHABLE',
  'BAD_RESPONSE',
] as const;
export type SparkErrorCode = (typeof SPARK_ERROR_CODES)[number];

const KIND: Record<SparkErrorCode, ProviderError['kind']> = {
  LIVE_CALLS_DISABLED: 'not_configured',
  METHOD_NOT_ALLOWED: 'rejected',
  PATH_NOT_ALLOWED: 'rejected',
  HOST_NOT_ALLOWED: 'rejected',
  REDIRECT_REFUSED: 'rejected',
  INVALID_CREDENTIALS: 'rejected',
  NOT_LICENSED_OR_ROLE_INSUFFICIENT: 'rejected',
  NOT_FOUND: 'rejected',
  RATE_LIMITED: 'unavailable',
  UNREACHABLE: 'unavailable',
  BAD_RESPONSE: 'unavailable',
};

/** A Spark failure: a code and (when one was received) the HTTP status. Nothing else, ever. */
export class SparkError extends ProviderError {
  constructor(
    readonly code: SparkErrorCode,
    readonly httpStatus: number | null = null,
  ) {
    super(KIND[code], code);
  }
}

export class SparkConfigError extends Error {
  override readonly name = 'SparkConfigError';
}

/** The transport (global fetch in production; a mock Spark server in tests). Only ever called with GET. */
export type SparkFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export interface SparkOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  authScheme: 'Bearer' | 'OAuth';
  /** MLS_LIVE_CALLS: false ⇒ no request ever leaves the process */
  liveCalls: boolean;
  accessToken: string;
  fetch?: SparkFetch;
  /** per request, ms (default 20 s) */
  timeoutMs?: number;
  /** largest response body read, bytes (default 16 MiB) */
  maxBytes?: number;
  /** attempts per request incl. the first (default 4) and retries per operation across pages (default 8) */
  retry?: { attempts?: number; budget?: number; baseDelayMs?: number; maxDelayMs?: number };
  /** $top per page (default 200; VERIFY Spark's maximum) */
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const SPARK_DEFAULT_BASE_URL = 'https://sparkapi.com';
export const SPARK_DEFAULT_ALLOWED_HOSTS: readonly string[] = ['sparkapi.com'];
export const SPARK_MAX_BYTES = 16 * 1024 * 1024;
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/** The base URL the adapter may use: https origin on the default port whose host is on the allow-list. */
export function checkSparkBaseUrl(raw: string, allowedHosts: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SparkConfigError('Spark base URL is not a URL');
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || (u.pathname !== '/' && u.pathname !== '')) {
    throw new SparkConfigError('Spark base URL must be an https origin on the default port');
  }
  if (!allowedHosts.map(normHost).includes(normHost(u.hostname))) throw new SparkConfigError('Spark base URL host is not on the allow-list');
  return u.origin;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new SparkError('BAD_RESPONSE', res.status);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new SparkError('BAD_RESPONSE', res.status);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Retry-After in ms (delta seconds only; an HTTP date is ignored), or null. */
function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return null;
  return Number(v.trim()) * 1000;
}

const isRetryable = (c: SparkErrorCode) => c === 'RATE_LIMITED' || c === 'UNREACHABLE';

/** The low-level, GET-only, allow-listed Spark client. */
export class SparkResoClient {
  private readonly base: string;
  private readonly hosts: string[];
  private readonly doFetch: SparkFetch;
  private readonly authorization: string;
  readonly liveCalls: boolean;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly attempts: number;
  private readonly budget: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(o: SparkOptions) {
    this.hosts = o.allowedHosts.map(normHost).filter((h) => h !== '');
    this.base = checkSparkBaseUrl(o.baseUrl, this.hosts);
    if (o.authScheme !== 'Bearer' && o.authScheme !== 'OAuth') throw new SparkConfigError('Spark auth scheme must be Bearer or OAuth');
    if (!TOKEN_RE.test(o.accessToken)) throw new SparkConfigError('Spark access token has an invalid shape'); // never echoes it
    this.authorization = `${o.authScheme} ${o.accessToken}`;
    this.liveCalls = o.liveCalls === true;
    this.doFetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.maxBytes = o.maxBytes ?? SPARK_MAX_BYTES;
    this.attempts = Math.max(1, o.retry?.attempts ?? 4);
    this.budget = Math.max(0, o.retry?.budget ?? 8);
    this.baseDelayMs = o.retry?.baseDelayMs ?? 500;
    this.maxDelayMs = o.retry?.maxDelayMs ?? 30_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
  }

  /** An absolute URL for an allow-listed path and a pre-encoded OData query. */
  url(path: (typeof SPARK_PATHS)[number], query = ''): string {
    return `${this.base}${path}${query ? `?${query}` : ''}`;
  }

  /** The target rules (also applied to every nextLink). Returns the normalized URL. */
  checkTarget(target: string): string {
    let u: URL;
    try {
      u = new URL(target, this.base);
    } catch {
      throw new SparkError('PATH_NOT_ALLOWED');
    }
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || !this.hosts.includes(normHost(u.hostname))) throw new SparkError('HOST_NOT_ALLOWED');
    if (u.hash !== '' || !(SPARK_PATHS as readonly string[]).includes(u.pathname)) throw new SparkError('PATH_NOT_ALLOWED');
    return u.href;
  }

  /** One logical request with retries. `retries` is shared by every request of one operation. */
  async request(method: string, target: string, o: { retries?: { left: number }; accept?: string } = {}): Promise<Uint8Array> {
    // order matters: method and target are refused even when live calls are on; nothing below runs otherwise
    if (method !== 'GET') throw new SparkError('METHOD_NOT_ALLOWED');
    const url = this.checkTarget(target);
    if (!this.liveCalls) throw new SparkError('LIVE_CALLS_DISABLED');
    const retries = o.retries ?? { left: this.budget };
    for (let attempt = 1; ; attempt++) {
      let wait: number | null = null;
      let failure: SparkError;
      try {
        let res: Response;
        try {
          res = await this.doFetch(url, {
            method: 'GET',
            headers: { authorization: this.authorization, accept: o.accept ?? 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch {
          throw new SparkError('UNREACHABLE'); // network error or timeout; the cause may quote the URL, so it is dropped
        }
        const s = res.status;
        if (s >= 200 && s < 300) return await readCapped(res, this.maxBytes);
        await res.body?.cancel().catch(() => undefined);
        if (s === 0 || (s >= 300 && s < 400)) throw new SparkError('REDIRECT_REFUSED', s || null);
        if (s === 401) throw new SparkError('INVALID_CREDENTIALS', s);
        if (s === 403) throw new SparkError('NOT_LICENSED_OR_ROLE_INSUFFICIENT', s);
        if (s === 404) throw new SparkError('NOT_FOUND', s);
        if (s === 429) {
          wait = retryAfterMs(res);
          throw new SparkError('RATE_LIMITED', s);
        }
        if (s >= 500) {
          wait = retryAfterMs(res);
          throw new SparkError('UNREACHABLE', s);
        }
        throw new SparkError('BAD_RESPONSE', s);
      } catch (e) {
        failure = e instanceof SparkError ? e : new SparkError('BAD_RESPONSE');
      }
      if (!isRetryable(failure.code) || attempt >= this.attempts || retries.left <= 0) throw failure;
      retries.left -= 1;
      const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
      const jittered = backoff / 2 + this.random() * (backoff / 2);
      await this.sleep(Math.min(this.maxDelayMs, Math.max(wait ?? 0, jittered)));
    }
  }

  async json(target: string, o: { retries?: { left: number } } = {}): Promise<Record<string, unknown>> {
    const bytes = await this.request('GET', target, o);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SparkError('BAD_RESPONSE');
    return body as Record<string, unknown>;
  }

  newRetryBudget(): { left: number } {
    return { left: this.budget };
  }
}

// ---- RESO record → ResoListing -------------------------------------------------------------------------

const STATUS: Record<string, ResoListing['standardStatus']> = {
  active: 'Active',
  activeundercontract: 'Pending',
  pending: 'Pending',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  canceled: 'Canceled',
  cancelled: 'Canceled',
  comingsoon: 'ComingSoon',
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The record's cursor position, or null when it has no usable ModificationTimestamp / ListingKey. */
export function positionOf(raw: Record<string, unknown>): { ts: string; key: string } | null {
  const key = text(raw['ListingKey']);
  const ts = text(raw['ModificationTimestamp']);
  if (key === null || ts === null || !KEY_RE.test(key) || !ISO_OFFSET.test(ts)) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return { ts: d.toISOString(), key };
}

/**
 * One RESO Property record as the existing ResoListing shape, or null when a required field is missing
 * (the sync skips it; core/listings normalizeMlsListing and applyDisplayRules still decide what any audience
 * may see). Required: ListingKey, ModificationTimestamp, StandardStatus, ListPrice, ListOfficeName (R-MLS-1).
 */
export function toResoListing(raw: Record<string, unknown>): ResoListing | null {
  const pos = positionOf(raw);
  const statusText = text(raw['StandardStatus']);
  const status = statusText ? STATUS[statusText.toLowerCase().replace(/[\s_-]+/g, '')] : undefined;
  const price = priceToCents(raw['ListPrice']);
  const office = text(raw['ListOfficeName']);
  if (!pos || !status || price === null || office === null) return null;
  const street = ['StreetNumber', 'StreetDirPrefix', 'StreetName', 'StreetSuffix', 'StreetDirSuffix'].map((k) => text(raw[k])).filter((x): x is string => x !== null).join(' ');
  const unit = text(raw['UnitNumber']);
  const beds = nonNeg(raw['BedroomsTotal']);
  const baths = nonNeg(raw['BathroomsTotalInteger']);
  const area = nonNeg(raw['LivingArea']);
  return {
    listingKey: pos.key,
    listingId: text(raw['ListingId']) ?? pos.key,
    standardStatus: status,
    listPriceCents: price,
    unparsedAddress: text(raw['UnparsedAddress']) ?? (street + (unit ? ` #${unit}` : '')),
    city: text(raw['City']) ?? '',
    stateOrProvince: text(raw['StateOrProvince']) ?? '',
    postalCode: text(raw['PostalCode']) ?? '',
    bedroomsTotal: beds !== null && Number.isInteger(beds) ? beds : null,
    bathroomsTotalX10: baths !== null && Number.isInteger(baths) ? baths * 10 : null,
    livingAreaSqft: area !== null ? Math.round(area) : null,
    propertyType: text(raw['PropertyType']) ?? '',
    listOfficeName: office,
    modificationTimestamp: pos.ts,
  };
}

// ---- cursor ----------------------------------------------------------------------------------------------

/** Cursor = `<ISO ModificationTimestamp>|<ListingKey>` of the last record returned. */
export function encodeCursor(p: { ts: string; key: string }): string {
  return `${p.ts}|${p.key}`;
}

export function decodeCursor(c: string): { ts: string; key: string } {
  const i = c.indexOf('|');
  const ts = c.slice(0, i);
  const key = c.slice(i + 1);
  if (i <= 0 || !ISO_OFFSET.test(ts) || Number.isNaN(new Date(ts).getTime()) || !KEY_RE.test(key)) throw new SparkError('BAD_RESPONSE');
  return { ts: new Date(ts).toISOString(), key };
}

const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const q = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

export interface SparkPage extends MlsPage {
  /** records skipped because a required field was missing or invalid */
  skipped: number;
}

/** The read-only MlsFeed over Spark's RESO Web API. */
export class SparkResoMlsFeed implements MlsFeed {
  readonly access = 'available' as const;
  readonly client: SparkResoClient;
  private readonly pageSize: number;

  constructor(o: SparkOptions) {
    this.client = new SparkResoClient(o);
    this.pageSize = Math.max(1, Math.min(1000, o.pageSize ?? 200));
  }

  /**
   * The validation probe: exactly one GET /Reso/OData/Property?$top=1&$select=ListingKey,ModificationTimestamp,
   * no retry. Resolves when Spark answered 2xx with an OData collection; throws SparkError otherwise.
   */
  async probe(): Promise<void> {
    const body = await this.client.json(this.client.url('/Reso/OData/Property', q([['$top', '1'], ['$select', 'ListingKey,ModificationTimestamp']])), { retries: { left: 0 } });
    if (!Array.isArray(body['value'])) throw new SparkError('BAD_RESPONSE');
  }

  /** The service document's metadata (XML text), size-capped. */
  async metadata(): Promise<string> {
    return Buffer.from(await this.client.request('GET', this.client.url('/Reso/OData/$metadata'), { accept: 'application/xml' })).toString('utf8');
  }

  async changes(cursor: string | null, limit: number): Promise<SparkPage> {
    const want = Math.max(0, Math.floor(limit));
    if (want === 0) return { listings: [], cursor, skipped: 0 };
    const after = cursor === null ? null : decodeCursor(cursor);
    const pairs: [string, string][] = [];
    if (after) pairs.push(['$filter', `ModificationTimestamp gt ${after.ts} or (ModificationTimestamp eq ${after.ts} and ListingKey gt ${odataString(after.key)})`]);
    pairs.push(['$orderby', 'ModificationTimestamp asc,ListingKey asc'], ['$top', String(Math.min(want, this.pageSize))]);
    const retries = this.client.newRetryBudget();
    const listings: ResoListing[] = [];
    let skipped = 0;
    let last = after;
    let seen = 0;
    let next: string | null = this.client.url('/Reso/OData/Property', q(pairs));
    while (next !== null && seen < want) {
      const body = await this.client.json(next, { retries });
      const value = body['value'];
      if (!Array.isArray(value)) throw new SparkError('BAD_RESPONSE');
      for (const r of value) {
        if (seen >= want) break;
        seen += 1;
        const rec = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
        const pos = positionOf(rec);
        // never move the cursor backwards (an out-of-order record is skipped, not re-read forever)
        if (pos && (!last || pos.ts > last.ts || (pos.ts === last.ts && pos.key > last.key))) last = pos;
        const l = toResoListing(rec);
        if (l) listings.push(l);
        else skipped += 1;
      }
      const link = body['@odata.nextLink'];
      next = value.length > 0 && typeof link === 'string' && link !== '' ? this.client.checkTarget(link) : null;
    }
    return { listings, cursor: last ? encodeCursor(last) : cursor, skipped };
  }

  async media(listingKey: string): Promise<MediaRef[]> {
    if (!KEY_RE.test(listingKey)) throw new SparkError('BAD_RESPONSE');
    const retries = this.client.newRetryBudget();
    const out: MediaRef[] = [];
    let next: string | null = this.client.url('/Reso/OData/Media', q([['$filter', `ResourceRecordKey eq ${odataString(listingKey)}`], ['$orderby', 'Order asc']]));
    for (let pages = 0; next !== null && pages < 20; pages++) {
      const body = await this.client.json(next, { retries });
      const value = body['value'];
      if (!Array.isArray(value)) throw new SparkError('BAD_RESPONSE');
      for (const r of value) {
        const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        const url = text(rec['MediaURL']);
        if (url === null || !/^https:\/\/\S+$/i.test(url)) continue;
        const order = nonNeg(rec['Order']) ?? out.length + 1;
        out.push({ order, url, contentType: text(rec['MimeType']) ?? 'application/octet-stream' });
      }
      const link = body['@odata.nextLink'];
      next = value.length > 0 && typeof link === 'string' && link !== '' ? this.client.checkTarget(link) : null;
    }
    return out.sort((a, b) => a.order - b.order);
  }

  /** Strictest placeholder: nothing is displayable until a counsel-reviewed licence pack is entered (VERIFY per MLS). */
  describeLicense(): LicensePack {
    return { mls: 'spark', version: 'spark/placeholder-1', reviewed: false, rules: { displayToPublic: false, displayToClients: false, requireAttribution: true, maxPhotos: null } };
  }
}
