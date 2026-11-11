// api/integrations through the real server and Postgres (R-INT-1..6, R-TEN-11, E134-E136, E160).
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { makeIntegrationHandlers } from './handlers.js';
import { callback, connectFlow, connectionRow, leadSource, startFlow } from './testing.js';

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;
let agent: TestClient;
let tl: TestClient;
let src: string;

interface View {
  adapterMode: string;
  services: { kind: string; connect: string; canConnect: boolean; sentence: string; connections: { id: string; status: string; statusSentence: string; capabilities: { name: string; available: boolean; reason: string | null }[] }[] }[];
  platformPacks: { key: string; reviewed: boolean; sentence: string }[];
}

async function list(c: TestClient = owner): Promise<View> {
  return (await call<View>(c, 'GET', '/admin/integrations')).body;
}

/** a status the provider health check would write (system actor; the 0018 guard refuses people) */
async function asSystemStatus(id: string, status: string): Promise<void> {
  await withTenantTx(systemActor(owner.tenantId!, 'provider'), async (tx) => void (await sql`UPDATE integration_connections SET status = ${status} WHERE id = ${id}`.execute(tx)), { db: h.database });
}

async function resolve(kind: string, account: string): Promise<{ tenant_id: string; connection_id: string }[]> {
  return withPreTenant(async (tx) => (await sql<{ tenant_id: string; connection_id: string }>`SELECT * FROM app.resolve_channel_account(${kind}, ${account})`.execute(tx)).rows, { db: h.database });
}

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
  agent = await inviteViaApi(h, owner, 'agent');
  tl = await inviteViaApi(h, owner, 'team_lead');
  src = await leadSource(h, owner.tenantId!);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('GET /admin/integrations: honest status for every service (R-INT-2, R-INT-6)', () => {
  it('lists every kind with a sentence; partner feeds and later phases cannot be connected; every platform pack says it awaits counsel', async () => {
    const v = await list();
    expect(v.adapterMode).toBe('fake');
    expect(v.services.map((s) => s.kind).sort()).toEqual(
      ['ads_google', 'ads_meta', 'gbp_location', 'instagram_account', 'lead_email', 'meta_lead_ads', 'messenger_page', 'mls_feed', 'realtor_feed', 'showing_service', 'web_chat_widget', 'zillow_feed'].sort(),
    );
    for (const s of v.services) expect(s.sentence.length).toBeGreaterThan(10);
    expect(v.services.filter((s) => s.canConnect).map((s) => s.kind).sort()).toEqual(['gbp_location', 'instagram_account', 'messenger_page']);
    expect(v.services.find((s) => s.kind === 'ads_meta')!.sentence).toMatch(/cannot be connected yet/);
    // D2: Meta Lead Ads (and any Meta messaging) is out of scope; the Page/Instagram rows are publishing-only
    expect(v.services.find((s) => s.kind === 'meta_lead_ads')).toMatchObject({ canConnect: false, sentence: 'Not offered: the owner has taken this out of scope.' });
    expect(v.services.find((s) => s.kind === 'zillow_feed')!.sentence).toMatch(/^Needs partner access|Demo data only/);
    expect((v as unknown as { perUser: { key: string }[] }).perUser.map((x) => x.key)).toEqual(['google_calendar', 'microsoft_calendar']);
    expect(v.platformPacks.map((p) => p.key)).toEqual(
      ['platform:avm', 'platform:coaching', 'platform:fair_housing', 'platform:meta', 'platform:portal', 'platform:review_requests', 'platform:voice'],
    );
    for (const p of v.platformPacks) {
      expect(p.reviewed).toBe(false);
      expect(p.sentence).toMatch(/awaiting counsel review/);
    }
  });

  it('DATA_MODEL §8: Owner and Admin read it; Team Lead and Agent get 404', async () => {
    expect((await call(admin, 'GET', '/admin/integrations')).status).toBe(200);
    expect((await call(agent, 'GET', '/admin/integrations')).status).toBe(404);
    expect((await call(tl, 'GET', '/admin/integrations')).status).toBe(404);
  });
});

