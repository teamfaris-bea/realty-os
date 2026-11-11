// Adversarial tests for api/integrations (critical module 21): tenancy, the routing key, the OAuth
// callback and the honest-status rules. Every attack goes through the real server or through app_user.
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { pkceChallenge } from '../providers/integrations/fakes.js';
import { callback, connectFlow, connectionRow, leadSource, startFlow } from './testing.js';

let h: ApiHarness;
let ownerA: TestClient;
let ownerB: TestClient;
let srcA: string;
let srcB: string;
let connA: string;

const credCount = async (tenantId: string) => Number((await h.su.query('SELECT count(*)::int AS n FROM provider_credentials WHERE tenant_id = $1', [tenantId])).rows[0].n);

beforeAll(async () => {
  h = await createApiHarness();
  ownerA = await h.signup();
  ownerB = await h.signup();
  srcA = await leadSource(h, ownerA.tenantId!);
  srcB = await leadSource(h, ownerB.tenantId!);
  const f = await connectFlow(h, ownerA, 'gbp_location', { externalAccountId: 'adv-loc-a' }, [{ id: 'adv-loc-a' }]);
  if (f.cb.result !== 'CONNECTED') throw new Error('fixture connect failed');
  connA = f.connectionId;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('tenant isolation', () => {
  it("tenant B never sees, renames, disconnects or reconnects tenant A's connection (404, never 403)", async () => {
    await freshReauth(h, ownerB);
    const v = (await call<{ services: { connections: { id: string }[] }[] }>(ownerB, 'GET', '/admin/integrations')).body;
    expect(v.services.flatMap((s) => s.connections).map((c) => c.id)).not.toContain(connA);
    expect((await call(ownerB, 'PATCH', `/admin/integrations/connections/${connA}`, { displayName: 'mine now' })).status).toBe(404);
    expect((await call(ownerB, 'POST', `/admin/integrations/connections/${connA}/disconnect`)).status).toBe(404);
    expect((await startFlow(ownerB, 'gbp_location', { connectionId: connA, externalAccountId: 'adv-loc-a' }, { reauth: h })).status).toBe(404);
    expect((await connectionRow(h, connA))!.status).toBe('connected');
  });

  it('R-TEN-3: no route accepts a tenant id; extra fields are 422', async () => {
    await freshReauth(h, ownerB);
    expect((await call(ownerB, 'POST', '/admin/integrations/messenger_page/connect', { externalAccountId: 'x', leadSourceId: srcB, tenantId: ownerA.tenantId })).status).toBe(422);
    expect((await call(ownerB, 'POST', '/admin/integrations/messenger_page/connect', { externalAccountId: 'x', leadSourceId: srcB, status: 'connected' })).status).toBe(422);
    expect((await call(ownerB, 'POST', '/admin/integrations/messenger_page/connect', { externalAccountId: 'x', leadSourceId: srcA })).status).toBe(404); // A's lead source is invisible
  });

  it('app_user without a tenant context sees no connection rows; only the definer resolves, and only to ids', async () => {
    const rows = await withPreTenant(async (tx) => (await sql`SELECT id FROM integration_connections`.execute(tx)).rows, { db: h.database });
    expect(rows).toEqual([]);
    const r = await withPreTenant(async (tx) => (await sql<Record<string, unknown>>`SELECT * FROM app.resolve_channel_account('gbp_location', 'adv-loc-a')`.execute(tx)).rows, { db: h.database });
    expect(r).toEqual([{ tenant_id: ownerA.tenantId, connection_id: connA }]);
    expect(Object.keys(r[0]!).sort()).toEqual(['connection_id', 'tenant_id']); // minimal columns, no credential, no payload
  });
});

describe('roles (DATA_MODEL §8: Owner/Admin only)', () => {
  it('Team Lead, Agent, ISA and TC get 404 on every integrations route', async () => {
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) {
      const c = await inviteViaApi(h, ownerA, role);
      await freshReauth(h, c);
      expect((await call(c, 'GET', '/admin/integrations')).status, role).toBe(404);
      expect((await call(c, 'POST', '/admin/integrations/messenger_page/connect', { externalAccountId: 'x', leadSourceId: srcA })).status, role).toBe(404);
      expect((await call(c, 'PATCH', `/admin/integrations/connections/${connA}`, { displayName: 'x' })).status, role).toBe(404);
      expect((await call(c, 'POST', `/admin/integrations/connections/${connA}/disconnect`)).status, role).toBe(404);
    }
    expect((await connectionRow(h, connA))!.status).toBe('connected');
  });
});

describe('the routing key is written only by the provider callback (R-INT-3, DB guard)', () => {
  it('an Owner writing external_account_id, credential_id, a live status or capabilities directly is refused by the 0018 trigger', async () => {
    const f = await startFlow(ownerA, 'instagram_account', { externalAccountId: 'adv-ig', leadSourceId: srcA }, { reauth: h });
    const attempt = (q: ReturnType<typeof sql>) => withTenantTx(ownerA.actor(), async (tx) => void (await q.execute(tx)), { db: h.database });
    await expect(attempt(sql`UPDATE integration_connections SET external_account_id = 'adv-ig' WHERE id = ${f.connectionId}`)).rejects.toThrow(/CONNECTION_PROOF_REQUIRED/);
    await expect(attempt(sql`UPDATE integration_connections SET status = 'connected', connected_at = now() WHERE id = ${f.connectionId}`)).rejects.toThrow(/CONNECTION_PROOF_REQUIRED/);
    await expect(attempt(sql`UPDATE integration_connections SET capabilities = '{"send_messages": true}' WHERE id = ${f.connectionId}`)).rejects.toThrow(/CONNECTION_CAPABILITIES_REPORTED/);
    await expect(attempt(sql`UPDATE integration_connections SET external_account_id = 'other' WHERE id = ${connA}`)).rejects.toThrow(/CONNECTION_ACCOUNT_IMMUTABLE/);
    await expect(
      attempt(sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, external_account_id) VALUES (app.tenant_id(), gen_random_uuid(), 'messenger_page', 'x', 'adv-page-z')`),
    ).rejects.toThrow(/CONNECTION_PROOF_REQUIRED/);
    expect(await connectionRow(h, f.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null, capabilities: {} });
  });
});

describe('OAuth callback attacks', () => {
  it('a forged state (tenant or connection swapped, MAC kept) or a state for another kind is refused and writes nothing', async () => {
    const f = await startFlow(ownerB, 'messenger_page', { externalAccountId: 'adv-page-b', leadSourceId: srcB }, { reauth: h });
    const [body, mac] = f.state.split('.') as [string, string];
    const j = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forge = (patch: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ ...j, ...patch })).toString('base64url')}.${mac}`;
    const code = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-page-a' }, { id: 'adv-page-b' }] });
    expect((await callback(h, 'messenger_page', { state: forge({ t: ownerA.tenantId, c: connA }), code })).result).toBe('STATE_INVALID');
    expect((await callback(h, 'messenger_page', { state: forge({ a: 'adv-page-a' }), code })).result).toBe('STATE_INVALID');
    expect((await callback(h, 'instagram_account', { state: f.state, code })).result).toBe('STATE_INVALID');
    expect((await callback(h, 'messenger_page', { code })).result).toBe('STATE_INVALID');
    expect((await callback(h, 'messenger_page', { state: 'x'.repeat(30) + '.' + 'y'.repeat(43), code })).result).toBe('STATE_INVALID');
    expect(await connectionRow(h, f.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null });
    expect(await connectionRow(h, connA)).toMatchObject({ status: 'connected', external_account_id: 'adv-loc-a' });
  });

  it('state replay: once a state has been used (success or refusal), it is STATE_STALE; no second credential is stored', async () => {
    const f = await connectFlow(h, ownerB, 'gbp_location', { externalAccountId: 'adv-loc-replay' }, [{ id: 'adv-loc-replay' }]);
    expect(f.cb.result).toBe('CONNECTED');
    const n = await credCount(ownerB.tenantId!);
    const code2 = h.providers.integrations.oauth.google.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-loc-replay' }] });
    expect((await callback(h, 'gbp_location', { state: f.state, code: code2 })).result).toBe('STATE_STALE');
    expect(await credCount(ownerB.tenantId!)).toBe(n);
  });

  it('two callbacks racing on one state: exactly one links, the other is refused by the fence', async () => {
    const f = await startFlow(ownerB, 'instagram_account', { externalAccountId: 'adv-race', leadSourceId: srcB }, { reauth: h });
    const c1 = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-race' }] });
    const c2 = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-race' }] });
    const before = await credCount(ownerB.tenantId!);
    const rs = await Promise.all([callback(h, 'instagram_account', { state: f.state, code: c1 }), callback(h, 'instagram_account', { state: f.state, code: c2 })]);
    expect(rs.map((r) => r.result).sort()).toEqual(['CONNECTED', 'STATE_STALE']);
    expect(await credCount(ownerB.tenantId!)).toBe(before + 1);
  });

  it("code injection: an attacker's own authorization code pasted into the victim's callback fails PKCE and links nothing", async () => {
    const victim = await startFlow(ownerB, 'messenger_page', { externalAccountId: 'adv-victim', leadSourceId: srcB }, { reauth: h });
    // the attacker completed a flow of their own (different verifier), holding a code for an account they manage
    const attackerCode = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: pkceChallenge('attacker-verifier'.padEnd(43, 'z')), accounts: [{ id: 'adv-victim' }] });
    expect((await callback(h, 'messenger_page', { state: victim.state, code: attackerCode })).result).toBe('PROVIDER_REFUSED');
    expect(await connectionRow(h, victim.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null });
  });

  it('an Owner/Admin demoted between start and callback cannot finish the connect', async () => {
    const adminB = await inviteViaApi(h, ownerB, 'admin');
    const f = await startFlow(adminB, 'messenger_page', { externalAccountId: 'adv-demoted', leadSourceId: srcB }, { reauth: h });
    const m = (await call<{ members: { userId: string; version: number }[] }>(ownerB, 'GET', '/members')).body.members.find((x) => x.userId === adminB.userId)!;
    await freshReauth(h, ownerB);
    expect((await call(ownerB, 'PATCH', `/members/${adminB.userId}`, { role: 'agent', version: m.version })).status).toBe(200);
    const code = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-demoted' }] });
    expect((await callback(h, 'messenger_page', { state: f.state, code })).result).toBe('STARTER_NOT_AUTHORIZED');
    expect((await connectionRow(h, f.connectionId))!.external_account_id).toBeNull();
  });

  it('an expired state is refused', async () => {
    const f = await startFlow(ownerB, 'messenger_page', { externalAccountId: 'adv-exp', leadSourceId: srcB }, { reauth: h });
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const code = h.providers.integrations.oauth.meta.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'adv-exp' }] });
      expect((await callback(h, 'messenger_page', { state: f.state, code })).result).toBe('STATE_EXPIRED');
    } finally {
      Date.now = realNow;
    }
  });

  it('the callback reflects no attacker-controlled URL: it always lands on the configured web origin', async () => {
    const r = await callback(h, 'messenger_page', { state: 'nope', code: 'x', redirect_uri: 'https://evil.example/steal' } as Record<string, string>);
    expect(r.status).toBe(303);
    expect(new URL(r.location).origin).toBe(new URL(h.config.webOrigins[0]!).origin);
  });
});
