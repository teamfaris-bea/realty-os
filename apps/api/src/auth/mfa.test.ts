// TOTP MFA and enrollment-only sessions (R-PERM-14; ASVS L2 V2.8).
import { generateSync } from 'otplib';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness, safeJson } from './testHarness.js';
import { base32Decode, base32Encode, newTotpSecret, totpCode, totpStep, verifyTotp } from './totp.js';

let h: ApiHarness;
let owner: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
});
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
const sub = { endpoint: 'https://push.example.test/mfa', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } };

describe('TOTP', () => {
  it('matches RFC 6238 test vectors (SHA-1) and otplib', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 Appendix B, SHA-1, last 6 digits
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpCode(secret, Math.floor(20000000000 / 30))).toBe('353130');
    const s = newTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    const t = 1_794_300_000_000;
    expect(totpCode(s, totpStep(t))).toBe(generateSync({ secret: s, epoch: t / 1000 } as never));
  });

  it('verification accepts ±1 step and returns the matched step; anything else is rejected', () => {
    const s = newTotpSecret();
    const t = 1_794_300_000_000;
    const step = totpStep(t);
    expect(verifyTotp(s, totpCode(s, step), t)).toBe(step);
    expect(verifyTotp(s, totpCode(s, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, step + 1), t)).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, step + 2), t)).toBeNull();
    expect(verifyTotp(s, '12345', t)).toBeNull();
    expect(verifyTotp(s, 'abcdef', t)).toBeNull();
  });
});

