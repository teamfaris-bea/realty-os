// CSRF on every state-changing route (security-hardening lane, docs/SECURITY.md §CSRF).
//
// Enumerates the live route table (every route registered under /api, from the routes.ts registry)
// and proves, per route, that a cross-site request cannot change state:
//   - session / self / Action routes: a valid session WITHOUT x-csrf-token is 403 CSRF_INVALID,
//     and with a foreign Origin is 403 CSRF_INVALID
//   - public routes: a foreign Origin, or none at all, is 403 CSRF_INVALID (login CSRF)
//   - webhook routes: exempt from Origin/CSRF, but an unsigned delivery is 403 WEBHOOK_SIGNATURE_INVALID
// A new route is covered automatically; a route with no unsafe-method protection fails this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness, safeJson } from './testHarness.js';

let h: ApiHarness;
let owner: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
});
afterAll(async () => {
  await h?.close();
});

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
const FAKE_ID = '01900000-0000-7000-8000-000000000000';

function concrete(url: string): string {
  return url.replace(/:([A-Za-z_]+)/g, (_m, name: string) => (/token/i.test(name) ? 'A'.repeat(43) : FAKE_ID)).replace(/\*$/, 'x');
}

function unsafeRoutes() {
  const out: { method: string; url: string; auth: string }[] = [];
  for (const r of h.app.platform.routeTable) {
    for (const m of r.method.split(',')) {
      if (!SAFE.has(m)) out.push({ method: m, url: r.url, auth: String(r.auth) });
    }
  }
  return out;
}

describe('CSRF on every state-changing route', () => {
  it('the route table lists the unsafe routes (sanity: the enumeration is not empty and covers every auth kind)', () => {
    const routes = unsafeRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const kinds = new Set(routes.map((r) => (r.auth === 'public' || r.auth === 'webhook' || r.auth === 'session' || r.auth === 'self' ? r.auth : 'action')));
    for (const k of ['public', 'webhook', 'session', 'self', 'action']) expect(kinds).toContain(k);
  });

  it('every session-bearing unsafe route refuses a request without the CSRF token, or from a foreign Origin, with 403 CSRF_INVALID', async () => {
    const failures: string[] = [];
    for (const r of unsafeRoutes().filter((x) => x.auth !== 'public' && x.auth !== 'webhook')) {
      const url = concrete(r.url);
      const noToken = await owner.request(r.method, url, {}, { csrf: 'none' });
      const foreign = await owner.request(r.method, url, {}, { origin: 'https://evil.example' });
      const noOrigin = await owner.request(r.method, url, {}, { origin: null });
      for (const [label, res] of [['no token', noToken], ['foreign origin', foreign], ['no origin', noOrigin]] as const) {
        if (res.statusCode !== 403 || code(res) !== 'CSRF_INVALID') failures.push(`${r.method} ${r.url} (${label}): ${res.statusCode} ${code(res)}`);
      }
    }
    expect(failures).toEqual([]);
    // the session survived all of that (CSRF failures change nothing, including the session)
    expect((await owner.get('/api/auth/session')).statusCode).toBe(200);
  });

  it('every public unsafe route refuses a foreign Origin and a missing Origin with 403 CSRF_INVALID', async () => {
    const failures: string[] = [];
    const anon = h.client('203.0.113.77');
    for (const r of unsafeRoutes().filter((x) => x.auth === 'public')) {
      const url = concrete(r.url);
      for (const origin of ['https://evil.example', null]) {
        const res = await anon.request(r.method, url, {}, { origin });
        if (res.statusCode !== 403 || code(res) !== 'CSRF_INVALID') failures.push(`${r.method} ${r.url} (${origin}): ${res.statusCode} ${code(res)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every webhook route refuses an unsigned delivery with 403 WEBHOOK_SIGNATURE_INVALID (the signature replaces CSRF)', async () => {
    const failures: string[] = [];
    for (const r of unsafeRoutes().filter((x) => x.auth === 'webhook')) {
      const res = await h.app.inject({ method: r.method as 'POST', url: concrete(r.url), headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, payload: '{}' });
      if (res.statusCode !== 403 || code(res) !== 'WEBHOOK_SIGNATURE_INVALID') failures.push(`${r.method} ${r.url}: ${res.statusCode} ${code(res)}`);
    }
    expect(failures).toEqual([]);
  });

  it('a cross-site form post (text/plain, no preflight) is refused before any handler runs', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', cookie: `__Host-sid=${owner.cookie}` },
      payload: 'x=1',
    });
    expect(res.statusCode).toBe(403);
    expect((await owner.get('/api/auth/session')).statusCode).toBe(200);
  });
});