describe('connect through the provider callback (R-INT-3)', () => {
  it('R-PERM-13: starting a connect is 🔒 (re-auth) and Owner/Admin only', async () => {
    await staleReauth(h, owner);
    expect((await startFlow(owner, 'messenger_page', { externalAccountId: 'page-x', leadSourceId: src })).code).toBe('REAUTH_REQUIRED');
    expect((await startFlow(agent, 'messenger_page', { externalAccountId: 'page-x', leadSourceId: src })).status).toBe(404);
  });

  it('R-INT-3: the callback proves control, links the account, stores the encrypted credential and what the adapter reported; audited as the system', async () => {
    const f = await connectFlow(h, owner, 'messenger_page', { externalAccountId: 'page-100', leadSourceId: src, displayName: 'Harbor Page' }, [{ id: 'page-100', name: 'Harbor' }, { id: 'page-101' }]);
    expect(f.cb).toMatchObject({ status: 303, result: 'CONNECTED', connection: f.connectionId });
    expect(f.cb.location.startsWith(`${h.config.webOrigins[0]}/admin/integrations?`)).toBe(true);
    const row = (await connectionRow(h, f.connectionId))!;
    expect(row).toMatchObject({ status: 'connected', external_account_id: 'page-100', capabilities: { publish_posts: true } });
    const cred = (await h.su.query('SELECT provider, status, external_account_ref, secret_enc FROM provider_credentials WHERE id = $1', [row.credential_id])).rows[0];
    expect(cred).toMatchObject({ provider: 'meta', status: 'active', external_account_ref: 'page-100' });
    expect(Buffer.from(cred.secret_enc).toString('utf8')).not.toContain('fake-token'); // encrypted, never plaintext
    const a = (await auditRows(h, owner.tenantId!, 'integration.connected'))[0]!;
    expect(a).toMatchObject({ actor_user_id: null, reason: 'PROVIDER_CALLBACK_PROVED_CONTROL' });
    // D2: a Page connection is publishing-only, so no inbound route exists for it
    expect(await resolve('messenger_page', 'page-100')).toEqual([]);

    // capability offered only as reported; publishing waits for platform:fair_housing (R-INT-6)
    const conn = (await list()).services.find((s) => s.kind === 'messenger_page')!.connections.find((c) => c.id === f.connectionId)!;
    expect(conn.capabilities).toEqual([{ name: 'publish_posts', available: false, reason: 'Waits for counsel review of platform:fair_housing.' }]);
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:fair_housing' AND status = 'published'");
    try {
      const after = (await list()).services.find((s) => s.kind === 'messenger_page')!.connections.find((c) => c.id === f.connectionId)!;
      expect(after.capabilities).toEqual([{ name: 'publish_posts', available: true, reason: null }]);
      expect((await list()).platformPacks.find((p) => p.key === 'platform:fair_housing')).toMatchObject({ reviewed: true });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:fair_housing' AND status = 'published'");
    }
  });

  it('E160: a Page the token does not manage is refused; nothing is linked; the row stays unconfigured; the token is revoked', async () => {
    const f = await connectFlow(h, owner, 'messenger_page', { externalAccountId: 'page-not-mine', leadSourceId: src }, [{ id: 'page-other' }]);
    expect(f.cb.result).toBe('ACCOUNT_NOT_MANAGED');
    expect(await connectionRow(h, f.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null, credential_id: null, capabilities: {}, last_error_code: 'ACCOUNT_NOT_MANAGED' });
    expect(h.providers.integrations.oauth.meta.revoked.length).toBeGreaterThan(0);
    expect((await auditRows(h, owner.tenantId!, 'integration.connect_refused')).at(-1)).toMatchObject({ reason: 'ACCOUNT_NOT_MANAGED' });
    expect(await resolve('messenger_page', 'page-not-mine')).toEqual([]);
  });

  it('a platform still reviewing the account ends in pending_review: reserved, but routes nothing (R-TEN-11)', async () => {
    const f = await connectFlow(h, owner, 'instagram_account', { externalAccountId: 'ig-200', leadSourceId: src }, [{ id: 'ig-200', reviewPending: true }]);
    expect(f.cb.result).toBe('PENDING_REVIEW');
    expect((await connectionRow(h, f.connectionId))!.status).toBe('pending_review');
    expect(await resolve('instagram_account', 'ig-200')).toEqual([]);
    const conn = (await list()).services.find((s) => s.kind === 'instagram_account')!.connections.find((c) => c.id === f.connectionId)!;
    expect(conn.statusSentence).toMatch(/nothing is sent or received yet/);
    expect(conn.capabilities.every((c) => !c.available)).toBe(true);
  });

  it('D2: the Meta connect asks for publishing scopes only (never messaging or Lead Ads); Google Business Profile asks for its management scope', async () => {
    const { FORBIDDEN_SCOPES, META_PUBLISH_SCOPES, GOOGLE_GBP_SCOPES } = await import('./catalog.js');
    const fb = await startFlow(owner, 'messenger_page', { externalAccountId: 'page-scope', leadSourceId: src }, { reauth: h });
    const ig = await startFlow(owner, 'instagram_account', { externalAccountId: 'ig-scope', leadSourceId: src }, { reauth: h });
    const gb = await startFlow(owner, 'gbp_location', { externalAccountId: 'loc-scope' }, { reauth: h });
    const scopes = (u: string) => new URL(u).searchParams.get('scope')!.split(' ');
    expect(scopes(fb.authorizeUrl)).toEqual([...META_PUBLISH_SCOPES.facebook_page]);
    expect(scopes(ig.authorizeUrl)).toEqual([...META_PUBLISH_SCOPES.instagram_account]);
    expect(scopes(gb.authorizeUrl)).toEqual([...GOOGLE_GBP_SCOPES]);
    for (const u of [fb, ig, gb]) for (const f of FORBIDDEN_SCOPES) expect(scopes(u.authorizeUrl)).not.toContain(f);
  });

  it('an inbound channel needs a lead source before it can go live (0018 CHECK, checked first by the API)', async () => {
    expect((await startFlow(owner, 'messenger_page', { externalAccountId: 'page-nosrc' }, { reauth: h })).code).toBe('LEAD_SOURCE_REQUIRED');
  });

  it('partner and later kinds are not connectable; unknown kinds too', async () => {
    for (const kind of ['zillow_feed', 'mls_feed', 'web_chat_widget', 'ads_meta', 'meta_lead_ads', 'bogus']) {
      expect((await startFlow(owner, kind, { externalAccountId: 'x' }, { reauth: h })).code).toBe('INTEGRATION_NOT_CONNECTABLE');
    }
  });

  it('the user cancelling at the provider links nothing and burns the state', async () => {
    const f = await startFlow(owner, 'gbp_location', { externalAccountId: 'loc-cancel' }, { reauth: h });
    expect((await callback(h, 'gbp_location', { state: f.state, error: 'access_denied' })).result).toBe('CANCELLED');
    expect((await connectionRow(h, f.connectionId))!.status).toBe('not_configured');
    const code = h.providers.integrations.oauth.google.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'loc-cancel' }] });
    expect((await callback(h, 'gbp_location', { state: f.state, code })).result).toBe('STATE_STALE');
  });

  it('a provider outage at the exchange is reported honestly and links nothing', async () => {
    const f = await startFlow(owner, 'gbp_location', { externalAccountId: 'loc-outage' }, { reauth: h });
    const { ProviderError } = await import('../providers/types.js');
    h.providers.integrations.oauth.google.failNextExchange = new ProviderError('unavailable');
    const code = h.providers.integrations.oauth.google.issueCode({ codeChallenge: f.challenge, accounts: [{ id: 'loc-outage' }] });
    expect((await callback(h, 'gbp_location', { state: f.state, code })).result).toBe('PROVIDER_REFUSED');
    expect((await connectionRow(h, f.connectionId))!.status).toBe('not_configured');
  });
});

