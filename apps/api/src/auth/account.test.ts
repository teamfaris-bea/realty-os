// Signup (tenant provisioning with wrapped keys), invite acceptance and tenant switching.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness, safeJson } from './testHarness.js';

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
const signupBody = (o: Record<string, string> = {}) => ({
  email: `new-${Math.random().toString(36).slice(2, 8)}@example.test`,
  password: TEST_PASSWORD,
  displayName: 'Nina New',
  teamName: 'Nina Team',
  slug: `n-${Math.random().toString(36).slice(2, 8)}`,
  timezone: 'America/Chicago',
  brokerageLegalName: 'Prairie Homes LLC',
  ...o,
});

describe('signup', () => {
  it('provisions the tenant (owner membership, policy v1, settings, default team and pond, three wrapped keys) in one transaction', async () => {
    const t = owner.tenantId!;
    const q = async (sql: string) => (await h.su.query(sql, [t])).rows;
    expect(await q('SELECT role, status FROM memberships WHERE tenant_id = $1')).toEqual([{ role: 'owner', status: 'active' }]);
    expect((await q('SELECT version_no FROM compliance_policy_versions WHERE tenant_id = $1'))[0]).toEqual({ version_no: 1 });
    expect((await q('SELECT brokerage_legal_name, default_timezone FROM tenant_settings WHERE tenant_id = $1'))[0]).toEqual({ brokerage_legal_name: 'Harbor Realty LLC', default_timezone: 'America/New_York' });
    expect((await q('SELECT count(*)::int AS n FROM teams WHERE tenant_id = $1 AND is_default'))[0]).toEqual({ n: 1 });
    expect((await q('SELECT count(*)::int AS n FROM ponds WHERE tenant_id = $1 AND is_default'))[0]).toEqual({ n: 1 });
    expect((await q('SELECT purpose, key_version FROM tenant_keys WHERE tenant_id = $1 ORDER BY purpose')).map((r) => `${r.purpose}:${r.key_version}`)).toEqual(['field:1', 'hmac:1', 'object:1']);
    const u = (await h.su.query<{ password_hash: string; email: string }>('SELECT password_hash, email FROM users WHERE id = $1', [owner.userId])).rows[0]!;
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('a taken slug is SLUG_TAKEN; a registered email is SIGNUP_UNAVAILABLE and nothing is half-created', async () => {
    const slug = (await owner.get('/api/auth/session')).json().tenant.slug as string;
    const c1 = h.client('10.5.0.1');
    expect(code(await c1.post('/api/auth/signup', signupBody({ slug })))).toBe('SLUG_TAKEN');
    const usersBefore = (await h.su.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const tenantsBefore = (await h.su.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
    expect(code(await h.client('10.5.0.2').post('/api/auth/signup', signupBody({ email: owner.email })))).toBe('SIGNUP_UNAVAILABLE');
    expect((await h.su.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore);
    expect((await h.su.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n).toBe(tenantsBefore);
  });

  it('weak passwords, unknown time zones and malformed emails are refused before anything is written', async () => {
    const c = h.client('10.5.0.3');
    expect(code(await c.post('/api/auth/signup', signupBody({ password: 'short' })))).toBe('PASSWORD_TOO_WEAK');
    expect(code(await c.post('/api/auth/signup', signupBody({ password: 'password1234' })))).toBe('PASSWORD_TOO_WEAK');
    expect(code(await c.post('/api/auth/signup', signupBody({ timezone: 'Mars/Olympus' })))).toBe('TIMEZONE_INVALID');
    expect(code(await c.post('/api/auth/signup', signupBody({ email: 'not-an-email' })))).toBe('EMAIL_INVALID');
  });
});

describe('invites', () => {
  it('a new user accepts with a password and lands in the inviting tenant with the invited role; the token works once', async () => {
    const email = 'invitee@example.test';
    const token = await h.inviteToken(owner, 'team_lead', email);
    const c = h.client('10.5.0.4');
    const r = await c.post(`/api/auth/invites/${token}/accept`, { displayName: 'Tina Lead', password: TEST_PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(r.json().session.tenant).toMatchObject({ id: owner.tenantId, role: 'team_lead' });
    expect(code(await h.client('10.5.0.5').post(`/api/auth/invites/${token}/accept`, { displayName: 'X', password: TEST_PASSWORD }))).toBe('INVITE_INVALID');
    const ev = await h.su.query("SELECT 1 FROM auth_events WHERE event = 'invite_accepted' AND tenant_id = $1", [owner.tenantId]);
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('a new user without a password gets PASSWORD_REQUIRED; an existing user must accept while signed in (LOGIN_REQUIRED)', async () => {
    const t1 = await h.inviteToken(owner, 'agent', 'nopw@example.test');
    expect(code(await h.client('10.5.0.6').post(`/api/auth/invites/${t1}/accept`, { displayName: 'No Pw' }))).toBe('PASSWORD_REQUIRED');
    const other = await h.signup();
    const t2 = await h.inviteToken(owner, 'agent', other.email);
    expect(code(await h.client('10.5.0.7').post(`/api/auth/invites/${t2}/accept`, {}))).toBe('LOGIN_REQUIRED');
    // signed in as that user: accepted, and the session moves to the new tenant (rotation)
    const before = other.cookie;
    const r = await other.post(`/api/auth/invites/${t2}/accept`, {});
    expect(r.statusCode).toBe(200);
    expect(other.cookie).not.toBe(before);
    expect(r.json().session.tenant.id).toBe(owner.tenantId);
    expect(r.json().session.tenants).toHaveLength(2);
  });

  it('an unknown, malformed or expired invite token is INVITE_INVALID (404)', async () => {
    const t = await h.inviteToken(owner, 'agent', 'late@example.test');
    await h.su.query("UPDATE invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE email = 'late@example.test'");
    const r = await h.client('10.5.0.8').post(`/api/auth/invites/${t}/accept`, { displayName: 'Late', password: TEST_PASSWORD });
    expect(r.statusCode).toBe(404);
    expect(code(r)).toBe('INVITE_INVALID');
    expect((await h.client('10.5.0.9').post('/api/auth/invites/not-a-real-token-at-all/accept', {})).statusCode).toBe(404);
  });
});

describe('tenant switch', () => {
  it('a member of two tenants switches by slug: the session rotates, the actor tenant changes, MFA verification carries over', async () => {
    const second = await h.signup();
    const token = await h.inviteToken(second, 'agent', owner.email);
    const c = await h.login(owner.email, TEST_PASSWORD, '10.5.1.1');
    c.totpSecret = owner.totpSecret;
    c.userId = owner.userId;
    await c.post('/api/auth/mfa/verify', { code: await c.totp() });
    expect((await c.post(`/api/auth/invites/${token}/accept`, {})).statusCode).toBe(200);
    const s1 = (await c.get('/api/auth/session')).json();
    expect(s1.tenant.id).toBe(second.tenantId);
    expect(s1.tenant.role).toBe('agent');
    const back = s1.tenants.find((t: { id: string }) => t.id === owner.tenantId).slug;
    const before = c.cookie;
    const r = await c.post('/api/auth/tenant-switch', { slug: back });
    expect(r.statusCode).toBe(200);
    expect(c.cookie).not.toBe(before);
    const s2 = r.json().session;
    expect(s2.tenant).toMatchObject({ id: owner.tenantId, role: 'owner' });
    expect(s2.mfa.verified).toBe(true);
    expect(r.json().next).toBe('ready');
    const stale = h.client();
    stale.cookie = before;
    expect((await stale.get('/api/auth/session')).statusCode).toBe(401);
    const rev = await h.su.query("SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_reason = 'tenant_switch'", [owner.userId]);
    expect(rev.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('switching to a tenant the user is not an active member of is 404 and leaves the session as it was', async () => {
    const stranger = await h.signup();
    const slug = (await stranger.get('/api/auth/session')).json().tenant.slug;
    const agent = await h.invite(owner, 'agent');
    const before = agent.cookie;
    const r = await agent.post('/api/auth/tenant-switch', { slug });
    expect(r.statusCode).toBe(404);
    expect(agent.cookie).toBe(before);
    expect((await agent.get('/api/auth/session')).json().tenant.id).toBe(owner.tenantId);
  });
});
