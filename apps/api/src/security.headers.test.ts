// API response headers and production secret hygiene (security-hardening lane, docs/SECURITY.md).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from './auth/testHarness.js';
import { ConfigError, loadConfig } from './config.js';

let h: ApiHarness;
let owner: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
});
afterAll(async () => {
  await h?.close();
});

describe('API response headers', () => {
  it('every API response is Cache-Control: no-store (session payloads carry the CSRF token and PII), including errors', async () => {
    for (const r of [await owner.get('/api/auth/session'), await h.client().get('/api/auth/session'), await owner.get('/api/nope'), await owner.post('/api/auth/login', { email: 'x' })]) {
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('helmet: HSTS, deny-all CSP, no framing, no sniffing, no referrer, no x-powered-by', async () => {
    const r = await owner.get('/api/auth/session');
    expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=\d{7,}/);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toMatch(/^(DENY|SAMEORIGIN)$/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('error bodies never echo input, SQL or stacks', async () => {
    const r = await owner.post('/api/auth/login', { email: 'probe@example.test', password: "' OR 1=1 --" });
    expect(r.body).not.toContain('probe@example.test');
    expect(r.body).not.toContain('OR 1=1');
    expect(Object.keys((r.json() as { error: Record<string, unknown> }).error).sort()).toEqual(['code', 'requestId']);
  });
});

describe('production secrets', () => {
  const key = () => randomBytes(32).toString('base64');
  const prod = (over: Record<string, string> = {}) => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x',
    KEK_BASE64: key(),
    SESSION_SECRET_BASE64: key(),
    WEB_ORIGIN: 'https://app.example.test',
    PUBLIC_BASE_URL: 'https://app.example.test',
    TELEPHONY_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    EMAIL_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    LEAD_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    ...over,
  });

  it('a valid production configuration loads', () => {
    expect(loadConfig(prod()).env).toBe('production');
  });

  it('production refuses a KEK equal to the session secret (one key, two purposes)', () => {
    const k = key();
    expect(() => loadConfig(prod({ KEK_BASE64: k, SESSION_SECRET_BASE64: k }))).toThrow(ConfigError);
  });

  it('production refuses webhook secrets shared between providers (one leaked secret would forge every provider)', () => {
    const s = randomBytes(24).toString('hex');
    expect(() => loadConfig(prod({ EMAIL_WEBHOOK_SECRET: s, LEAD_WEBHOOK_SECRET: s }))).toThrow(ConfigError);
  });

  it('config errors never contain the secret values', () => {
    const k = key();
    try {
      loadConfig(prod({ KEK_BASE64: k, SESSION_SECRET_BASE64: k }));
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(k);
    }
  });
});