describe('R-PERM-14 Owner/Admin MFA', () => {
  it('R-PERM-14: a new Owner gets an enrollment-only session (403 MFA_ENROLLMENT_REQUIRED) until TOTP enrollment is confirmed', async () => {
    const o = await h.signup({ mfa: false });
    const s = await o.get('/api/auth/session');
    expect(s.statusCode).toBe(200);
    expect(s.json().mfa).toEqual({ enabled: false, verified: false, enrollmentRequired: true });
    const blocked = await o.post('/api/push-subscriptions', sub);
    expect(blocked.statusCode).toBe(403);
    expect(code(blocked)).toBe('MFA_ENROLLMENT_REQUIRED');
    // logging in again does not escape enrollment
    const again = await h.login(o.email, TEST_PASSWORD, '10.8.0.1');
    expect((await again.post('/api/push-subscriptions', sub)).statusCode).toBe(403);
    const codes = await h.enrollMfa(o);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect((await o.post('/api/push-subscriptions', sub)).statusCode).toBe(201);
    const audit = await h.su.query("SELECT 1 FROM audit_log WHERE action = 'session.mfa_enrolled' AND actor_user_id = $1", [o.userId]);
    expect(audit.rowCount).toBe(1);
  });

  it('R-PERM-14: an Admin is enrollment-only too; an agent is not (mfa_required_roles defaults to owner+admin)', async () => {
    const admin = await h.invite(owner, 'admin', { mfa: false });
    expect(code(await admin.post('/api/push-subscriptions', sub))).toBe('MFA_ENROLLMENT_REQUIRED');
    const agent = await h.invite(owner, 'agent');
    expect((await agent.post('/api/push-subscriptions', sub)).statusCode).toBe(201);
  });

  it('R-PERM-14: mfa_required_roles always contains owner and admin (DB CHECK)', async () => {
    // as the Owner (the owner-only trigger passes), so the CHECK is what refuses it
    for (const roles of ['{owner}', '{admin,agent}', '{}']) {
      await expect(
        withTenantTx(owner.actor(), async (tx) => void (await sql`UPDATE tenant_settings SET mfa_required_roles = ${roles}::text[] WHERE tenant_id = app.tenant_id()`.execute(tx)), { db: h.database }),
      ).rejects.toThrow(/check constraint/);
    }
    await withTenantTx(owner.actor(), async (tx) => void (await sql`UPDATE tenant_settings SET mfa_required_roles = '{owner,admin,team_lead}' WHERE tenant_id = app.tenant_id()`.execute(tx)), { db: h.database });
    await withTenantTx(owner.actor(), async (tx) => void (await sql`UPDATE tenant_settings SET mfa_required_roles = '{owner,admin}' WHERE tenant_id = app.tenant_id()`.execute(tx)), { db: h.database });
  });

  it('with MFA enabled, a password-only login is MFA_REQUIRED (401) everywhere except verify/session/logout', async () => {
    const c = await h.login(owner.email, TEST_PASSWORD, '10.8.0.2');
    c.totpSecret = owner.totpSecret;
    const s = await c.get('/api/auth/session');
    expect(s.json().mfa).toMatchObject({ enabled: true, verified: false });
    const r = await c.post('/api/push-subscriptions', sub);
    expect(r.statusCode).toBe(401);
    expect(code(r)).toBe('MFA_REQUIRED');
    expect(code(await c.post('/api/auth/reauth', { password: TEST_PASSWORD }))).toBe('MFA_REQUIRED');
    expect(code(await c.post('/api/auth/mfa/verify', { code: '000000' }))).toBe('MFA_CODE_INVALID');
    const ok = await c.post('/api/auth/mfa/verify', { code: await c.totp() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().next).toBe('ready');
    expect((await c.post('/api/push-subscriptions', sub)).statusCode).toBe(201);
  });

  it('a TOTP code is accepted once (replay of the same code fails)', async () => {
    const c1 = await h.login(owner.email, TEST_PASSWORD, '10.8.0.3');
    const c2 = await h.login(owner.email, TEST_PASSWORD, '10.8.0.4');
    c1.totpSecret = owner.totpSecret;
    const totp = await c1.totp();
    expect((await c1.post('/api/auth/mfa/verify', { code: totp })).statusCode).toBe(200);
    const replay = await c2.post('/api/auth/mfa/verify', { code: totp });
    expect(code(replay)).toBe('MFA_CODE_INVALID');
  });

  it('a TOTP code raced from two sessions at once verifies exactly one of them (atomic replay guard)', async () => {
    const o = await h.signup();
    const c1 = await h.login(o.email, TEST_PASSWORD, '10.8.1.1');
    const c2 = await h.login(o.email, TEST_PASSWORD, '10.8.1.2');
    c1.totpSecret = o.totpSecret;
    c1.userId = o.userId;
    const totp = await c1.totp();
    const [r1, r2] = await Promise.all([c1.post('/api/auth/mfa/verify', { code: totp }), c2.post('/api/auth/mfa/verify', { code: totp })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 401]);
  });

  it('recovery codes work once each; a used code is refused', async () => {
    const o = await h.signup({ mfa: false });
    const codes = await h.enrollMfa(o);
    const c = await h.login(o.email, TEST_PASSWORD, '10.8.0.5');
    expect((await c.post('/api/auth/mfa/verify', { recoveryCode: codes[0]!.toUpperCase() })).statusCode).toBe(200);
    const d = await h.login(o.email, TEST_PASSWORD, '10.8.0.6');
    expect(code(await d.post('/api/auth/mfa/verify', { recoveryCode: codes[0]! }))).toBe('MFA_CODE_INVALID');
    expect((await d.post('/api/auth/mfa/verify', { recoveryCode: codes[1]! })).statusCode).toBe(200);
    const stored = await h.su.query<{ code_hash: Buffer }>('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [o.userId]);
    expect(stored.rows).toHaveLength(10);
    expect(JSON.stringify(stored.rows)).not.toContain(codes[2]!);
  });

  it('MFA verification is rate limited (5 per 5 minutes per user)', async () => {
    const o = await h.signup();
    const c = await h.login(o.email, TEST_PASSWORD, '10.8.0.7');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.post('/api/auth/mfa/verify', { code: '000000' })).statusCode);
    // enrollment confirmation already used 1 of the 5 attempts in this window
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    expect(statuses[5]).toBe(429);
  });

  it('enrollment cannot be restarted once MFA is enabled (a stolen session cannot replace the second factor)', async () => {
    expect(code(await owner.post('/api/auth/mfa/enroll'))).toBe('MFA_ALREADY_ENABLED');
  });

  it('re-authentication of an MFA user needs password AND a fresh TOTP code', async () => {
    const o = await h.signup();
    const c = await h.login(o.email, TEST_PASSWORD, '10.8.0.8');
    c.totpSecret = o.totpSecret;
    c.userId = o.userId;
    await c.post('/api/auth/mfa/verify', { code: await c.totp() });
    expect(code(await c.post('/api/auth/reauth', { password: TEST_PASSWORD }))).toBe('MFA_CODE_INVALID');
    expect((await c.post('/api/auth/reauth', { password: TEST_PASSWORD, code: await c.totp() })).statusCode).toBe(200);
  });
});
