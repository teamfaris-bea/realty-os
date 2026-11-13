// Read-only Spark RESO Web API adapter (docs/DEPLOY.md and docs/SECURITY.md "Spark MLS (read-only)").
//
//   const feed = new SparkResoMlsFeed({ baseUrl, allowedHosts, authScheme, liveCalls, accessToken });
//   await feed.records(cursor, 200)     sanitized raw RESO records (Media expanded) for core normalizeMlsListing
//   await feed.changes(cursor, 200)     the same records as the ResoListing shape
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
// Live shape (a read-only check with the CRM's own key on 2026-11-11, docs/SECURITY.md §5.3; the mock in
// spark.testing.ts reproduces each point):
//  1. A replication key is refused on the standard host with a 403 naming the replication endpoint:
//     REPLICATION_ENDPOINT_REQUIRED (its own status, never "unauthorized"). The base URL is set through
//     SPARK_API_BASE_URL / SPARK_ALLOWED_HOSTS; every nextLink must stay on an allowed host.
//  2. The service has no Media entity set: photos come from $expand=Media on the Property request.
//  3. Media.Order is Edm.Int64 (a JSON number, or a string under IEEE754Compatible).
//  4. Records carry many fields $metadata does not declare and `<Field>@Core.Permissions` annotations:
//     unknown keys are ignored, every annotation key is dropped, and a field whose annotation does not
//     grant Read is removed before anything reads it (sanitizeRecord).
//  5. No LivingArea in the sample; BuildingAreaTotal populated; AboveGradeFinishedArea present but empty. Total building
//     area is not finished living area, so the size is UNKNOWN (null) for every Spark record until the MLS confirms
//     which field carries finished living area (R-MLS-7; SPARK_FIELD_MAPPING sqft null, SPARK_SIZE_FIELD_CANDIDATE).
//  6. StandardStatus is a string whose values come from the Lookup resource (not an OData enum).
//  7. A transient 503 ("took too long") is BUSY: retried by the sync inside its budget; the single
//     validation probe reports it as its own result.
//  8. Every response echoes an X-Api-Key header: no response header but Content-Length and Retry-After
//     is ever read, and none is logged, stored, audited or returned.
//  9. The one-record probe returns no @odata.nextLink and no @odata.count.
// VERIFY with Spark:
//  - the Authorization scheme ("Bearer" or "OAuth"; SPARK_AUTH_SCHEME, default Bearer);
//  - the largest $top Spark accepts with $expand=Media, $orderby on ListingKey, and the composite $filter
//    used for the cursor; whether $select inside $expand is honoured (off by default: expandSelect);
//  - which value of Core.Permissions withholds a field (anything but an explicit Read withholds it here);
//  - which field is the finished living area for this MLS (none is mapped; BuildingAreaTotal is never used;
//    AboveGradeFinishedArea was present but empty) and which RESO fields each MLS actually populates; the questions
//    are in docs/DATA_MODEL.md "VERIFY WITH MLS: size and postal code".
import { priceToCents } from '@realty/core/listings';
import { ProviderError } from '../types.js';
import type { LicensePack, MediaRef, MlsFeed, MlsPage, ResoListing } from './types.js';

/**
 * The only paths the adapter may request (exact match). Member/Office/OpenHouse/Lookup are not needed by
 * core/listings, and there is no Media entity set (photos come from $expand=Media on Property).
 */
export const SPARK_PATHS = ['/Reso/OData/$metadata', '/Reso/OData/Property'] as const;

/**
 * Per-MLS field overrides for core normalizeMlsListing (finding 5; R-MLS-7). `sqft: null`: no Spark field is confirmed
 * as the finished living area, so every Spark size is unknown (null), LivingArea included. Never BuildingAreaTotal.
 * Flipping this to a field is an owner-approved change made here, in one place, with its tests, after the MLS answers
 * (docs/DATA_MODEL.md "VERIFY WITH MLS: size and postal code"), shipped with a migration that has the backfill re-read
 * every Spark record: the mapping alone re-reads nothing already stored (docs/ARCHITECTURE §21.44, E653). No setting or
 * environment variable can turn it on.
 */
