// The county HTTP client (R-HOME-6; E572, E579). GET only, redirects refused (redirect: 'manual', any 3xx is
// rejected), a 15 s timeout, a 2 MiB streamed body cap (the spark.ts readCapped pattern, copied), `f=json`, and a
// generic User-Agent that names no tenant, user or contact. One limiter per provider instance, shared across
// tenants: requests at least 1000 ms apart (VERIFY with the county), at most 3 requests per lookup.
// Errors: ArcGIS `{"error": ...}` at 200, a 5xx, non-JSON or an oversized body is `unavailable`; a 3xx or 4xx is
// `rejected`; an abort is `timeout`. Nothing from a response is logged or put in an error.
import { ProviderError } from '../types.js';

export type CountyFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export const COUNTY_TIMEOUT_MS = 15_000;
export const COUNTY_MAX_BYTES = 2 * 1024 * 1024;
export const COUNTY_MIN_INTERVAL_MS = 1_000;
export const COUNTY_MAX_REQUESTS_PER_LOOKUP = 3;
export const COUNTY_USER_AGENT = 'realty-os-public-records/1';

export class CountyConfigError extends Error {
  override readonly name = 'CountyConfigError';
}

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/** A service URL the connector may call: https on the default port, no credentials, query or fragment, host listed. */
export function checkCountyBaseUrl(raw: string, allowedHosts: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CountyConfigError('county service URL is not a URL');
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || raw.includes('?') || raw.includes('#')) {
    throw new CountyConfigError('county service URL must be https on the default port, without credentials, query or fragment');
  }
  if (!allowedHosts.map(normHost).includes(normHost(u.hostname))) throw new CountyConfigError('county service URL host is not on PUBLIC_RECORDS_ALLOWED_HOSTS');
  return u.href.replace(/\/+$/, '');
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError('unavailable', 'COUNTY_RESPONSE_TOO_LARGE');
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
      throw new ProviderError('unavailable', 'COUNTY_RESPONSE_TOO_LARGE');
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Spaces requests at least `minIntervalMs` apart for one provider instance (all tenants share it). */
export class CountyRateLimiter {
  #last: number | null = null;
  #chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly minIntervalMs = COUNTY_MIN_INTERVAL_MS,
  ) {}

  /** Resolves when the next request may start. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.#chain.then(async () => {
      const t = this.now();
      if (this.#last !== null && t - this.#last < this.minIntervalMs) await this.sleep(this.minIntervalMs - (t - this.#last));
      this.#last = this.now();
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }
}

export interface CountyHttpOptions {
  fetch: CountyFetch;
  limiter: CountyRateLimiter;
  timeoutMs?: number;
  maxBytes?: number;
}

/** One GET of `<url>?<params>&f=json`; the parsed JSON object, or a ProviderError. */
export async function countyGetJson(o: CountyHttpOptions, url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ ...params, f: 'json' });
  await o.limiter.acquire();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? COUNTY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await o.fetch(`${url}?${q.toString()}`, { method: 'GET', headers: { accept: 'application/json', 'user-agent': COUNTY_USER_AGENT }, redirect: 'manual', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError')) throw new ProviderError('timeout', 'COUNTY_TIMEOUT');
    throw new ProviderError('unavailable', 'COUNTY_UNREACHABLE');
  }
  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError('rejected', 'COUNTY_REDIRECT');
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError('unavailable', `COUNTY_HTTP_${res.status}`);
    }
    if (res.status >= 400 || res.status < 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError('rejected', `COUNTY_HTTP_${res.status}`);
    }
    const bytes = await readCapped(res, o.maxBytes ?? COUNTY_MAX_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new ProviderError('unavailable', 'COUNTY_NOT_JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('unavailable', 'COUNTY_NOT_JSON');
    if ('error' in body) throw new ProviderError('unavailable', 'COUNTY_ARCGIS_ERROR');
    return body as Record<string, unknown>;
  } catch (e) {
    if (ac.signal.aborted && !(e instanceof ProviderError)) throw new ProviderError('timeout', 'COUNTY_TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
