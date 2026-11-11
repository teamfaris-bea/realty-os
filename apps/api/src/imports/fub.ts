// Follow Up Boss access for the staged import (BUILD_PLAN module 16; ARCHITECTURE §13; R-IMPORT-1,
// R-IMPORT-4, R-IMPORT-11).
//
//   FubClient       what the import needs from FUB: one-record count pages (the connection test reads
//                   COUNTS ONLY, R-IMPORT-1), paged reads for the snapshot, and a recording download.
//                   Tasks and appointments are never imported and so never read: the client can only
//                   count them (owner decision B7, 2026-11-11, E233; `list` takes imported collections only).
//   FubConnector    builds a client for one API key (the key is decrypted from provider_credentials
//                   only inside the job / request that needs it and never logged).
//   FakeFub         the deterministic fake used by dev and every test: datasets keyed by API key, with
//                   `mutate` to change "live FUB" after a snapshot (E42).
//   httpFubConnector the real adapter (HTTP Basic, API key as the user name; `_metadata.total`, offset
//                   or `next` cursor paging). It is unit-tested against a local HTTP stand-in only; it
//                   has NOT been run against the live FUB API from this environment (no account). The
//                   endpoint names and the X-System headers follow FUB's public v1 API documentation:
//                   VERIFY against a real account before the first production migration. The tasks and
//                   appointments endpoints (`tasks`, `appointments`) are VERIFY too and configurable
//                   (FUB_TASKS_PATH, FUB_APPOINTMENTS_PATH: one plain path segment each).
//
// Nothing here writes to the database: the snapshot job stores what it reads (encrypted), and every
// later step works on that snapshot, never on live FUB (R-IMPORT-1).
import { FUB_COUNT_ONLY_COLLECTIONS, type FubCollection, type FubCountOnlyCollection } from '@realty/core/import';
import { isPublicPushEndpoint } from '../auth/devices.js';

export const FUB_COLLECTIONS: readonly FubCollection[] = ['people', 'notes', 'textMessages', 'emails', 'calls', 'users'];
/** Owner decision B7 (E233): counted at the connection test and the snapshot, never read, never imported. */
export const FUB_COUNT_ONLY: readonly FubCountOnlyCollection[] = FUB_COUNT_ONLY_COLLECTIONS;

export interface FubListPage {
  items: unknown[];
  /** `_metadata.total` of the collection, as FUB reported it */
  total: number;
  /** cursor of the next page (FUB `_metadata.next`), or null at the end */
  next: string | null;
}

export interface FubRecording {
  bytes: Uint8Array;
  contentType: string;
}

export interface FubClient {
  /** The raw one-record page of a collection (`limit=1`): only `_metadata.total` is read from it (R-IMPORT-1, E233). */
  countPage(collection: FubCollection | FubCountOnlyCollection): Promise<unknown>;
  /** One page of a collection, from the start (`cursor` null) or a cursor from the previous page. */
  list(collection: FubCollection, cursor: string | null, limit: number): Promise<FubListPage>;
  /** A call recording's bytes (the URL comes from the encrypted snapshot); null when FUB no longer has it. */
  fetchRecording(url: string): Promise<FubRecording | null>;
}

export type FubConnector = (apiKey: string) => FubClient;

export class FubAccessError extends Error {
  override readonly name = 'FubAccessError';
  constructor(
    readonly code: 'FUB_UNAUTHORIZED' | 'FUB_UNAVAILABLE' | 'FUB_BAD_RESPONSE',
    readonly status?: number,
  ) {
    super(code);
  }
}

export const SNAPSHOT_PAGE_SIZE = 100;

/** Reads a whole collection through `list` (bounded: at most `maxItems`). */
export async function readCollection(client: FubClient, collection: FubCollection, maxItems = 500_000): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100_000; page++) {
    const p: FubListPage = await client.list(collection, cursor, SNAPSHOT_PAGE_SIZE);
    out.push(...p.items);
    if (out.length > maxItems) throw new FubAccessError('FUB_BAD_RESPONSE');
    if (p.next === null || p.items.length === 0) return out;
    cursor = p.next;
  }
  throw new FubAccessError('FUB_BAD_RESPONSE');
}

