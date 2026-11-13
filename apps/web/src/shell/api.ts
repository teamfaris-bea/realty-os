// The one HTTP client of the web app. Every call goes to `/api/...` on the same origin (Vite proxies
// it in dev), so the httpOnly session cookie is sent by the browser and never touched by script.
//
// - Unsafe methods carry `x-csrf-token` (HMAC of the session id, from the session payload).
// - Errors become ApiError with the stable code from `{ error: { code, requestId, details } }`.
//   A failed network call is NETWORK_ERROR; a non-JSON or malformed error body is INTERNAL_ERROR
//   (5xx) or BAD_RESPONSE. The UI turns codes into sentences (errorMessages.ts); it never shows them.
// - Any response that carries a session (login, MFA, tenant switch, ...) refreshes the CSRF token,
//   because the server rotates the session on those calls.
// - UNAUTHENTICATED tells subscribers (the session provider) that the session is gone.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId: string | null = null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(code);
  }
}

/** Status codes for which a retry with the SAME command id is safe and useful. */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.code === 'NETWORK_ERROR' || e.status === 502 || e.status === 503 || e.status === 504;
}

const CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

function parseErrorBody(status: number, text: string): ApiError {
  try {
    const j = JSON.parse(text) as { error?: { code?: unknown; requestId?: unknown; details?: unknown } };
    const code = j?.error?.code;
    if (typeof code === 'string' && CODE_RE.test(code)) {
      const details = j.error?.details;
      return new ApiError(
        code,
        status,
        typeof j.error?.requestId === 'string' ? j.error.requestId : null,
        details !== null && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : null,
      );
    }
  } catch {
    // fall through: not JSON
  }
  return new ApiError(status >= 500 ? 'INTERNAL_ERROR' : 'BAD_RESPONSE', status);
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** path prefix of every route (CONVENTIONS §9: the API mounts everything under /api) */
  base?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

type Listener = () => void;

export class ApiClient {
  private csrf: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly unauthListeners = new Set<Listener>();

  constructor(o: ApiClientOptions = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.base = o.base ?? '/api';
  }

  setCsrfToken(token: string | null): void {
    this.csrf = token;
  }

  get csrfToken(): string | null {
    return this.csrf;
  }

  onUnauthenticated(fn: Listener): () => void {
    this.unauthListeners.add(fn);
    return () => this.unauthListeners.delete(fn);
  }

  async request<T>(method: HttpMethod, path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    return this.send<T>(method, path, body === undefined ? null : { json: body }, o);
  }

  /**
   * A multipart POST (module 55's document uploads): the same CSRF header, credentials, error parsing and abort
   * handling as every other call, and no content-type header, so the browser writes the multipart boundary. The form
   * carries only the fields the route reads; never a command id.
   */
  upload<T>(path: string, form: FormData, o: RequestOptions = {}): Promise<T> {
    return this.send<T>('POST', path, { form }, o);
  }

  private async send<T>(method: HttpMethod, path: string, payload: { json: unknown } | { form: FormData } | null, o: RequestOptions): Promise<T> {
    if (!path.startsWith('/')) throw new TypeError(`api path must start with "/": ${path}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== null && 'json' in payload) headers['content-type'] = 'application/json';
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(payload === null ? {} : 'json' in payload ? { body: JSON.stringify(payload.json) } : { body: payload.form }),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError('NETWORK_ERROR', 0);
    }
    // The body can fail to arrive after the headers did: the request was aborted (a query canceled while its
    // body streamed in) or the connection dropped. Neither is a successful empty answer (journey bug: the
    // swallowed abort resolved the feed query with undefined, "Query data cannot be undefined … [feed]"): an
    // abort stays an abort (react-query drops it), and a lost success body is a NETWORK_ERROR. A lost error
    // body still says what its status does.
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if ((e instanceof DOMException && e.name === 'AbortError') || o.signal?.aborted) throw e;
      if (res.ok) throw new ApiError('NETWORK_ERROR', 0);
    }
    if (!res.ok) {
      const err = parseErrorBody(res.status, text);
      if (err.code === 'UNAUTHENTICATED') {
        this.csrf = null;
        for (const fn of this.unauthListeners) fn();
      }
      throw err;
    }
    if (text === '') return undefined as T;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('BAD_RESPONSE', res.status);
    }
    const token = (json as { session?: { csrfToken?: unknown }; csrfToken?: unknown } | null)?.session?.csrfToken ?? (json as { csrfToken?: unknown } | null)?.csrfToken;
    if (typeof token === 'string' && token.length > 0) this.csrf = token;
    return json as T;
  }

  get<T>(path: string, o?: RequestOptions) {
    return this.request<T>('GET', path, undefined, o);
  }
  post<T>(path: string, body: unknown = {}, o?: RequestOptions) {
    return this.request<T>('POST', path, body, o);
  }
  delete<T>(path: string, o?: RequestOptions) {
    return this.request<T>('DELETE', path, undefined, o);
  }
}