describe('one external account is live in one tenant (R-INT-3, E135)', () => {
  it('E135: tenant B cannot take an account live in tenant A; once A disconnects, B connects it through the callback', async () => {
    const a = await connectFlow(h, owner, 'gbp_location', { externalAccountId: 'loc-shared' }, [{ id: 'loc-shared' }]);
    expect(a.cb.result).toBe('CONNECTED');
    const ownerB = await h.signup();
    const b = await connectFlow(h, ownerB, 'gbp_location', { externalAccountId: 'loc-shared' }, [{ id: 'loc-shared' }]);
    expect(b.cb.result).toBe('ACCOUNT_LIVE_ELSEWHERE');
    expect(await connectionRow(h, b.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null, last_error_code: 'ACCOUNT_LIVE_ELSEWHERE' });
    expect(await resolve('gbp_location', 'loc-shared')).toEqual([{ tenant_id: owner.tenantId, connection_id: a.connectionId }]);

    await freshReauth(h, owner);
    expect((await call(owner, 'POST', `/admin/integrations/connections/${a.connectionId}/disconnect`)).status).toBe(200);
    expect(await resolve('gbp_location', 'loc-shared')).toEqual([]); // E134: nothing routes meanwhile
    const b2 = await connectFlow(h, ownerB, 'gbp_location', { connectionId: b.connectionId, externalAccountId: 'loc-shared' }, [{ id: 'loc-shared' }]);
    expect(b2.cb.result).toBe('CONNECTED');
    expect(await resolve('gbp_location', 'loc-shared')).toEqual([{ tenant_id: ownerB.tenantId, connection_id: b.connectionId }]);
  });
});