// ---- fake ---------------------------------------------------------------------------------------------

export type FubDataset = Partial<Record<FubCollection | FubCountOnlyCollection, unknown[]>> & {
  /** recording URL → bytes */
  recordings?: Record<string, Uint8Array>;
  /** collections the fake answers with 404 (an account without that API scope) */
  unavailable?: (FubCollection | FubCountOnlyCollection)[];
  /** collections the fake answers with this HTTP status (401/403: FUB_UNAUTHORIZED, else FUB_UNAVAILABLE) */
  failing?: Partial<Record<FubCollection | FubCountOnlyCollection, number>>;
};

function failure(status: number): FubAccessError {
  return new FubAccessError(status === 401 || status === 403 ? 'FUB_UNAUTHORIZED' : 'FUB_UNAVAILABLE', status);
}

/**
 * Deterministic in-memory FUB. Each API key names one dataset; an unknown key is FUB_UNAUTHORIZED.
 * `calls` counts every request so tests can prove the connection test reads counts only.
 */
export class FakeFub {
  private readonly data = new Map<string, FubDataset>();
  readonly calls: { apiKeyTag: string; op: 'count' | 'list' | 'recording'; collection?: FubCollection | FubCountOnlyCollection }[] = [];

  add(apiKey: string, dataset: FubDataset): this {
    this.data.set(apiKey, structuredClone(dataset));
    return this;
  }

  /** Changes "live FUB" (e.g. after a snapshot, E42). */
  mutate(apiKey: string, fn: (d: FubDataset) => void): void {
    const d = this.data.get(apiKey);
    if (!d) throw new Error('unknown fake FUB key');
    fn(d);
  }

  readonly connector: FubConnector = (apiKey) => {
    const tag = apiKey.slice(0, 4);
    const get = (): FubDataset => {
      const d = this.data.get(apiKey);
      if (!d) throw new FubAccessError('FUB_UNAUTHORIZED', 401);
      return d;
    };
    return {
      countPage: async (collection) => {
        this.calls.push({ apiKeyTag: tag, op: 'count', collection });
        const d = get();
        if (d.unavailable?.includes(collection)) throw new FubAccessError('FUB_UNAVAILABLE', 404);
        const status = d.failing?.[collection];
        if (status !== undefined) throw failure(status);
        const items = d[collection] ?? [];
        return { _metadata: { collection, offset: 0, limit: 1, total: items.length }, [collection]: items.slice(0, 1) };
      },
      list: async (collection, cursor, limit) => {
        this.calls.push({ apiKeyTag: tag, op: 'list', collection });
        const d = get();
        if (d.unavailable?.includes(collection)) throw new FubAccessError('FUB_UNAVAILABLE', 404);
        const status = d.failing?.[collection];
        if (status !== undefined) throw failure(status);
        const items = d[collection] ?? [];
        const offset = cursor === null ? 0 : Number(cursor);
        const page = structuredClone(items.slice(offset, offset + limit));
        const end = offset + limit >= items.length;
        return { items: page, total: items.length, next: end ? null : String(offset + limit) };
      },
      fetchRecording: async (url) => {
        this.calls.push({ apiKeyTag: tag, op: 'recording' });
        const bytes = get().recordings?.[url];
        return bytes ? { bytes: new Uint8Array(bytes), contentType: 'audio/mpeg' } : null;
      },
    };
  };
}

// ---- real HTTP adapter --------------------------------------------------------------------------------

export interface HttpFubOptions {
  /** default https://api.followupboss.com/v1; server config only (FUB_BASE_URL), never tenant input */
  baseUrl?: string;
  /** hosts the base URL may name (FUB_ALLOWED_HOSTS); default FUB's own API host only */
  allowedHosts?: readonly string[];
  /** FUB registered-system name and key (X-System / X-System-Key headers), when the account requires them */
  system?: { name: string; key: string };
  /**
   * Owner decision B7 (E233): the endpoints the count-only collections are counted at, below the base URL
   * (FUB_TASKS_PATH, FUB_APPOINTMENTS_PATH; default `tasks`, `appointments`, VERIFY). One plain path segment each.
   */
  countOnlyPaths?: Partial<Record<FubCountOnlyCollection, string>>;
  fetch?: typeof fetch;
  /** per-request timeout, ms (default 30 s) */
  timeoutMs?: number;
}

