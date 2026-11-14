// module 46 (R-PORTALWEB-9): the client API is the portal's only fetch caller.
import { describe, expect, it, vi } from 'vitest';
import { PortalError, isPortalPath, noBody, portalApi, shouldRetry } from './api.js';
import { parseMe } from './view/index.js';
import { CSRF, me } from './test/fixtures.js';

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('portalApi (R-PORTALWEB-9)', () => {
  it('R-PORTALWEB-9: a path outside /api/portal/ throws before anything is fetched', async () => {
    const f = vi.fn();
    const api = portalApi(f);
    for (const p of ['/api/me', '/api/auth/session', '/portal/me', 'https://evil.example.test/api/portal/me', '//evil.example.test/api/portal/me', '/api/portal/../me', '/api/portal/%2e%2e/me', '/api/portal/me#x', '/api/portal/a\\b']) {
      await expect(api.request('GET', p, parseMe), p).rejects.toThrow(/not a portal API path/);
    }
    expect(f).not.toHaveBeenCalled();
    expect(isPortalPath('/api/portal/timeline?grantId=x')).toBe(true);
  });

  it('R-PORTALWEB-9: same-origin credentials; the CSRF token goes on POST only, from memory', async () => {
    const f = vi.fn(async () => json(200, me()));
    const api = portalApi(f);
    await api.request('GET', '/api/portal/me', parseMe);
    api.setCsrf(CSRF);
    await api.request('GET', '/api/portal/me', parseMe);
    f.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.request('POST', '/api/portal/logout', noBody);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([, i]) => i.credentials)).toEqual(['same-origin', 'same-origin', 'same-origin']);
    expect(calls.map(([, i]) => (i.headers as Record<string, string>)['x-csrf-token'])).toEqual([undefined, undefined, CSRF]);
    expect((calls[2]![1].headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('errors are code-only; an unreadable answer is BAD_RESPONSE; a failed fetch is NETWORK_ERROR', async () => {
    const api = portalApi(async () => json(404, { error: { code: 'NOT_FOUND', requestId: 'r', details: { x: 1 } } }));
    await expect(api.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, details: { x: 1 } });
    const html = portalApi(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(html.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 502 });
    const bad = portalApi(async () => json(200, { account: { status: 'active' }, grants: 'nope' }));
    await expect(bad.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 200 });
    const odd = portalApi(async () => json(400, { error: { code: '<script>' } }));
    await expect(odd.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const down = portalApi(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(down.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('R-PORTALWEB-9 (E685): only a 401 PORTAL_SESSION_REQUIRED emits signedOut, and it forgets the CSRF token', async () => {
    let next = json(401, { error: { code: 'PORTAL_LINK_INVALID', requestId: 'r' } });
    const api = portalApi(async () => next);
    const out = vi.fn();
    api.onSignedOut(out);
    api.setCsrf(CSRF);
    await expect(api.request('POST', '/api/portal/session', parseMe, { token: 'x' })).rejects.toBeInstanceOf(PortalError);
    next = json(403, { error: { code: 'CSRF_INVALID', requestId: 'r' } });
    await expect(api.request('POST', '/api/portal/logout', noBody)).rejects.toMatchObject({ code: 'CSRF_INVALID' });
    expect(out).not.toHaveBeenCalled();
    expect(api.hasCsrf()).toBe(true);
    next = json(401, { error: { code: 'PORTAL_SESSION_REQUIRED', requestId: 'r' } });
    await expect(api.request('GET', '/api/portal/me', parseMe)).rejects.toMatchObject({ code: 'PORTAL_SESSION_REQUIRED' });
    expect(out).toHaveBeenCalledTimes(1);
    expect(api.hasCsrf()).toBe(false);
  });

  it('fetchFile fetches only a same-origin portal file URL', async () => {
    const f = vi.fn(async () => new Response('x'));
    const api = portalApi(f);
    await expect(api.fetchFile('https://evil.example.test/api/portal/files/' + 'a'.repeat(43))).rejects.toThrow();
    await expect(api.fetchFile('/api/portal/files/' + 'a'.repeat(42))).rejects.toThrow();
    await api.fetchFile('/api/portal/files/' + 'a'.repeat(43));
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('same-origin');
  });

  it('the staff retry rule: reads retry on a network error or 502-504 (twice at most); never on 4xx', () => {
    expect(shouldRetry(0, new PortalError('NETWORK_ERROR', 0))).toBe(true);
    expect(shouldRetry(1, new PortalError('BAD_RESPONSE', 503))).toBe(true);
    expect(shouldRetry(2, new PortalError('BAD_RESPONSE', 503))).toBe(false);
    expect(shouldRetry(0, new PortalError('NOT_FOUND', 404))).toBe(false);
    expect(shouldRetry(0, new PortalError('PORTAL_SESSION_REQUIRED', 401))).toBe(false);
    expect(shouldRetry(0, new PortalError('PORTAL_NOT_AVAILABLE', 503))).toBe(true);
    expect(shouldRetry(0, new Error('x'))).toBe(false);
  });
});