describe('disconnect revokes the credential in the same transaction (R-INT-5)', () => {
  it('R-INT-5: disconnected + credential revoked atomically, a revoke job queued; the job revokes at the provider and purges the secret', async () => {
    const f = await connectFlow(h, owner, 'messenger_page', { externalAccountId: 'page-dis', leadSourceId: src }, [{ id: 'page-dis' }]);
    const row = (await connectionRow(h, f.connectionId))!;
    await staleReauth(h, admin);
    expect((await call(admin, 'POST', `/admin/integrations/connections/${f.connectionId}/disconnect`)).code).toBe('REAUTH_REQUIRED');
    await freshReauth(h, admin);
    const r = await call<{ connection: { status: string; statusSentence: string } }>(admin, 'POST', `/admin/integrations/connections/${f.connectionId}/disconnect`);
    expect(r.status).toBe(200);
    expect(r.body.connection.status).toBe('disconnected');
    expect(r.body.connection.statusSentence).toMatch(/^Disconnected on \d{4}-\d{2}-\d{2}\. Nothing is sent or received\.$/);
    const cred = (await h.su.query('SELECT status, purge_after > now() + interval \'29 days\' AS within30, secret_enc IS NOT NULL AS has FROM provider_credentials WHERE id = $1', [row.credential_id])).rows[0];
    expect(cred).toEqual({ status: 'revoked', within30: true, has: true });
    const job = (await h.su.query("SELECT payload FROM jobs WHERE tenant_id = $1 AND kind = 'integrations.revoke_grant' ORDER BY id DESC LIMIT 1", [owner.tenantId])).rows[0];
    expect(job.payload).toEqual({ credentialId: row.credential_id });

    // run the job as the worker would (one system transaction)
    const [handler] = makeIntegrationHandlers(() => h.app.platform.envelope);
    const before = h.providers.integrations.oauth.meta.revoked.length;
    await withTenantTx(
      systemActor(owner.tenantId!, 'provider'),
      async (tx, now) => {
        await (handler as { run: (ctx: unknown, p: unknown) => Promise<void> }).run(
          { tx, now, actor: systemActor(owner.tenantId!, 'provider'), providers: h.providers, job: { id: 1n, kind: 'integrations.revoke_grant', queue: 'default', attempts: 1 }, log: { info() {}, warn() {}, error() {} }, alerts: {} },
          { credentialId: row.credential_id },
        );
      },
      { db: h.database },
    );
    expect(h.providers.integrations.oauth.meta.revoked.length).toBe(before + 1);
    expect((await h.su.query('SELECT status, secret_enc FROM provider_credentials WHERE id = $1', [row.credential_id])).rows[0]).toEqual({ status: 'purged', secret_enc: null });
    expect((await auditRows(h, owner.tenantId!, 'integration.disconnected')).at(-1)).toMatchObject({ actor_user_id: admin.userId, reason: 'DISCONNECTED' });
    // idempotent; a disconnected row cannot be reconnected (a reconnect is a new row, E134)
    expect((await call(admin, 'POST', `/admin/integrations/connections/${f.connectionId}/disconnect`)).status).toBe(200);
    expect((await startFlow(owner, 'messenger_page', { connectionId: f.connectionId, externalAccountId: 'page-dis' }, { reauth: h })).code).toBe('CONNECTION_NOT_CONNECTABLE');
    const again = await connectFlow(h, owner, 'messenger_page', { externalAccountId: 'page-dis', leadSourceId: src }, [{ id: 'page-dis' }]);
    expect(again.cb.result).toBe('CONNECTED');
  });

  it('rename is audited; status, account and capabilities are not accepted from people (strict body)', async () => {
    const f = await startFlow(owner, 'gbp_location', { externalAccountId: 'loc-r' }, { reauth: h });
    const r = await call<{ connection: { displayName: string } }>(owner, 'PATCH', `/admin/integrations/connections/${f.connectionId}`, { displayName: 'Lead forms' });
    expect(r.status).toBe(200);
    expect(r.body.connection.displayName).toBe('Lead forms');
    for (const extra of [{ status: 'connected' }, { externalAccountId: 'x' }, { capabilities: { send_messages: true } }, { tenantId: owner.tenantId }]) {
      expect((await call(owner, 'PATCH', `/admin/integrations/connections/${f.connectionId}`, extra)).status).toBe(422);
    }
    expect((await auditRows(h, owner.tenantId!, 'integration.changed')).at(-1)!.changes).toHaveProperty('display_name');
  });
});

