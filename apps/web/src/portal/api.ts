// module 46 (R-PORTALWEB-9): the client portal's only fetch caller. It refuses any path outside /api/portal/ before
// fetching, sends same-origin credentials, and puts the portal CSRF token (taken from /session and /me, held in memory,
// never stored) on unsafe methods. Errors are code-only: PortalError(code, status, details), NETWORK_ERROR, or
// BAD_RESPONSE (an answer the strict parsers refuse). A 401 PORTAL_SESSION_REQUIRED emits `signedOut`, and App clears
// the cache, the CSRF token and the link token; PORTAL_LINK_INVALID is the sign-in screen's to handle.
import { CSRF_HEADER } from './copy.js';
import { ParseError } from './view/index.js';

export class PortalError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(code);
    this.name = 'PortalError';
  }
}

const PREFIX = '/api/portal/';
const SAFE = new Set(['GET', 'HEAD']);
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A path the portal may call: under /api/portal/, no dot segment, no scheme or authority, no fragment. */
export function isPortalPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith(PREFIX) || path.length > 512) return false;
  if (/[\s\\#]/.test(path) || /%2e|%2f|%5c/i.test(path)) return false;
  const pathname = path.split('?')[0]!;
  return !pathname.split('/').some((seg) => seg === '.' || seg === '..');
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PortalApi {
  request<T>(method: 'GET' | 'POST', path: string, parse: (v: unknown) => T, body?: unknown, o?: { signal?: AbortSignal }): Promise<T>;
  /** the raw same-origin fetch of a file URL (download.ts checks the URL first) */
  fetchFile(url: string, signal?: AbortSignal): Promise<Response>;
  setCsrf(token: string | null): void;
  hasCsrf(): boolean;
  onSignedOut(fn: () => void): () => void;
}

export function portalApi(fetchImpl: FetchLike = (i, init) => fetch(i, init)): PortalApi {
  let csrf: string | null = null;
  const listeners = new Set<() => void>();
  return {
    async request<T>(method: 'GET' | 'POST', path: string, parse: (v: unknown) => T, body?: unknown, o: { signal?: AbortSignal } = {}): Promise<T> {
      if (!isPortalPath(path)) throw new Error(`portalApi: ${path} is not a portal API path`);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (!SAFE.has(method) && csrf) headers[CSRF_HEADER] = csrf;
      let res: Response;
      try {
        res = await fetchImpl(path, {
          method,
          credentials: 'same-origin',
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        });
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        throw new PortalError('NETWORK_ERROR', 0);
      }
      let json: unknown = undefined;
      const text = res.status === 204 ? '' : await res.text().catch(() => '');
      if (text !== '') {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (!res.ok) {
        const err = (json as { error?: { code?: unknown; details?: unknown } } | undefined)?.error;
        const code = typeof err?.code === 'string' && CODE.test(err.code) ? err.code : 'BAD_RESPONSE';
        const details = err?.details !== null && typeof err?.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : null;
        if (res.status === 401 && code === 'PORTAL_SESSION_REQUIRED') {
          csrf = null;
          for (const fn of [...listeners]) fn();
        }
        throw new PortalError(code, res.status, details);
      }
      try {
        return parse(res.status === 204 ? undefined : json);
      } catch (e) {
        if (e instanceof ParseError) throw new PortalError('BAD_RESPONSE', res.status);
        throw e;
      }
    },
    async fetchFile(url, signal) {
      if (!/^\/api\/portal\/files\/[A-Za-z0-9_-]{43}$/.test(url)) throw new Error('portalApi: not a portal file URL');
      return fetchImpl(url, { method: 'GET', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    },
    setCsrf(t) {
      csrf = t;
    },
    hasCsrf() {
      return csrf !== null;
    },
    onSignedOut(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The staff retry rule (shell/App.tsx): reads retry on a network error or a 502-504, at most twice; mutations never. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof PortalError)) return false;
  return error.code === 'NETWORK_ERROR' || (error.status >= 502 && error.status <= 504);
}

/** Any answer that carries no body (204). */
export const noBody = (v: unknown): null => {
  if (v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v as object).length === 0)) throw new ParseError('noBody');
  return null;
};
