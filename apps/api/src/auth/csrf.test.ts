// CSRF (x-csrf-token = HMAC(secret, session_id)) and the Origin allowlist (ARCHITECTURE §3 step 4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness, safeJson } from './testHarness.js';
import { csrfTokenFor } from './tokens.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;
let other: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  agent = await h.invite(owner, 'agent');
  other = await h.invite(owner, 'agent');
});
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
const sub = { endpoint: 'https://push.example.test/csrf', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } };

describe('CSRF token', () => {
  it('CSRF negative: an unsafe request without, with a wrong, or with another session’s token is 403 CSRF_INVALID and changes nothing', async () => {
    const before = await h.su.query('SELECT count(*)::int AS n FROM push_subscriptions');
    const missing = await agent.post('/api/push-subscriptions', sub, { csrf: 'none' });
    const wrong = await agent.post('/api/push-subscriptions', sub, { csrf: 'x'.repeat(43) });
    const foreign = await agent.post('/api/push-subscriptions', sub, { csrf: other.csrf! });
    for (const r of [missing, wrong, foreign]) {
      expect(r.statusCode).toBe(403);
      expect(code(r)).toBe('CSRF_INVALID');
    }
    const after = await h.su.query('SELECT count(*)::int AS n FROM push_subscriptions');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await agent.post('/api/push-subscriptions', sub)).statusCode).toBe(201);
  });

  it('the token is HMAC(server secret, session id): it changes when the session rotates', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, '10.9.0.1');
    const sid = (await h.su.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [agent.userId])).rows[0]!.id;
    expect(c.csrf).toBe(csrfTokenFor(h.config.sessionSecret, sid));
    const old = c.csrf!;
    await c.post('/api/auth/reauth', { password: TEST_PASSWORD });
    expect(c.csrf).not.toBe(old);
    expect(code(await c.post('/api/push-subscriptions', sub, { csrf: old }))).toBe('CSRF_INVALID');
  });

  it('safe methods (GET) need no CSRF token', async () => {
    expect((await agent.get('/api/auth/session', { csrf: 'none' })).statusCode).toBe(200);
  });
});

describe('Origin allowlist', () => {
  it('an unsafe request from a foreign Origin, or with no Origin/Referer, is 403 CSRF_INVALID — even on public routes (login CSRF)', async () => {
    const evil = await agent.post('/api/push-subscriptions', sub, { origin: 'https://evil.example' });
    const none = await agent.post('/api/push-subscriptions', sub, { origin: null });
    const login = await h.client('10.9.0.2').post('/api/auth/login', { email: agent.email, password: TEST_PASSWORD }, { origin: 'https://evil.example' });
    const loginNone = await h.client('10.9.0.3').post('/api/auth/login', { email: agent.email, password: TEST_PASSWORD }, { origin: null });
    for (const r of [evil, none, login, loginNone]) {
      expect(r.statusCode).toBe(403);
      expect(code(r)).toBe('CSRF_INVALID');
    }
    expect(login.cookies.find((c) => c.name === '__Host-sid')).toBeUndefined();
  });

  it('a lookalike origin (prefix/suffix tricks) is refused; the exact allowlisted origin is accepted; Referer is the fallback', async () => {
    for (const o of ['http://localhost:5173.evil.example', 'http://localhost:51730', 'https://localhost:5173', 'null']) {
      expect((await agent.post('/api/push-subscriptions', sub, { origin: o })).statusCode).toBe(403);
    }
    const viaReferer = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { referer: 'http://localhost:5173/login?next=/feed', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: agent.email, password: TEST_PASSWORD }),
      remoteAddress: '10.9.0.4',
    });
    expect(viaReferer.statusCode).toBe(200);
  });

  it('CORS answers the allowlisted origin with credentials, and not a foreign one', async () => {
    const ok = await h.app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await h.app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('security headers are set (helmet): no sniffing, no framing', async () => {
    const r = await agent.get('/api/auth/session');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });
});
