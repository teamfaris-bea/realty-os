// Adversarial verification of api/platform (auth, sessions, guards, devices). Each test here was
// written to break a specific guarantee the module claims (ARCHITECTURE §3, BUILD_PLAN module 8,
// R-PERM-13, R-PERM-14, ASVS L2 V2/V3) and failed against the first implementation.
// Real Postgres, real argon2id, concurrent connections for the races.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProviders } from '../providers/index.js';
import { signedHeader } from '../providers/webhooks.js';
import { RouteAuthorizationError, authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { routeModules } from '../routes.js';
import { buildServer } from '../server.js';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness, safeJson, testConfig } from './testHarness.js';

/** A signed webhook route with a strict body schema (signature must be checked before validation). */
const strictWebhook: RouteModule = {
  name: 'strict-webhook-probe',
  async register(app: FastifyInstance) {
    app.post(
      '/webhooks/test/strict',
      { config: { auth: 'webhook', webhookProvider: 'lead' }, schema: { body: z.object({ id: z.string().min(1) }).strict() } },
      async () => ({ ok: true }),
    );
  },
};

let h: ApiHarness;
let owner: TestClient;

beforeAll(async () => {
  h = await createApiHarness({ routeModules: [...routeModules, strictWebhook] });
  owner = await h.signup();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
let ipSeq = 0;
const freshIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const reauthAt = (r: { body: string }) => (safeJson(r.body) as { session?: { reauthenticatedAt?: string | null } } | null)?.session?.reauthenticatedAt ?? null;

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached');
}

describe('login timing uniformity (ASVS 2.2 / uniform login errors)', () => {
  it('R-AUTH: an over-long password costs the same argon2id work for a known email as for an unknown one (no length short-circuit)', async () => {
    const target = await h.invite(owner, 'agent');
    const long = 'x'.repeat(300); // accepted by the login schema (≤ 1024), above the hashing cap (256)
    const time = async (email: string) => {
      const t0 = performance.now();
      const r = await h.client(freshIp()).post('/api/auth/login', { email, password: long });
      expect(r.statusCode).toBe(401);
      expect(code(r)).toBe('LOGIN_FAILED');
      return performance.now() - t0;
    };
    await time('ghost-long@example.test');
    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < 4; i++) {
      unknown.push(await time(`ghost-long${i}@example.test`));
      known.push(await time(target.email));
    }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    // without the fix the known-email path skipped argon2 entirely (~2 ms vs tens of ms)
    expect(med(known)).toBeGreaterThan(15);
    expect(med(unknown) / med(known)).toBeLessThan(2);
    expect(med(unknown) / med(known)).toBeGreaterThan(0.5);
    await h.su.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [target.userId]);
  });
});

describe('R-PERM-13 re-authentication cannot be minted without the password', () => {
  it('R-PERM-13: confirming MFA enrollment needs a fresh re-auth and never refreshes reauthenticated_at (a stolen agent session cannot mint one)', async () => {
    const agent = await h.invite(owner, 'agent');
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [agent.userId]);
    const e = await agent.post('/api/auth/mfa/enroll');
    expect(e.statusCode).toBe(200);
    agent.totpSecret = (e.json() as { secret: string }).secret;
    const stale = await agent.post('/api/auth/mfa/enroll/confirm', { code: await agent.totp() });
    expect(stale.statusCode).toBe(401);
    expect(code(stale)).toBe('REAUTH_REQUIRED');
    const u = await h.su.query<{ mfa_enabled_at: Date | null }>('SELECT mfa_enabled_at FROM users WHERE id = $1', [agent.userId]);
    expect(u.rows[0]!.mfa_enabled_at).toBeNull();
    // after a real re-authentication (password) enrollment works, and keeps THAT re-auth instant
    const re = await agent.post('/api/auth/reauth', { password: TEST_PASSWORD });
    expect(re.statusCode).toBe(200);
    const ok = await agent.post('/api/auth/mfa/enroll/confirm', { code: await agent.totp() });
    expect(ok.statusCode).toBe(200);
    expect(reauthAt(ok)).toBe(reauthAt(re));
  });

  it('R-PERM-13: a TOTP or recovery code alone (mfa/verify) does not refresh re-authentication; it carries the login-time instant', async () => {
    const o = await h.signup({ mfa: false });
    const recovery = await h.enrollMfa(o);
    const c = await h.login(o.email, TEST_PASSWORD, freshIp());
    c.totpSecret = o.totpSecret;
    c.userId = o.userId;
    const loginReauth = (await c.get('/api/auth/session')).json().reauthenticatedAt as string;
    const v = await c.post('/api/auth/mfa/verify', { code: await c.totp() });
    expect(v.statusCode).toBe(200);
    expect(reauthAt(v)).toBe(loginReauth);
    // 16 minutes later, a second-factor code alone must not make the session "freshly re-authenticated"
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [o.userId]);
    const again = await c.post('/api/auth/mfa/verify', { recoveryCode: recovery[0]! });
    expect(again.statusCode).toBe(200);
    expect(Date.parse(reauthAt(again)!)).toBeLessThan(Date.now() - 15 * 60_000);
    const s = (await c.get('/api/auth/session')).json() as { reauthenticatedAt: string };
    expect(Date.parse(s.reauthenticatedAt)).toBeLessThan(Date.now() - 15 * 60_000);
  });

  it('R-PERM-14: an enrollment-only session whose login re-auth went stale can re-authenticate (password) and then enroll', async () => {
    const o = await h.signup({ mfa: false });
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [o.userId]);
    const re = await o.post('/api/auth/reauth', { password: TEST_PASSWORD });
    expect(re.statusCode).toBe(200);
    await h.enrollMfa(o);
    expect((await o.get('/api/auth/session')).json().mfa).toMatchObject({ enabled: true, verified: true, enrollmentRequired: false });
  });
});

