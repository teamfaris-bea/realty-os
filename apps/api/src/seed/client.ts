// A browser-like client for the demo seed: drives the REAL server in-process (app.inject) with a
// session cookie, the x-csrf-token header and an allowed Origin, exactly like the web app does.
// Works with either cookie name (`__Host-sid` when secure, `sid` in plain-http dev).
import type { FastifyInstance } from 'fastify';

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  code: string | null;
}

export class SeedError extends Error {
  override readonly name = 'SeedError';
}

export class SeedClient {
  cookie: { name: string; value: string } | null = null;
  csrf: string | null = null;
  userId = '';
  tenantId = '';
  role = '';
  /** Called once when the server answers REAUTH_REQUIRED (R-PERM-13); the request is then retried. */
  reauth: (() => Promise<void>) | null = null;

  constructor(
    readonly app: FastifyInstance,
    readonly origin: string,
    readonly ip: string,
    readonly email = '',
  ) {}

  async call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Res<T>> {
    const headers: Record<string, string> = { 'user-agent': 'realty-os-seed' };
    if (method !== 'GET') {
      headers.origin = this.origin;
      if (this.csrf) headers['x-csrf-token'] = this.csrf;
    }
    if (this.cookie) headers.cookie = `${this.cookie.name}=${this.cookie.value}`;
    const withBody = method !== 'GET' && method !== 'DELETE';
    if (withBody) headers['content-type'] = 'application/json';
    const r = await this.app.inject({ method, url: `/api${url}`, headers, remoteAddress: this.ip, ...(withBody ? { payload: JSON.stringify(body ?? {}) } : {}) });
    const set = r.cookies.find((c) => c.name === '__Host-sid' || c.name === 'sid');
    if (set) this.cookie = set.value === '' || (set.maxAge !== undefined && set.maxAge <= 0) ? null : { name: set.name, value: set.value };
    const parsed = parseJson(r.body);
    const s = (parsed as { session?: { csrfToken?: string; user?: { id: string }; tenant?: { id: string; role: string } | null } } | null)?.session;
    if (s?.csrfToken) {
      this.csrf = s.csrfToken;
      if (s.user) this.userId = s.user.id;
      if (s.tenant) {
        this.tenantId = s.tenant.id;
        this.role = s.tenant.role;
      }
    }
    return { status: r.statusCode, body: parsed as T, code: (parsed as { error?: { code?: string } } | null)?.error?.code ?? null };
  }

  /** Like call(), but a non-2xx answer is a seed failure. */
  async must<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
    let r = await this.call<T>(method, url, body);
    if (r.code === 'REAUTH_REQUIRED' && this.reauth) {
      await this.reauth();
      r = await this.call<T>(method, url, body);
    }
    if (r.status >= 300) throw new SeedError(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