export const SPARK_FIELD_MAPPING: Readonly<{ sqft: string | null }> = Object.freeze({ sqft: null });

/**
 * VERIFY WITH MLS: the field that may carry finished living area for this MLS, named so the choice is reviewable. No
 * code reads it while `confirmed` is false (an architecture test): the size stays unknown until the MLS confirms the
 * field and its semantics (what it includes, its units and source) and the owner approves the flip above.
 */
export const SPARK_SIZE_FIELD_CANDIDATE = Object.freeze({ field: 'LivingArea', confirmed: false } as const);

export const SPARK_ERROR_CODES = [
  'LIVE_CALLS_DISABLED',
  'METHOD_NOT_ALLOWED',
  'PATH_NOT_ALLOWED',
  'HOST_NOT_ALLOWED',
  'REDIRECT_REFUSED',
  'INVALID_CREDENTIALS',
  'REPLICATION_ENDPOINT_REQUIRED',
  'NOT_LICENSED_OR_ROLE_INSUFFICIENT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'BUSY',
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
  REPLICATION_ENDPOINT_REQUIRED: 'rejected',
  NOT_LICENSED_OR_ROLE_INSUFFICIENT: 'rejected',
  NOT_FOUND: 'rejected',
  RATE_LIMITED: 'unavailable',
  BUSY: 'unavailable',
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
  /** $top per page (default 100 with $expand=Media; VERIFY Spark's maximum with $expand) */
  pageSize?: number;
  /** pages read per operation at most (default 20): bounds the request count whatever page size Spark honours */
  maxPages?: number;
  /** send $expand=Media($select=...) instead of $expand=Media (default false; VERIFY whether Spark honours it) */
  expandSelect?: boolean;
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

const isRetryable = (c: SparkErrorCode) => c === 'RATE_LIMITED' || c === 'BUSY' || c === 'UNREACHABLE';

/** The marker of Spark's "use the replication endpoint" 403 (finding 1). Only this test is made on the body. */
const REPLICATION_HINT = /replication\.sparkapi\.com|use\s+replication/i;

/** A small error body as text, read only to classify a 403; never stored, logged or returned. */
async function peekErrorText(res: Response): Promise<string> {
  try {
    return Buffer.from(await readCapped(res, 8 * 1024)).toString('utf8');
  } catch {
    return '';
  }
}

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
        if (s === 403) throw new SparkError(REPLICATION_HINT.test(await peekErrorText(res)) ? 'REPLICATION_ENDPOINT_REQUIRED' : 'NOT_LICENSED_OR_ROLE_INSUFFICIENT', s);
        await res.body?.cancel().catch(() => undefined);
        if (s === 0 || (s >= 300 && s < 400)) throw new SparkError('REDIRECT_REFUSED', s || null);
        if (s === 401) throw new SparkError('INVALID_CREDENTIALS', s);
        if (s === 404) throw new SparkError('NOT_FOUND', s);
        if (s === 429) {
          wait = retryAfterMs(res);
          throw new SparkError('RATE_LIMITED', s);
        }
        if (s >= 500) {
          wait = retryAfterMs(res);
          throw new SparkError(s === 503 ? 'BUSY' : 'UNREACHABLE', s);
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

// ---- RESO record → sanitized record / ResoListing ---------------------------------------------------

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
/** Edm.Int64: a JSON number, or a decimal string under IEEE754Compatible (finding 3). */
const int64 = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
};

const PERMISSIONS_SUFFIX = '@Core.Permissions';

/**
 * Whether a RESO `Core.Permissions` annotation value grants Read. The OData vocabulary's members are
 * None, Read, Write, ReadWrite (also sent as a flags string "Read,Write" or a list). Anything else, or an
 * unreadable value, withholds the field (strictest). VERIFY with Spark / the MLS.
 */
export function permissionGrantsRead(v: unknown): boolean {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,|]+/) : [];
  return parts.some((p) => typeof p === 'string' && /^(?:Org\.OData\.Core\.V1\.Permission\/|Core\.Permission\/)?(Read|ReadWrite)$/.test(p.trim()));
}