/** A FUB base URL or allow-list that must not be used (refused when the connector is built, i.e. at startup). */
export class FubConfigError extends Error {
  override readonly name = 'FubConfigError';
}

export const DEFAULT_FUB_BASE_URL = 'https://api.followupboss.com/v1';
export const DEFAULT_FUB_ALLOWED_HOSTS: readonly string[] = ['api.followupboss.com'];
/** VERIFY against a real account: FUB's public v1 API names these resources `tasks` and `appointments`. */
export const DEFAULT_FUB_COUNT_ONLY_PATHS: Readonly<Record<FubCountOnlyCollection, string>> = { tasks: 'tasks', appointments: 'appointments' };
/** A configured endpoint is one plain path segment (no slash, dot, query or encoding), so it stays on the checked base URL. */
export const FUB_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The count-only endpoints the adapter uses (defaults filled in); FubConfigError for anything but one plain segment. */
export function checkFubCountOnlyPaths(paths: Partial<Record<FubCountOnlyCollection, string>> = {}): Record<FubCountOnlyCollection, string> {
  const out = { ...DEFAULT_FUB_COUNT_ONLY_PATHS, ...paths };
  for (const [c, p] of Object.entries(out)) if (!FUB_PATH_SEGMENT.test(p)) throw new FubConfigError(`FUB ${c} path must be one plain path segment`);
  return out;
}

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/**
 * The FUB API base URL the adapter may call (SSRF guard): https on the default port, no credentials,
 * no query or fragment, a public dotted DNS name (never an IP literal, localhost or an internal suffix;
 * the same rule as push endpoints, auth/devices.ts) that is on the allow-list. Returns it without a
 * trailing slash; throws FubConfigError otherwise. The allow-list entries must be public names too.
 */
export function checkFubBaseUrl(raw: string, allowedHosts: readonly string[] = DEFAULT_FUB_ALLOWED_HOSTS): string {
  const allowed = allowedHosts.map(normHost).filter((h) => h !== '');
  for (const h of allowed) if (!/^[a-z0-9.-]+$/.test(h) || !isPublicPushEndpoint(`https://${h}/`)) throw new FubConfigError('FUB_ALLOWED_HOSTS must list public DNS names only');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FubConfigError('FUB base URL is not a URL');
  }
  if (!isPublicPushEndpoint(u.href) || u.search !== '' || u.hash !== '' || raw.includes('?') || raw.includes('#')) {
    throw new FubConfigError('FUB base URL must be https on the default port, without credentials, query or fragment, naming a public host');
  }
  if (!allowed.includes(normHost(u.hostname))) throw new FubConfigError('FUB base URL host is not in FUB_ALLOWED_HOSTS');
  return u.href.replace(/\/+$/, '');
}

/** Largest JSON page the adapter reads from the FUB API (a 100-record page is far smaller). */
export const MAX_API_PAGE_BYTES = 32 * 1024 * 1024;

