// Config, error mapping, response-schema snapshots (R-AST-13 / R-TEN-3 checks for the platform's
// schemas) and the BUILD_PLAN `issueSession` signature.
import { randomBytes } from 'node:crypto';
import { BASE_ERROR_CODES } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PLATFORM_RESPONSE_SCHEMAS } from './auth/common.js';
import { issueSession } from './auth/index.js';
import { type ApiHarness, type TestClient, createApiHarness } from './auth/testHarness.js';
import { ConfigError, loadConfig, redactConfig } from './config.js';
import { ERROR_STATUS, errorBody } from './errors.js';

const env = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://x',
  KEK_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
  ...o,
});

describe('config', () => {
  it('requires a 32-byte KEK and session secret; production requires Secure cookies and real webhook secrets', () => {
    expect(() => loadConfig(env({ KEK_BASE64: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ KEK_BASE64: randomBytes(16).toString('base64') }))).toThrow(/32 bytes/);
    expect(() => loadConfig(env({ SESSION_SECRET_BASE64: 'abc' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'true' }))).toThrow(/WEBHOOK_SECRET is required in production/);
    const prodEnv = env({ NODE_ENV: 'production', TELEPHONY_WEBHOOK_SECRET: 'x'.repeat(32), EMAIL_WEBHOOK_SECRET: 'y'.repeat(32), LEAD_WEBHOOK_SECRET: 'z'.repeat(32) });
    expect(() => loadConfig({ ...prodEnv, SESSION_COOKIE_SECURE: 'false' })).toThrow(/SESSION_COOKIE_SECURE/);
    const prod = loadConfig(prodEnv);
    expect(prod.cookieSecure).toBe(true);
    const dev = loadConfig(env({ WEB_ORIGIN: 'http://localhost:5173, https://app.example.test' }));
    expect(dev.webOrigins).toEqual(['http://localhost:5173', 'https://app.example.test']);
    expect(dev.providers).toEqual({ ai: 'fake', telephony: 'fake', email: 'fake', storage: 'local', push: 'fake' });
  });

  it('redactConfig carries no keys or secrets', () => {
    const c = loadConfig(env({ ANTHROPIC_API_KEY: 'sk-ant-secret' }));
    const s = JSON.stringify(redactConfig(c));
    expect(s).not.toContain('sk-ant-secret');
    expect(s).not.toContain(Buffer.from(c.kek).toString('base64'));
    expect(s).not.toContain(c.webhookSecrets.telephony);
  });
});

describe('errors', () => {
  it('maps every base code to its CONVENTIONS §7 status; the body is { error: { code, requestId, details? } }', () => {
    for (const c of BASE_ERROR_CODES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(ERROR_STATUS).toMatchObject({
      NOT_FOUND: 404,
      UNAUTHENTICATED: 401,
      REAUTH_REQUIRED: 401,
      MFA_ENROLLMENT_REQUIRED: 403,
      CSRF_INVALID: 403,
      RATE_LIMITED: 429,
      VALIDATION_FAILED: 422,
      INTERNAL_ERROR: 500,
    });
    for (const code of Object.keys(ERROR_STATUS)) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
    expect(errorBody('NOT_FOUND', 'r1')).toEqual({ error: { code: 'NOT_FOUND', requestId: 'r1' } });
  });
});

describe('response schemas', () => {
  it('platform response schemas have no confidence* fields and no tenant_id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(PLATFORM_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});

describe('issueSession (BUILD_PLAN signature)', () => {
  let h: ApiHarness;
  let agent: TestClient;
  beforeAll(async () => {
    h = await createApiHarness();
    agent = await h.invite(await h.signup(), 'agent');
  });
  afterAll(async () => {
    await h?.close();
  });

  it('issues a working session cookie for an active membership and refuses a tenant the user is not in', async () => {
    const s = await issueSession(agent.userId!, agent.tenantId!, { db: h.database });
    expect(s.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const c = h.client();
    c.cookie = s.cookie;
    const r = await c.get('/api/auth/session');
    expect(r.statusCode).toBe(200);
    expect(r.json().tenant.id).toBe(agent.tenantId);
    await expect(issueSession(agent.userId!, '01a1c4ba-0000-7000-8000-00000000dead' as never, { db: h.database })).rejects.toThrow(/membership/);
  });
});
