// Account-security flows added by the security-hardening lane (docs/SECURITY.md §Auth):
//   POST /auth/logout-all            revoke every live session of the caller (all devices)
//   POST /auth/mfa/recovery-codes    replace the recovery codes (fresh re-auth + verified MFA)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_PASSWORD, createApiHarness, safeJson } from './testHarness.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
const liveSessions = async (userId: string) =>
  (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0]!.n;

describe('log out of all sessions', () => {
  it('revokes every live session of the caller (other devices included), clears the cookie, audits it, and leaves other users alone', async () => {
    const owner = await h.signup({ mfa: false });
    const agent = await h.invite(owner, 'agent');
    const phone = await h.login(agent.email, TEST_PASSWORD, '10.20.0.1');
    const laptop = await h.login(agent.email, TEST_PASSWORD, '10.20.0.2');
    expect(await liveSessions(agent.userId!)).toBeGreaterThanOrEqual(3);
    const ownerBefore = await liveSessions(owner.userId!);

    const res = await phone.post('/api/auth/logout-all');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked: number }).revoked).toBeGreaterThanOrEqual(3);
    expect(phone.cookie).toBeNull();
    expect(await liveSessions(agent.userId!)).toBe(0);
    for (const c of [phone, laptop, agent]) expect((await c.get('/api/auth/session')).statusCode).toBe(401);
    expect(await liveSessions(owner.userId!)).toBe(ownerBefore);
    expect((await owner.get('/api/auth/session')).statusCode).toBe(200);

    const audit = await h.su.query<{ action: string }>("SELECT action FROM audit_log WHERE actor_user_id = $1 AND action = 'session.revoked_all'", [agent.userId]);
    expect(audit.rows).toHaveLength(1);
    const ev = await h.su.query("SELECT 1 FROM auth_events WHERE user_id = $1 AND event = 'session_revoked'", [agent.userId]);
    expect(ev.rowCount).toBe(1);
  });

  it('needs the CSRF token like every unsafe route, and a fully verified session: a password-only (MFA-pending) session cannot sign the user out everywhere', async () => {
    const owner = await h.signup();
    const pending = await h.login(owner.email, TEST_PASSWORD, '10.20.0.3');
    expect(code(await pending.post('/api/auth/logout-all'))).toBe('MFA_REQUIRED');
    expect(code(await owner.post('/api/auth/logout-all', {}, { csrf: 'none' }))).toBe('CSRF_INVALID');
    expect((await owner.get('/api/auth/session')).statusCode).toBe(200);
    expect((await owner.post('/api/auth/logout-all')).statusCode).toBe(200);
    expect((await owner.get('/api/auth/session')).statusCode).toBe(401);
    expect((await pending.get('/api/auth/session')).statusCode).toBe(401);
  });

  it('without a session it is 401', async () => {
    expect((await h.client('10.20.0.4').post('/api/auth/logout-all')).statusCode).toBe(401);
  });
});

describe('MFA recovery codes', () => {
  it('enrollment returns 10 single-use codes stored only as hashes', async () => {
    const owner = await h.signup({ mfa: false });
    const codes = await h.enrollMfa(owner);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const rows = await h.su.query<{ code_hash: Buffer }>('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [owner.userId]);
    expect(rows.rows).toHaveLength(10);
    const stored = rows.rows.map((r) => r.code_hash.toString('hex')).join(' ');
    for (const c of codes) expect(stored).not.toContain(Buffer.from(c).toString('hex'));
  });

  it('regenerating replaces every old code (the old ones stop working) and needs a fresh re-authentication', async () => {
    const owner = await h.signup({ mfa: false });
    const old = await h.enrollMfa(owner);
    const res = await owner.post('/api/auth/mfa/recovery-codes');
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    const audit = await h.su.query("SELECT 1 FROM audit_log WHERE actor_user_id = $1 AND action = 'mfa.recovery_codes_regenerated'", [owner.userId]);
    expect(audit.rowCount).toBe(1);

    const c1 = await h.login(owner.email, TEST_PASSWORD, '10.21.0.1');
    expect(code(await c1.post('/api/auth/mfa/verify', { recoveryCode: old[0] }))).toBe('MFA_CODE_INVALID');
    const ok = await c1.post('/api/auth/mfa/verify', { recoveryCode: fresh[0] });
    expect(ok.statusCode).toBe(200);
    const c2 = await h.login(owner.email, TEST_PASSWORD, '10.21.0.2');
    expect(code(await c2.post('/api/auth/mfa/verify', { recoveryCode: fresh[0] }))).toBe('MFA_CODE_INVALID');
  });

  it('a stale re-auth is REAUTH_REQUIRED; an MFA-pending session is MFA_REQUIRED; without MFA it is MFA_NOT_ENROLLED', async () => {
    const owner = await h.signup({ mfa: false });
    await h.enrollMfa(owner);
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = $1 AND revoked_at IS NULL", [owner.userId]);
    expect(code(await owner.post('/api/auth/mfa/recovery-codes'))).toBe('REAUTH_REQUIRED');

    const pending = await h.login(owner.email, TEST_PASSWORD, '10.21.0.3');
    expect(code(await pending.post('/api/auth/mfa/recovery-codes'))).toBe('MFA_REQUIRED');

    const o2 = await h.signup({ mfa: false });
    const agent = await h.invite(o2, 'agent');
    expect(code(await agent.post('/api/auth/mfa/recovery-codes'))).toBe('MFA_NOT_ENROLLED');
  });

  it('the session reports how many unused recovery codes remain (so the UI can warn before they run out)', async () => {
    const owner = await h.signup({ mfa: false });
    const codes = await h.enrollMfa(owner);
    const s1 = (await owner.get('/api/auth/session')).json() as { mfa: { recoveryCodesRemaining: number | null } };
    expect(s1.mfa.recoveryCodesRemaining).toBe(10);
    const c = await h.login(owner.email, TEST_PASSWORD, '10.21.0.4');
    await c.post('/api/auth/mfa/verify', { recoveryCode: codes[3] });
    const s2 = (await c.get('/api/auth/session')).json() as { mfa: { recoveryCodesRemaining: number | null } };
    expect(s2.mfa.recoveryCodesRemaining).toBe(9);
  });
});