/**
 * One record as core/listings may read it (finding 4): every annotation key (`@odata.*`, `<Field>@...`) is
 * dropped, and a field whose `<Field>@Core.Permissions` annotation does not grant Read is removed, so it is
 * never displayed or sent. Unknown fields are kept as data and ignored by the normalizer. Media entries are
 * sanitized the same way.
 */
export function sanitizeRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const withheld = new Set<string>();
  for (const [k, v] of Object.entries(rec)) {
    if (k.endsWith(PERMISSIONS_SUFFIX) && !permissionGrantsRead(v)) withheld.add(k.slice(0, -PERMISSIONS_SUFFIX.length));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k.includes('@') || withheld.has(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = k === 'Media' && Array.isArray(v) ? v.map(sanitizeRecord) : v;
  }
  return out;
}

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
 * One RESO Property record (sanitized) as the existing ResoListing shape, or null when a required field is
 * missing (the sync skips it; core/listings normalizeMlsListing and applyDisplayRules still decide what any
 * audience may see). Required: ListingKey, ModificationTimestamp, StandardStatus, ListPrice, ListOfficeName
 * (R-MLS-1). The size is read only from SPARK_FIELD_MAPPING's field, and there is none yet: livingAreaSqft is null
 * (finding 5, R-MLS-7; BuildingAreaTotal is total building area, never finished living area). PostalCode is kept as
 * sent (ZIP5 or ZIP+4; VERIFY WITH MLS).
 */
