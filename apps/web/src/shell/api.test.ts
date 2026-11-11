// The HTTP client: CSRF header, error parsing, session-token refresh and the 401 signal.
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, isRetryable } from './api.js';
import { authApi, pathAfterAuth, safeNext, sessionGate } from './authApi.js';
import { FakeFetch, err, sessionFixture } from './testing/fakeApi.js';

describe('ApiClient', () => {
  it('prefixes /api, sends same-origin credentials, and adds x-csrf-token only on unsafe methods', async () => {
    const seen: RequestInit[] = [];
    const api = new ApiClient({
      fetch: async (_u, init) => {
        seen.push(init!);
        return new Response('{}', { status: 200 });
      },
    });
    api.setCsrfToken('tok');
    await api.get('/x');
    await api.post('/x', { a: 1 });
    await api.delete('/x');
    expect(seen.map((i) => (i.headers as Record<string, string>)['x-csrf-token'])).toEqual([undefined, 'tok', 'tok']);
    expect(seen.every((i) => i.credentials === 'same-origin')).toBe(true);
    expect(JSON.parse(seen[1]!.body as string)).toEqual({ a: 1 });
  });

  it('refreshes the CSRF token from any response that carries a session (rotation on login, MFA, switch)', async () => {
    const f = new FakeFetch().on('POST /auth/login', { status: 200, body: { next: 'ready', session: sessionFixture({ csrfToken: 'rotated' }) } });
    const api = new ApiClient({ fetch: f.fetch });
    api.setCsrfToken('old');
    await authApi(api).login('a@b.c', 'pw');
    expect(api.csrfToken).toBe('rotated');
  });

  it('turns the error body into ApiError with the stable code, request id and details', async () => {
    const f = new FakeFetch().on('POST /auth/signup', err(422, 'PASSWORD_TOO_WEAK', { rule: 'length' }));
    const api = new ApiClient({ fetch: f.fetch });
    const e = await api.post('/auth/signup', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'PASSWORD_TOO_WEAK', status: 422, requestId: 'req-1', details: { rule: 'length' } });
  });

  it('a failed network call is NETWORK_ERROR; a non-JSON body is INTERNAL_ERROR (5xx) or BAD_RESPONSE', async () => {
    const down = new ApiClient({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(down.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    const html = new ApiClient({ fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
    await expect(html.get('/x')).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 502 });
    const weird = new ApiClient({ fetch: async () => new Response('{"error":{"code":"lower"}}', { status: 400 }) });
    await expect(weird.get('/x')).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 400 });
    const okButBroken = new ApiClient({ fetch: async () => new Response('not json', { status: 200 }) });
    await expect(okButBroken.get('/x')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('an aborted request rethrows the AbortError (not a network error)', async () => {
    const api = new ApiClient({ fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')) });
    await expect(api.get('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  // journey bug "Query data cannot be undefined … [feed]": a query canceled while its body streamed in resolved
  // with undefined, because the failed body read was swallowed as an empty body
  const brokenBody = (status: number, why: unknown) => {
    const res = new Response('{}', { status });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(why) });
    return res;
  };

  it('a request aborted while its body arrives rethrows the abort; it never resolves with undefined', async () => {
    const ctl = new AbortController();
    const api = new ApiClient({
      fetch: async () => {
        ctl.abort();
        return brokenBody(200, new DOMException('The operation was aborted.', 'AbortError'));
      },
    });
    await expect(api.get('/feed', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a success whose body is lost is a NETWORK_ERROR (retryable), never an empty success; a lost error body still says its status', async () => {
    const lost = new ApiClient({ fetch: async () => brokenBody(200, new TypeError('network connection was lost')) });
    const e = await lost.get('/feed').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(isRetryable(e)).toBe(true);
    const lostError = new ApiClient({ fetch: async () => brokenBody(503, new TypeError('network connection was lost')) });
    await expect(lostError.get('/feed')).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 503 });
  });

  it('UNAUTHENTICATED clears the CSRF token and tells subscribers; other 401s do not', async () => {
    const f = new FakeFetch().on('GET /a', err(401, 'UNAUTHENTICATED')).on('GET /b', err(401, 'MFA_REQUIRED'));
    const api = new ApiClient({ fetch: f.fetch });
    const fn = vi.fn();
    const off = api.onUnauthenticated(fn);
    api.setCsrfToken('t');
    await api.get('/b').catch(() => undefined);
    expect(fn).not.toHaveBeenCalled();
    expect(api.csrfToken).toBe('t');
    await api.get('/a').catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(api.csrfToken).toBeNull();
    off();
    await api.get('/a').catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects paths that are not absolute (no accidental cross-origin URLs)', async () => {
    const api = new ApiClient({ fetch: async () => new Response('{}') });
    await expect(api.get('https://evil.example/x')).rejects.toThrow(TypeError);
  });

  it('isRetryable: network errors and 502/503/504 only', () => {
    expect(isRetryable(new ApiError('NETWORK_ERROR', 0))).toBe(true);
    expect(isRetryable(new ApiError('INTERNAL_ERROR', 503))).toBe(true);
    expect(isRetryable(new ApiError('INTERNAL_ERROR', 500))).toBe(false);
    expect(isRetryable(new ApiError('LEAD_ALREADY_CLAIMED', 409))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  it('URL-encodes invite tokens in the path', async () => {
    const f = new FakeFetch().on('POST /auth/invites/a%2Fb%3Fc/accept', { status: 200, body: { next: 'ready', session: sessionFixture() } });
    await authApi(new ApiClient({ fetch: f.fetch })).acceptInvite('a/b?c', {});
    expect(f.calls[0]?.path).toBe('/auth/invites/a%2Fb%3Fc/accept');
  });
});

describe('session gate and next', () => {
  it('orders the gates: signed out → MFA verify → MFA enrollment → team → ready', () => {
    expect(sessionGate(null)).toBe('signed_out');
    expect(sessionGate(sessionFixture({ mfa: { enabled: true, verified: false, enrollmentRequired: false } }))).toBe('mfa_verify');
    expect(sessionGate(sessionFixture({ mfa: { enabled: false, verified: false, enrollmentRequired: true } }))).toBe('mfa_enroll');
    expect(sessionGate(sessionFixture({ tenant: null }))).toBe('choose_tenant');
    expect(sessionGate(sessionFixture())).toBe('ready');
  });

  it('safeNext only allows in-app paths (no open redirect)', () => {
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/x\n']) expect(safeNext(bad)).toBe('/');
    expect(safeNext('/contacts/1?tab=notes')).toBe('/contacts/1?tab=notes');
  });

  it('pathAfterAuth carries the requested page through each required step', () => {
    expect(pathAfterAuth(sessionFixture(), '/search')).toBe('/search');
    expect(pathAfterAuth(null, '/search')).toBe('/login?next=%2Fsearch');
    expect(pathAfterAuth(sessionFixture({ mfa: { enabled: true, verified: false, enrollmentRequired: false } }), '/')).toBe('/login/mfa');
    expect(pathAfterAuth(sessionFixture({ tenant: null }), '//evil')).toBe('/choose-team');
  });
});