describe('guard order: authentication before input validation', () => {
  it('an anonymous request with a malformed body is 401 UNAUTHENTICATED, not 422 (no schema probing without a session)', async () => {
    const anon = h.client(freshIp());
    const r = await anon.post('/api/push-subscriptions', { endpoint: 'not a url', extra: 1 });
    expect(r.statusCode).toBe(401);
    expect(code(r)).toBe('UNAUTHENTICATED');
    // and CSRF is checked before validation too
    const agent = await h.invite(owner, 'agent');
    const noCsrf = await agent.post('/api/push-subscriptions', { endpoint: 'not a url' }, { csrf: 'none' });
    expect(noCsrf.statusCode).toBe(403);
    expect(code(noCsrf)).toBe('CSRF_INVALID');
  });

  it('a mis-signed webhook with a malformed body is 403 and recorded as a rejected delivery (signature before validation)', async () => {
    const before = (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'")).rows[0]!.n;
    const raw = '{"unexpected":true}';
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/webhooks/test/strict',
      headers: { 'content-type': 'application/json', 'x-realty-signature': signedHeader('not-the-real-secret-00', Math.floor(Date.now() / 1000), raw) },
      payload: raw,
    });
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe('WEBHOOK_SIGNATURE_INVALID');
    const after = (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'")).rows[0]!.n;
    expect(after - before).toBe(1);
    // a correctly signed but malformed body is a validation error
    const good = await h.app.inject({
      method: 'POST',
      url: '/api/webhooks/test/strict',
      headers: { 'content-type': 'application/json', 'x-realty-signature': signedHeader(h.config.webhookSecrets.lead, Math.floor(Date.now() / 1000), raw) },
      payload: raw,
    });
    expect(good.statusCode).toBe(422);
  });
});

describe('route declarations cannot widen the MFA partial states', () => {
  const boot = async (m: RouteModule) => {
    const app = buildServer(testConfig(), {
      providers: createFakeProviders(),
      clock: { now: () => Date.now() as never },
      ids: { next: () => '01a1c4ba-0000-7000-8000-000000000000' as never },
      db: h.database,
      routeModules: [m],
    });
    try {
      await app.ready();
      return null;
    } catch (e) {
      return e;
    } finally {
      await app.close().catch(() => {});
    }
  };

  it('R-PERM-14: the server refuses to start when an Action or self route opts into the enrollment-only / MFA-pending states', async () => {
    expect(
      await boot({
        name: 'bad',
        register: async (app) =>
          void app.post('/x', { config: { auth: 'data.export', allowPartial: ['enrollment'] }, preHandler: authorize('data.export', () => ({})) }, async () => ({})),
      }),
    ).toBeInstanceOf(RouteAuthorizationError);
    expect(await boot({ name: 'bad', register: async (app) => void app.post('/y', { config: { auth: 'self', allowPartial: ['mfa_pending'] } }, async () => ({})) })).toBeInstanceOf(
      RouteAuthorizationError,
    );
    expect(await boot({ name: 'bad', register: async (app) => void app.post('/z', { config: { auth: 'public', allowPartial: ['enrollment'] } }, async () => ({})) })).toBeInstanceOf(
      RouteAuthorizationError,
    );
    expect(await boot({ name: 'ok', register: async (app) => void app.post('/w', { config: { auth: 'session', allowPartial: ['enrollment'] } }, async () => ({})) })).toBeNull();
  });
});

