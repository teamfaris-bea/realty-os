// Minimal Twilio REST client over global fetch (no SDK dependency). Form-encoded requests, HTTP Basic auth
// with an account SID + auth token (the platform's master account, or a tenant's subaccount).
//
// Error mapping (ProviderError never carries numbers, bodies or credentials):
//   401/403                       not_configured  TWILIO_AUTH
//   400/404/409/422 with a code   rejected        the Twilio error code (e.g. 21610 = recipient sent STOP)
//   429, 5xx, network             unavailable     TWILIO_HTTP_<status> / TWILIO_NETWORK
//   timeout                       timeout
// A SUBMIT (sending a message, placing a call) is never retried here: Twilio has no idempotency key for
// those, and a lost response is the dispatch_unknown case that reconciliation resolves (R-GATE-8). For a
// submit a 5xx is also reported as `timeout` (unknown whether it left), never as a safe failure.
import { ProviderError } from '../types.js';

export interface TwilioCreds {
  sid: string;
  token: string;
}

export interface TwilioHttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** backoff between retries of safe requests (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
  /**
   * TELEPHONY_LIVE_REQUESTS (R-TWL-1). Anything but true ⇒ every request is refused BEFORE it is made, with
   * ProviderError('not_configured', 'TELEPHONY_LIVE_OFF'): no fetch, no credentials on the wire. Fail closed: absent = off.
   */
  liveRequests?: boolean;
}

/** The kill switch's provider code (R-TWL-1): never an opt-out, never retried, never reconciled. */
export const TELEPHONY_LIVE_OFF = 'TELEPHONY_LIVE_OFF';

export type FormValue = string | number | boolean | undefined | null;

const SID_RE: Record<string, RegExp> = {
  AC: /^AC[0-9a-f]{32}$/,
  CA: /^CA[0-9a-f]{32}$/,
  PN: /^PN[0-9a-f]{32}$/,
  RE: /^RE[0-9a-f]{32}$/,
  ME: /^ME[0-9a-f]{32}$/,
  SM: /^(SM|MM)[0-9a-f]{32}$/,
  MG: /^MG[0-9a-f]{32}$/,
  QE: /^QE[0-9a-f]{32}$/,
  HH: /^HH[0-9a-f]{32}$/,
};

/** Validates a Twilio SID before it is put in a URL path (no path injection through refs). */
export function assertSid(kind: keyof typeof SID_RE, value: string): string {
  if (!SID_RE[kind]!.test(value)) throw new ProviderError('rejected', `TWILIO_${kind}_SID_INVALID`);
  return value;
}

export function isSid(kind: keyof typeof SID_RE, value: string): boolean {
  return SID_RE[kind]!.test(value);
}

export class TwilioHttp {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly live: boolean;

  constructor(opts: TwilioHttpOptions = {}) {
    this.live = opts.liveRequests === true;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** R-TWL-1: true while the kill switch refuses every request (b9 review ownership-data/F4: read by the send-time gate). */
  get liveOff(): boolean {
    return !this.live;
  }

  /** R-TWL-1: throws TELEPHONY_LIVE_OFF unless live requests are on (also checked before any input is looked at). */
  assertLive(): void {
    if (!this.live) throw new ProviderError('not_configured', TELEPHONY_LIVE_OFF);
  }

  /**
   * One request. `submit` = a non-idempotent create whose loss must be reconciled (no retry, 5xx ⇒ timeout).
   * Safe requests (GET/DELETE and creates the caller treats as plain failures) retry up to twice.
   * Returns null for a 404 when `allow404`.
   */
  async request(
    creds: TwilioCreds,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    opts: { form?: Record<string, FormValue | FormValue[]>; submit?: boolean; allow404?: boolean; binary?: boolean } = {},
  ): Promise<{ json: Record<string, unknown> | null; bytes: Uint8Array | null; contentType: string | null } | null> {
    // R-TWL-1: the one choke point of every Twilio REST request (sends, calls, numbers, lookups, registrations, media)
    this.assertLive();
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${creds.sid}:${creds.token}`, 'utf8').toString('base64')}`,
      accept: opts.binary ? '*/*' : 'application/json',
    };
    let body: string | undefined;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) p.append(k, String(x));
      }
      body = p.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const attempts = opts.submit || method === 'POST' ? 1 : 3;
    let last: ProviderError = new ProviderError('unavailable', 'TWILIO_NETWORK');
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(200 * 2 ** (i - 1));
      let res: Response;
      try {
        res = await this.fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
      } catch (e) {
        const name = (e as { name?: string }).name;
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        // a connection that never opened cannot have submitted anything: a plain, safe failure
        const neverConnected = cause === 'ECONNREFUSED' || cause === 'ENOTFOUND' || cause === 'EAI_AGAIN';
        last = new ProviderError(opts.submit && !neverConnected ? 'timeout' : 'unavailable', timedOut ? 'TWILIO_TIMEOUT' : 'TWILIO_NETWORK');
        if (opts.submit) throw last;
        continue;
      }
      if (res.status === 404 && opts.allow404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (res.ok) {
        const ct = res.headers.get('content-type');
        if (opts.binary) return { json: null, bytes: new Uint8Array(await res.arrayBuffer()), contentType: ct };
        if (res.status === 204) return { json: null, bytes: null, contentType: ct };
        const text = await res.text();
        try {
          return { json: text ? (JSON.parse(text) as Record<string, unknown>) : null, bytes: null, contentType: ct };
        } catch {
          throw new ProviderError('unavailable', 'TWILIO_BAD_RESPONSE');
        }
      }
      const err = await res.json().catch(() => null) as { code?: unknown } | null;
      const code = err && (typeof err.code === 'number' || typeof err.code === 'string') ? String(err.code) : null;
      if (res.status === 401 || res.status === 403) throw new ProviderError('not_configured', 'TWILIO_AUTH');
      if (res.status === 429 || res.status >= 500) {
        last = new ProviderError(opts.submit ? 'timeout' : 'unavailable', `TWILIO_HTTP_${res.status}`);
        if (opts.submit) throw last;
        continue;
      }
      throw new ProviderError('rejected', code ?? `TWILIO_HTTP_${res.status}`);
    }
    throw last;
  }
}
