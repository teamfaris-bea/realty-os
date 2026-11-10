// Login, sessions, lockout, rate limits, rotation, password reset (BUILD_PLAN module 8 tests;
// ASVS L2 V2/V3). Real Postgres, real argon2id parameters.
import { performance } from 'node:perf_hooks';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, hashPassword } from './password.js';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness, safeJson } from './testHarness.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  agent = await h.invite(owner, 'agent');
});
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
let ipSeq = 0;
const freshIp = () => `10.20.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

describe('password hashing', () => {
  it('argon2id with m=64 MiB, t=3, p=1', async () => {
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    const hash = await hashPassword('a long enough password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });
});

describe('login', () => {
  it('a correct login returns a session with a CSRF token and writes session.login to audit and login_ok to auth_events', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    const s = await c.get('/api/auth/session');
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ user: { email: agent.email }, tenant: { role: 'agent' }, mfa: { enabled: false, enrollmentRequired: false } });
    const audits = await h.su.query("SELECT 1 FROM audit_log WHERE action = 'session.login' AND actor_user_id = $1", [agent.userId]);
    expect(audits.rowCount).toBeGreaterThanOrEqual(2);
    const ev = await h.su.query<{ email_attempted_hash: string | null }>("SELECT email_attempted_hash FROM auth_events WHERE event = 'login_ok' AND user_id = $1", [agent.userId]);
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('uniform errors: unknown email, wrong password and disabled account all answer 401 LOGIN_FAILED with the same body shape', async () => {
    const unknown = await h.client(freshIp()).post('/api/auth/login', { email: 'nobody@example.test', password: TEST_PASSWORD });
    const wrong = await h.client(freshIp()).post('/api/auth/login', { email: agent.email, password: 'not the password!!' });
    const disabledUser = await h.invite(owner, 'agent');
    await h.su.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabledUser.userId]);
    const disabled = await h.client(freshIp()).post('/api/auth/login', { email: disabledUser.email, password: TEST_PASSWORD });
    for (const r of [unknown, wrong, disabled]) {
      expect(r.statusCode).toBe(401);
      expect(Object.keys(r.json().error).sort()).toEqual(['code', 'requestId']);
      expect(code(r)).toBe('LOGIN_FAILED');
      expect(r.cookies.find((c) => c.name === '__Host-sid')).toBeUndefined();
    }
    // failed attempts never store the plaintext email
    const ev = await h.su.query<{ email_attempted_hash: string }>("SELECT email_attempted_hash FROM auth_events WHERE event = 'login_failed'");
    for (const e of ev.rows) expect(e.email_attempted_hash ?? '').toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify((await h.su.query('SELECT * FROM auth_events')).rows);
    expect(dump).not.toContain('nobody@example.test');
  });

  it('login timing uniformity: an unknown email costs the same argon2id work as a wrong password (dummy hash)', async () => {
    const time = async (email: string) => {
      const c = h.client(freshIp());
      const t0 = performance.now();
      const r = await c.post('/api/auth/login', { email, password: 'definitely wrong pw' });
      expect(r.statusCode).toBe(401);
      return performance.now() - t0;
    };
    const target = await h.invite(owner, 'agent');
    // warm up both paths
    await time('ghost@example.test');
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 4; i++) {
      unknown.push(await time(`ghost${i}@example.test`));
      wrong.push(await time(target.email));
    }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const mu = med(unknown);
    const mw = med(wrong);
    // both paths run one full argon2id verification (tens of ms); an unknown email without the dummy
    // hash would answer in ~1-3 ms
    expect(mu).toBeGreaterThan(15);
    expect(mu / mw).toBeGreaterThan(0.5);
    expect(mu / mw).toBeLessThan(2);
    // keep the target account below the lockout threshold
    await h.su.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [target.userId]);
  });

  it('lockout after 10 failures: the 11th attempt fails even with the right password, uniformly, and logs `locked`', async () => {
    const victim = await h.invite(owner, 'agent');
    for (let i = 0; i < 10; i++) {
      const r = await h.client(freshIp()).post('/api/auth/login', { email: victim.email, password: `wrong password ${i}` });
      expect(r.statusCode).toBe(401);
    }
    const u = await h.su.query<{ failed_login_count: number; locked_until: Date | null }>('SELECT failed_login_count, locked_until FROM users WHERE id = $1', [victim.userId]);
    expect(u.rows[0]!.failed_login_count).toBe(10);
    expect(u.rows[0]!.locked_until!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const right = await h.client(freshIp()).post('/api/auth/login', { email: victim.email, password: TEST_PASSWORD });
    expect(right.statusCode).toBe(401);
    expect(code(right)).toBe('LOGIN_FAILED');
    const locked = await h.su.query("SELECT 1 FROM auth_events WHERE event = 'locked' AND user_id = $1", [victim.userId]);
    expect(locked.rowCount).toBeGreaterThanOrEqual(1);
    // after the lock expires the right password works and resets the counter
    await h.su.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [victim.userId]);
    const ok = await h.client(freshIp()).post('/api/auth/login', { email: victim.email, password: TEST_PASSWORD });
    expect(ok.statusCode).toBe(200);
    const after = await h.su.query<{ failed_login_count: number }>('SELECT failed_login_count FROM users WHERE id = $1', [victim.userId]);
    expect(after.rows[0]!.failed_login_count).toBe(0);
  });

  it('rate limits: 5 attempts per minute per IP+email, then 429 RATE_LIMITED with Retry-After (keys are HMACs)', async () => {
    const ip = freshIp();
    const c = h.client(ip);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.post('/api/auth/login', { email: 'limit@example.test', password: 'whatever pw' })).statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    const last = await c.post('/api/auth/login', { email: 'limit@example.test', password: 'whatever pw' });
    expect(last.statusCode).toBe(429);
    expect(code(last)).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    // another IP for the same email is not blocked by the per-IP+email limit
    expect((await h.client(freshIp()).post('/api/auth/login', { email: 'limit@example.test', password: 'whatever pw' })).statusCode).toBe(401);
    const keys = await h.su.query<{ key: string }>('SELECT key FROM auth_attempts');
    for (const k of keys.rows) {
      expect(k.key).toMatch(/^[a-z_]+:[0-9a-f]{64}$/);
      expect(k.key).not.toContain('limit');
    }
  });
  it('rate limits hold under concurrency: 8 simultaneous attempts for one IP+email let exactly 5 through (atomic counter)', async () => {
    const ip = freshIp();
    const rs = await Promise.all(Array.from({ length: 8 }, () => h.client(ip).post('/api/auth/login', { email: 'burst@example.test', password: 'whatever pw' })));
    const statuses = rs.map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });
});

describe('sessions', () => {
  it('session rotation on login: logging in again issues a new token and revokes the presented one', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    const before = c.cookie!;
    const again = await c.post('/api/auth/login', { email: agent.email, password: TEST_PASSWORD });
    expect(again.statusCode).toBe(200);
    expect(c.cookie).not.toBe(before);
    const stale = h.client();
    stale.cookie = before;
    expect((await stale.get('/api/auth/session')).statusCode).toBe(401);
    const rot = await h.su.query("SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_reason = 'rotation'", [agent.userId]);
    expect(rot.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('session rotation on privilege change: re-authentication and MFA verification replace the session', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    const before = c.cookie!;
    const r = await c.post('/api/auth/reauth', { password: TEST_PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(c.cookie).not.toBe(before);
    const stale = h.client();
    stale.cookie = before;
    expect((await stale.get('/api/auth/session')).statusCode).toBe(401);
    // MFA verification (Owner): the pre-MFA session token dies
    const o = await h.login(owner.email, TEST_PASSWORD, freshIp());
    o.totpSecret = owner.totpSecret;
    o.userId = owner.userId;
    const pre = o.cookie!;
    expect((await o.post('/api/auth/mfa/verify', { code: await o.totp() })).statusCode).toBe(200);
    expect(o.cookie).not.toBe(pre);
    const stalePre = h.client();
    stalePre.cookie = pre;
    expect((await stalePre.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('a role or status change takes effect on the next request (role is read from the membership, never from the session)', async () => {
    const m = await h.invite(owner, 'agent');
    expect((await m.get('/api/auth/session')).json().tenant.role).toBe('agent');
    // the Owner changes the role through RLS (memberships_guard needs an Owner/Admin actor)
    const asOwner = (q: string) => withTenantTx(owner.actor(), async (tx) => void (await sql.raw(q.replace('$1', `'${m.userId}'`)).execute(tx)), { db: h.database });
    await asOwner("UPDATE memberships SET role = 'isa' WHERE user_id = $1");
    expect((await m.get('/api/auth/session')).json().tenant.role).toBe('isa');
    await asOwner("UPDATE memberships SET status = 'suspended' WHERE user_id = $1");
    expect((await m.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('idle and absolute expiry end a session; use slides the idle expiry but never past the absolute one', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    const sid = (await h.su.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [agent.userId])).rows[0]!.id;
    const row = async () =>
      (await h.su.query<{ idle_expires_at: Date; absolute_expires_at: Date; last_seen_at: Date }>('SELECT idle_expires_at, absolute_expires_at, last_seen_at FROM sessions WHERE id = $1', [sid])).rows[0]!;
    const r0 = await row();
    expect(r0.absolute_expires_at.getTime() - r0.last_seen_at.getTime()).toBe(30 * 86_400_000);
    expect(r0.idle_expires_at.getTime() - r0.last_seen_at.getTime()).toBe(168 * 3_600_000);
    await h.su.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours', idle_expires_at = now() + interval '1 hour' WHERE id = $1", [sid]);
    expect((await c.get('/api/auth/session')).statusCode).toBe(200);
    const r1 = await row();
    expect(r1.idle_expires_at.getTime()).toBeGreaterThan(Date.now() + 160 * 3_600_000);
    await h.su.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours', absolute_expires_at = now() + interval '1 hour', idle_expires_at = now() + interval '1 hour' WHERE id = $1", [sid]);
    expect((await c.get('/api/auth/session')).statusCode).toBe(200);
    const r2 = await row();
    expect(r2.idle_expires_at.getTime()).toBeLessThanOrEqual(r2.absolute_expires_at.getTime());
    await h.su.query("UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1", [sid]);
    expect((await c.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('a malformed, unknown or missing cookie is 401 UNAUTHENTICATED', async () => {
    const c = h.client();
    expect(code(await c.get('/api/auth/session'))).toBe('UNAUTHENTICATED');
    c.cookie = 'not-a-token';
    expect((await c.get('/api/auth/session')).statusCode).toBe(401);
    c.cookie = 'A'.repeat(43);
    expect((await c.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('the session cookie is __Host-sid, httpOnly, Secure, SameSite=Lax, Path=/', async () => {
    const r = await h.client(freshIp()).post('/api/auth/login', { email: agent.email, password: TEST_PASSWORD });
    const ck = r.cookies.find((c) => c.name === '__Host-sid')!;
    expect(ck).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(ck.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE token_hash = decode($1, $2)', [ck.value, 'escape']);
    expect(stored.rows[0]!.n).toBe(0); // only sha256(token) is stored
  });

  it('logout revokes the session, clears the cookie and writes session.logout', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    const token = c.cookie!;
    const r = await c.post('/api/auth/logout');
    expect(r.statusCode).toBe(200);
    expect(c.cookie).toBeNull();
    const stale = h.client();
    stale.cookie = token;
    expect((await stale.get('/api/auth/session')).statusCode).toBe(401);
    const a = await h.su.query("SELECT 1 FROM audit_log WHERE action = 'session.logout' AND actor_user_id = $1", [agent.userId]);
    expect(a.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('re-authentication with a wrong password fails and does not refresh reauthenticated_at', async () => {
    const c = await h.login(agent.email, TEST_PASSWORD, freshIp());
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = $1 AND revoked_at IS NULL", [agent.userId]);
    const r = await c.post('/api/auth/reauth', { password: 'wrong wrong wrong' });
    expect(r.statusCode).toBe(401);
    const s = (await c.get('/api/auth/session')).json();
    expect(Date.parse(s.reauthenticatedAt)).toBeLessThan(Date.now() - 50 * 60_000);
  });
});

describe('password reset', () => {
  it('revoke-all on password reset: every session of the user dies, the token is single-use, the new password works', async () => {
    const u = await h.invite(owner, 'agent');
    const s1 = await h.login(u.email, TEST_PASSWORD, freshIp());
    const s2 = await h.login(u.email, TEST_PASSWORD, freshIp());
    expect((await h.client(freshIp()).post('/api/auth/password/reset', { email: u.email })).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const link = h.providers.accountMail.lastLink(u.email)!;
    expect(link).toMatch(/#token=/); // in the fragment: never sent to a server log
    const token = link.split('#token=')[1]!;
    const confirm = await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token, password: 'a brand new passphrase' });
    expect(confirm.statusCode).toBe(200);
    expect((await s1.get('/api/auth/session')).statusCode).toBe(401);
    expect((await s2.get('/api/auth/session')).statusCode).toBe(401);
    expect((await u.get('/api/auth/session')).statusCode).toBe(401);
    const revoked = await h.su.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [u.userId]);
    expect(revoked.rows[0].n).toBe(0);
    const reuse = await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token, password: 'another new passphrase' });
    expect(code(reuse)).toBe('RESET_TOKEN_INVALID');
    expect((await h.client(freshIp()).post('/api/auth/login', { email: u.email, password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await h.client(freshIp()).post('/api/auth/login', { email: u.email, password: 'a brand new passphrase' })).statusCode).toBe(200);
  });

  it('a reset request for an unknown email looks identical (202) and sends nothing; a second request supersedes the first token', async () => {
    const sentBefore = h.providers.accountMail.sent.length;
    const r = await h.client(freshIp()).post('/api/auth/password/reset', { email: 'ghost-reset@example.test' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(h.providers.accountMail.sent.length).toBe(sentBefore);
    const u = await h.invite(owner, 'agent');
    await h.client(freshIp()).post('/api/auth/password/reset', { email: u.email });
    await new Promise((res) => setTimeout(res, 20));
    const first = h.providers.accountMail.lastLink(u.email)!.split('#token=')[1]!;
    await h.client(freshIp()).post('/api/auth/password/reset', { email: u.email });
    await new Promise((res) => setTimeout(res, 20));
    const second = h.providers.accountMail.lastLink(u.email)!.split('#token=')[1]!;
    expect(second).not.toBe(first);
    expect(code(await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token: first, password: 'a brand new passphrase' }))).toBe('RESET_TOKEN_INVALID');
    expect((await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token: second, password: 'a brand new passphrase' })).statusCode).toBe(200);
  });

  it('an expired reset token is refused; weak new passwords are refused', async () => {
    const u = await h.invite(owner, 'agent');
    await h.client(freshIp()).post('/api/auth/password/reset', { email: u.email });
    await new Promise((res) => setTimeout(res, 20));
    const token = h.providers.accountMail.lastLink(u.email)!.split('#token=')[1]!;
    expect(code(await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token, password: 'short' }))).toBe('PASSWORD_TOO_WEAK');
    await h.su.query("UPDATE auth_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1", [u.userId]);
    expect(code(await h.client(freshIp()).post('/api/auth/password/reset/confirm', { token, password: 'a brand new passphrase' }))).toBe('RESET_TOKEN_INVALID');
  });
});