describe('push endpoints (SSRF)', () => {
  it('only public push-service URLs are accepted: IP literals, localhost, internal or single-label names and custom ports are refused', async () => {
    const agent = await h.invite(owner, 'agent');
    const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' };
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/push',
      'https://[::1]/push',
      'https://2130706433/push',
      'https://localhost/push',
      'https://api.localhost/push',
      'https://metadata.google.internal/computeMetadata',
      'https://printer.local/push',
      'https://intranet/push',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    ]) {
      const r = await agent.post('/api/push-subscriptions', { endpoint, keys });
      expect([endpoint, r.statusCode]).toEqual([endpoint, 422]);
    }
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGx1', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA']) {
      const r = await agent.post('/api/push-subscriptions', { endpoint, keys });
      expect([endpoint, r.statusCode]).toEqual([endpoint, 201]);
    }
  });
});

describe('session rotation vs revoke-all (race)', () => {
  it('R-AUTH revoke-all on password reset: a rotation (tenant switch) whose presented session is revoked mid-flight issues no new session', async () => {
    const victim = await h.invite(owner, 'agent');
    const slug = ((await victim.get('/api/auth/session')).json() as { tenant: { slug: string } }).tenant.slug;
    const lock = new pg.Client({ connectionString: h.testDb.ownerUrl });
    await lock.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [victim.userId]);
      const inFlight = victim.post('/api/auth/tenant-switch', { slug });
      await waitFor(async () => {
        const w = await h.su.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'app_user' AND wait_event_type = 'Lock'",
        );
        return w.rows[0]!.n > 0;
      });
      // the password reset (revoke-all) commits while the rotation waits on the session row
      await lock.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_change' WHERE user_id = $1 AND revoked_at IS NULL", [victim.userId]);
      await lock.query('COMMIT');
      const res = await inFlight;
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('UNAUTHENTICATED');
    } finally {
      await lock.end();
    }
    const live = await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [victim.userId]);
    expect(live.rows[0]!.n).toBe(0);
    expect((await victim.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('R-AUTH: two concurrent rotations of one session (two tenant switches) cannot fork it — exactly one succeeds and one session stays live', async () => {
    const m = await h.invite(owner, 'agent');
    const slug = ((await m.get('/api/auth/session')).json() as { tenant: { slug: string } }).tenant.slug;
    const twin = h.client(freshIp());
    twin.cookie = m.cookie;
    twin.csrf = m.csrf;
    const res = await Promise.all([m.post('/api/auth/tenant-switch', { slug }), twin.post('/api/auth/tenant-switch', { slug })]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const live = await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [m.userId]);
    expect(live.rows[0]!.n).toBe(1);
  });

  it('a login presented with an already-revoked cookie of the same user still succeeds (the old cookie is best-effort revoked)', async () => {
    const m = await h.invite(owner, 'agent');
    await h.su.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_change' WHERE user_id = $1 AND revoked_at IS NULL", [m.userId]);
    const r = await m.post('/api/auth/login', { email: m.email, password: TEST_PASSWORD }, { ip: freshIp() });
    expect(r.statusCode).toBe(200);
  });
});

describe('general rate limit', () => {
  let small: ApiHarness;
  beforeAll(async () => {
    small = await createApiHarness({ config: { globalRateLimitPerMinute: 10 } });
  }, 180_000);
  afterAll(async () => {
    await small?.close();
  });

  it('the per-session/IP request budget cannot be escaped by presenting a different random session cookie on every request', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const c = small.client('203.0.113.99');
      c.cookie = randomBytes(32).toString('base64url');
      statuses.push((await c.get('/api/auth/session')).statusCode);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
  });

  it('a signed-in user keeps a budget of their own (another session on the same IP is not starved by anonymous traffic)', async () => {
    const o = await small.signup({ mfa: false });
    // the anonymous flood above used 203.0.113.99; a session on that IP still gets through
    const c = small.client('203.0.113.99');
    c.cookie = o.cookie;
    c.csrf = o.csrf;
    expect((await c.get('/api/auth/session')).statusCode).toBe(200);
  });
});