describe('app.resolve_channel_account (R-TEN-11, E136)', () => {
  it('E136: only connected/degraded connections route; every other status, keyed kinds and unknown accounts resolve to nothing', async () => {
    const f = await connectFlow(h, owner, 'gbp_location', { externalAccountId: 'loc-route' }, [{ id: 'loc-route' }]);
    expect(await resolve('gbp_location', 'loc-route')).toHaveLength(1);
    await asSystemStatus(f.connectionId, 'degraded');
    expect(await resolve('gbp_location', 'loc-route')).toHaveLength(1);
    await asSystemStatus(f.connectionId, 'revoked');
    expect(await resolve('gbp_location', 'loc-route')).toEqual([]);
    expect(await resolve('ads_google', 'loc-route')).toEqual([]); // kind is part of the key
    expect(await resolve('gbp_location', 'nobody')).toEqual([]);
    expect(await resolve('web_chat_widget', 'loc-route')).toEqual([]);
    // a suspended tenant routes nothing
    await asSystemStatus(f.connectionId, 'connected');
    const st = (await h.su.query('SELECT status FROM tenants WHERE id = $1', [owner.tenantId])).rows[0].status;
    await h.su.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [owner.tenantId]);
    try {
      expect(await resolve('gbp_location', 'loc-route')).toEqual([]);
    } finally {
      await h.su.query('UPDATE tenants SET status = $2 WHERE id = $1', [owner.tenantId, st]);
    }
  });

  it('security review: owned by app_definer, SECURITY DEFINER, pinned search_path, STABLE, executable by app_user and not by PUBLIC', async () => {
    const r = (
      await h.su.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
                               has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
                               p.proacl::text AS acl
                          FROM pg_proc p WHERE p.oid = 'app.resolve_channel_account(text,text)'::regprocedure`)
    ).rows[0];
    expect(r).toMatchObject({ owner: 'app_definer', prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public'], app_user_exec: true });
    expect(r.acl).not.toMatch(/(^|[{,])=X/);
  });
});