/** Largest recording the snapshot copies (a one-hour call is ~60 MB as MP3); larger is refused. */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
const MAX_RECORDING_REDIRECTS = 3;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** A recording URL from FUB data that may be fetched: https, no userinfo, a public DNS name; else null. */
export function recordingTarget(raw: string, relativeTo?: URL): URL | null {
  let u: URL;
  try {
    u = relativeTo ? new URL(raw, relativeTo) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || host.includes(':') || IPV4.test(host)) return null; // IP literals (WHATWG normalizes 2130706433 to dotted form)
  if (host === 'localhost' || !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  // and the push-endpoint rule (auth/devices.ts): default port only, no hex/octal IP forms, no intranet suffixes
  if (!isPublicPushEndpoint(u.href)) return null;
  return u;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new FubAccessError('FUB_BAD_RESPONSE');
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
      throw new FubAccessError('FUB_BAD_RESPONSE');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The real FUB v1 adapter (see the header: VERIFY against a live account). */
export function httpFubConnector(o: HttpFubOptions = {}): FubConnector {
  const base = checkFubBaseUrl(o.baseUrl ?? DEFAULT_FUB_BASE_URL, o.allowedHosts ?? DEFAULT_FUB_ALLOWED_HOSTS);
  const countOnly = checkFubCountOnlyPaths(o.countOnlyPaths);
  const pathOf = (c: FubCollection | FubCountOnlyCollection): string => (c === 'tasks' || c === 'appointments' ? countOnly[c] : c);
  const doFetch = o.fetch ?? fetch;
  return (apiKey) => {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      accept: 'application/json',
    };
    if (o.system) {
      headers['x-system'] = o.system.name;
      headers['x-system-key'] = o.system.key;
    }
    const get = async (url: string): Promise<Response> => {
      let res: Response;
      try {
        // never follow a redirect: the credential and the response must stay with the configured host
        res = await doFetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
      } catch {
        throw new FubAccessError('FUB_UNAVAILABLE');
      }
      if (res.status === 401 || res.status === 403) throw new FubAccessError('FUB_UNAUTHORIZED', res.status);
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new FubAccessError('FUB_UNAVAILABLE', res.status); // incl. every 3xx (redirect: 'manual')
      }
      return res;
    };
    const json = async (url: string): Promise<Record<string, unknown>> => {
      const bytes = await readCapped(await get(url), MAX_API_PAGE_BYTES);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        body = null;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new FubAccessError('FUB_BAD_RESPONSE');
      return body as Record<string, unknown>;
    };
    return {
      countPage: (collection) => json(`${base}/${pathOf(collection)}?limit=1&offset=0`),
      async list(collection, cursor, limit) {
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor === null) q.set('offset', '0');
        else if (/^\d+$/.test(cursor)) q.set('offset', cursor);
        else q.set('next', cursor);
        const body = await json(`${base}/${collection}?${q.toString()}`);
        const meta = (body._metadata ?? {}) as { total?: unknown; next?: unknown; offset?: unknown };
        const items = body[collection];
        if (!Array.isArray(items) || typeof meta.total !== 'number') throw new FubAccessError('FUB_BAD_RESPONSE');
        let next: string | null = null;
        if (typeof meta.next === 'string' && meta.next !== '') next = meta.next;
        else if (cursor === null || /^\d+$/.test(cursor)) {
          const offset = typeof meta.offset === 'number' ? meta.offset : cursor !== null && /^\d+$/.test(cursor) ? Number(cursor) : 0;
          if (items.length > 0 && offset + items.length < meta.total) next = String(offset + items.length);
        }
        return { items, total: meta.total, next };
      },
      async fetchRecording(url) {
        // The URL comes from FUB data, so it is untrusted: https only, a public DNS name only (never an
        // IP literal, localhost or an intranet name), redirects followed by hand and re-checked, and the
        // FUB credential sent only on the first request and only to FUB's own API host (pre-signed URLs
        // carry their own token). DNS that resolves a public name to a private address is not checked
        // here; the worker's egress policy is the backstop.
        let target = recordingTarget(url);
        if (!target) return null;
        const apiHost = new URL(base).host;
        let res: Response | null = null;
        for (let hop = 0; hop <= MAX_RECORDING_REDIRECTS; hop++) {
          const withKey = hop === 0 && target.host === apiHost;
          try {
            res = await doFetch(target, { headers: withKey ? headers : {}, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
          } catch {
            throw new FubAccessError('FUB_UNAVAILABLE');
          }
          if (res.status < 300 || res.status > 399) break;
          const next = recordingTarget(res.headers.get('location') ?? '', target);
          if (!next) return null;
          target = next;
          res = null;
        }
        if (!res) return null;
        if (res.status === 404 || res.status === 410) return null;
        if (!res.ok) throw new FubAccessError('FUB_UNAVAILABLE', res.status);
        return { bytes: await readCapped(res, MAX_RECORDING_BYTES), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
      },
    };
  };
}