export function toResoListing(raw0: Record<string, unknown>): ResoListing | null {
  const raw = sanitizeRecord(raw0);
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
  const sizeField = SPARK_FIELD_MAPPING.sqft;
  const area = sizeField === null ? null : nonNeg(raw[sizeField]);
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

/** Photo references of a sanitized record's expanded Media (https only, ordered by Order then feed order). */
export function mediaOf(rec: Record<string, unknown>): MediaRef[] {
  const media = rec['Media'];
  if (!Array.isArray(media)) return [];
  const out: (MediaRef & { i: number })[] = [];
  media.forEach((m: unknown, i) => {
    const r = sanitizeRecord(m);
    const url = text(r['MediaURL']);
    if (url === null || !/^https:\/\/\S+$/i.test(url)) return;
    out.push({ order: int64(r['Order']) ?? Number.MAX_SAFE_INTEGER, url, contentType: text(r['MimeType']) ?? 'application/octet-stream', i });
  });
  return out.sort((a, b) => a.order - b.order || a.i - b.i).map(({ i: _i, ...m }) => m);
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
/** The Media fields read (finding 3), for $expand=Media($select=...) when expandSelect is on. */
const MEDIA_SELECT = 'MediaKey,MediaURL,Order,MediaCategory,Permission,ResourceRecordKey';

export interface SparkPage extends MlsPage {
  /** records skipped because a required field was missing or invalid */
  skipped: number;
}

export interface SparkRecordPage {
  /** sanitized records (Media expanded), in feed order; every one advanced the cursor */
  records: Record<string, unknown>[];
  cursor: string | null;
  /** records without a usable ListingKey / ModificationTimestamp (they cannot be stored) */
  unpositioned: number;
  /** true when the read stopped at the limit or the page bound: more may be waiting */
  more: boolean;
}

/** The read-only MlsFeed over Spark's RESO Web API. */
export class SparkResoMlsFeed implements MlsFeed {
  readonly access = 'available' as const;
  readonly client: SparkResoClient;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly expand: string;

  constructor(o: SparkOptions) {
    this.client = new SparkResoClient(o);
    this.pageSize = Math.max(1, Math.min(1000, o.pageSize ?? 100));
    this.maxPages = Math.max(1, Math.min(200, o.maxPages ?? 20));
    this.expand = o.expandSelect ? `Media($select=${MEDIA_SELECT})` : 'Media';
  }

  /**
   * The validation probe: exactly one GET /Reso/OData/Property?$top=1&$select=ListingKey,ModificationTimestamp,
   * no retry. Resolves when Spark answered 2xx with an OData collection (no nextLink or count is expected,
   * finding 9); throws SparkError otherwise.
   */
  async probe(): Promise<void> {
    const body = await this.client.json(this.client.url('/Reso/OData/Property', q([['$top', '1'], ['$select', 'ListingKey,ModificationTimestamp']])), { retries: { left: 0 } });
    if (!Array.isArray(body['value'])) throw new SparkError('BAD_RESPONSE');
  }

  /** The service document's metadata (XML text), size-capped. */
  async metadata(): Promise<string> {
    return Buffer.from(await this.client.request('GET', this.client.url('/Reso/OData/$metadata'), { accept: 'application/xml' })).toString('utf8');
  }

  /**
   * Up to `limit` sanitized Property records after the cursor, with Media expanded, in ModificationTimestamp
   * then ListingKey order. At most `maxPages` requests (plus retries inside the shared budget).
   */
  async records(cursor: string | null, limit: number): Promise<SparkRecordPage> {
    const want = Math.max(0, Math.floor(limit));
    if (want === 0) return { records: [], cursor, unpositioned: 0, more: false };
    const after = cursor === null ? null : decodeCursor(cursor);
    const pairs: [string, string][] = [];
    if (after) pairs.push(['$filter', `ModificationTimestamp gt ${after.ts} or (ModificationTimestamp eq ${after.ts} and ListingKey gt ${odataString(after.key)})`]);
    pairs.push(['$orderby', 'ModificationTimestamp asc,ListingKey asc'], ['$top', String(Math.min(want, this.pageSize))], ['$expand', this.expand]);
    const retries = this.client.newRetryBudget();
    const records: Record<string, unknown>[] = [];
    let unpositioned = 0;
    let last = after;
    let seen = 0;
    let pages = 0;
    let next: string | null = this.client.url('/Reso/OData/Property', q(pairs));
    while (next !== null && seen < want && pages < this.maxPages) {
      pages += 1;
      const body = await this.client.json(next, { retries });
      const value = body['value'];
      if (!Array.isArray(value)) throw new SparkError('BAD_RESPONSE');
      for (const r of value) {
        if (seen >= want) break;
        seen += 1;
        const rec = sanitizeRecord(r);
        const pos = positionOf(rec);
        // never move the cursor backwards (an out-of-order record is skipped, not re-read forever)
        if (pos && (!last || pos.ts > last.ts || (pos.ts === last.ts && pos.key > last.key))) last = pos;
        if (pos) records.push(rec);
        else unpositioned += 1;
      }
      const link = body['@odata.nextLink'];
      next = value.length > 0 && typeof link === 'string' && link !== '' ? this.client.checkTarget(link) : null;
    }
    return { records, cursor: last ? encodeCursor(last) : cursor, unpositioned, more: next !== null };
  }

  async changes(cursor: string | null, limit: number): Promise<SparkPage> {
    const page = await this.records(cursor, limit);
    const listings: ResoListing[] = [];
    let skipped = page.unpositioned;
    for (const r of page.records) {
      const l = toResoListing(r);
      if (l) listings.push(l);
      else skipped += 1;
    }
    return { listings, cursor: page.cursor, skipped };
  }

  /** Photos of one listing: the Property record with $expand=Media (there is no Media entity set, finding 2). One request. */
  async media(listingKey: string): Promise<MediaRef[]> {
    if (!KEY_RE.test(listingKey)) throw new SparkError('BAD_RESPONSE');
    const body = await this.client.json(
      this.client.url('/Reso/OData/Property', q([['$filter', `ListingKey eq ${odataString(listingKey)}`], ['$select', 'ListingKey'], ['$expand', this.expand], ['$top', '1']])),
      { retries: this.client.newRetryBudget() },
    );
    const value = body['value'];
    if (!Array.isArray(value)) throw new SparkError('BAD_RESPONSE');
    return value.length === 0 ? [] : mediaOf(sanitizeRecord(value[0]));
  }

  /** Strictest placeholder: nothing is displayable until a counsel-reviewed licence pack is entered (VERIFY per MLS). */
  describeLicense(): LicensePack {
    return { mls: 'spark', version: 'spark/placeholder-1', reviewed: false, rules: { displayToPublic: false, displayToClients: false, requireAttribution: true, maxPhotos: null } };
  }
}
