// api/integrations through the real server and Postgres (R-INT-1..6, R-TEN-11, E134-E136, E160).
// Owner decision D2: Meta connects only the 0025 publishing kinds facebook_page / instagram_business; the
// 0018 kinds messenger_page, instagram_account, meta_lead_ads and ads_meta are listed as not offered.
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { CONNECTION_KINDS } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { FORBIDDEN_SCOPES, GOOGLE_ADS_SCOPES, GOOGLE_GBP_SCOPES, META_PUBLISH_SCOPES, NEVER_CLEARED_PACKS, OUT_OF_SCOPE_KINDS, SERVICES, VENDOR_CHECKED_PACKS } from './catalog.js';
import { makeIntegrationHandlers } from './handlers.js';
import { type OAuthState, pkceChallengeOf, pkceVerifier, signState } from './oauthState.js';
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
  it('lists every kind with a sentence; partner feeds and later phases cannot be connected; D2 out-of-scope kinds say they are not offered; every platform pack ships unreviewed and says it awaits counsel, except platform:meta, which says it is never cleared (D2)', async () => {
    const v = await list();
    expect(v.adapterMode).toBe('fake');
    expect(v.services.map((s) => s.kind).sort()).toEqual(
      ['ads_google', 'ads_meta', 'facebook_page', 'gbp_location', 'instagram_account', 'instagram_business', 'lead_email', 'meta_lead_ads', 'messenger_page', 'mls_feed', 'realtor_feed', 'showing_service', 'web_chat_widget', 'zillow_feed'].sort(),
    );
    for (const s of v.services) expect(s.sentence.length).toBeGreaterThan(10);
    expect(v.services.filter((s) => s.canConnect).map((s) => s.kind).sort()).toEqual(['ads_google', 'facebook_page', 'gbp_location', 'instagram_business']);
    expect(v.services.find((s) => s.kind === 'ads_google')!.sentence).toBe('Test adapter: connects to a simulated account only.'); // D2: ads are Google Ads only (module 52)
    // D2: Messenger and Instagram DMs, Meta Lead Ads and Meta ads are out of scope; Meta connects for publishing only
    for (const kind of ['messenger_page', 'instagram_account', 'meta_lead_ads', 'ads_meta']) {
      expect(v.services.find((s) => s.kind === kind), kind).toMatchObject({ connect: 'out_of_scope', canConnect: false, sentence: 'Not offered: the owner has taken this out of scope.' });
    }
    expect(v.services.find((s) => s.kind === 'zillow_feed')!.sentence).toMatch(/^Needs partner access|Demo data only/);
    expect((v as unknown as { perUser: { key: string }[] }).perUser.map((x) => x.key)).toEqual(['google_calendar', 'microsoft_calendar']);
    // D2 (migration 0025) adds platform:gmail and module 52 adds platform:ads, unreviewed like the rest
    expect(v.platformPacks.map((p) => p.key)).toEqual(
      ['platform:ads', 'platform:avm', 'platform:coaching', 'platform:fair_housing', 'platform:gmail', 'platform:meta', 'platform:portal', 'platform:review_requests', 'platform:voice'],
    );
    for (const p of v.platformPacks) {
      expect(p.reviewed, p.key).toBe(false);
      expect(p.sentence, p.key).toMatch(p.key === 'platform:meta' ? /: not offered \(owner decision D2\); nothing waits on this pack and it is never cleared / : / stays off: awaiting counsel review/);
    }
  });

  it('the kinds the API knows and lists are exactly the integration_connections kind CHECK (0018, widened by 0025)', async () => {
    const def = (await h.su.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'integration_connections'::regclass AND conname = 'integration_connections_kind_check'")).rows[0]!.d;
    expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...CONNECTION_KINDS].sort());
    expect(SERVICES.map((s) => s.kind).sort()).toEqual([...CONNECTION_KINDS].sort());
  });

  it('R-INT-6: platform:gmail (D2) and platform:voice say "cleared" exactly when the database clears them: counsel review AND the vendor check (rules.vendor_ready_at)', async () => {
    const pack = async (key: string) => (await list()).platformPacks.find((p) => p.key === key)!;
    const dbCleared = async (key: string) => (await h.su.query<{ c: boolean }>('SELECT app.platform_cleared($1, true) AS c', [key])).rows[0]!.c;
    expect(await pack('platform:gmail')).toMatchObject({ reviewed: false, sentence: expect.stringMatching(/^Gmail inbox sync stays off: awaiting counsel review and the vendor check \(pack \S+, not yet reviewed\)\.$/) });
    const states = [
      { reviewed: false, vendor: false, cleared: false, sentence: / stays off: awaiting counsel review and the vendor check \(pack \S+, not yet reviewed\)\.$/ },
      { reviewed: false, vendor: true, cleared: false, sentence: / stays off: awaiting counsel review \(pack \S+, not yet reviewed\)\.$/ },
      { reviewed: true, vendor: false, cleared: false, sentence: / stays off: counsel reviewed it on \d{4}-\d{2}-\d{2}; it also waits for the vendor check \(pack \S+\)\.$/ },
      { reviewed: true, vendor: true, cleared: true, sentence: /: cleared by counsel on \d{4}-\d{2}-\d{2} \(pack \S+\)\.$/ },
    ];
    try {
      for (const s of states) {
        await h.su.query(
          `UPDATE jurisdiction_packs SET reviewed_by_counsel_at = CASE WHEN $2::boolean THEN now() END,
                  rules = CASE WHEN $3::boolean THEN rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' ELSE rules - 'vendor_ready_at' END
            WHERE key = ANY($1::text[]) AND status = 'published'`,
          [[...VENDOR_CHECKED_PACKS], s.reviewed, s.vendor],
        );
        for (const key of VENDOR_CHECKED_PACKS) {
          const p = await pack(key);
          const at = `${key} reviewed=${s.reviewed} vendor=${s.vendor}`;
          expect(await dbCleared(key), at).toBe(s.cleared);
          expect(p.reviewed, at).toBe(s.reviewed);
          expect(p.sentence, at).toMatch(s.sentence);
          expect(/cleared/.test(p.sentence), at).toBe(s.cleared); // never "cleared" while the database still refuses
        }
      }
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL, rules = rules - 'vendor_ready_at' WHERE key = ANY($1::text[]) AND status = 'published'", [[...VENDOR_CHECKED_PACKS]]);
    }
  });

  it('the packs the API treats as vendor-checked are exactly those the database clears with app.platform_cleared(key, true) (0018 voice, 0025 Gmail, module 52 ads)', async () => {
    const calls = String.raw`platform_cleared\('(platform:[a-z_]+)',\s*true\)`;
    const keys = (await h.su.query<{ key: string }>("SELECT DISTINCT m[1] AS key FROM pg_proc p CROSS JOIN LATERAL regexp_matches(p.prosrc, $1, 'g') AS m", [calls])).rows.map((r) => r.key);
    expect(keys.sort()).toEqual([...VENDOR_CHECKED_PACKS].sort());
  });

  it('R-INT-6 D2: platform:meta is never cleared: the page says Meta messaging is not offered and never asks for its review, even if the pack were marked reviewed', async () => {
    expect([...NEVER_CLEARED_PACKS]).toEqual(['platform:meta']);
    const meta = async () => (await list()).platformPacks.find((p) => p.key === 'platform:meta')!;
    expect(await meta()).toMatchObject({ reviewed: false, sentence: expect.stringMatching(/^Meta messaging: not offered \(owner decision D2\); nothing waits on this pack and it is never cleared \(pack \S+\)\.$/) });
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:meta' AND status = 'published'");
    try {
      const p = await meta();
      expect(p.sentence).toMatch(/^Meta messaging: not offered \(owner decision D2\); the pack was marked reviewed on \d{4}-\d{2}-\d{2}, but Meta messaging stays out of scope \(pack \S+\)\.$/);
      expect(p.sentence).not.toMatch(/awaiting|cleared by/);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:meta' AND status = 'published'");
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
    expect((await startFlow(owner, 'facebook_page', { externalAccountId: 'page-x' })).code).toBe('REAUTH_REQUIRED');
    expect((await startFlow(agent, 'facebook_page', { externalAccountId: 'page-x' })).status).toBe(404);
  });

  it('R-INT-3: the callback proves control, links the account, stores the encrypted credential and what the adapter reported; audited as the system', async () => {
    const f = await connectFlow(h, owner, 'facebook_page', { externalAccountId: 'page-100', displayName: 'Harbor Page' }, [{ id: 'page-100', name: 'Harbor' }, { id: 'page-101' }]);
    expect(f.cb).toMatchObject({ status: 303, result: 'CONNECTED', connection: f.connectionId });
    expect(f.cb.location.startsWith(`${h.config.webOrigins[0]}/admin/integrations?`)).toBe(true);
    const row = (await connectionRow(h, f.connectionId))!;
    expect(row).toMatchObject({ status: 'connected', external_account_id: 'page-100', capabilities: { publish_posts: true }, lead_source_id: null });
    const cred = (await h.su.query('SELECT provider, status, external_account_ref, secret_enc FROM provider_credentials WHERE id = $1', [row.credential_id])).rows[0];
    expect(cred).toMatchObject({ provider: 'meta', status: 'active', external_account_ref: 'page-100' });
    expect(Buffer.from(cred.secret_enc).toString('utf8')).not.toContain('fake-token'); // encrypted, never plaintext
    const a = (await auditRows(h, owner.tenantId!, 'integration.connected'))[0]!;
    expect(a).toMatchObject({ actor_user_id: null, reason: 'PROVIDER_CALLBACK_PROVED_CONTROL' });
    // D2: a Page connection is publishing-only, so no inbound route exists for it (E228: nothing is received)
    expect(await resolve('facebook_page', 'page-100')).toEqual([]);

    // capability offered only as reported; publishing waits for platform:fair_housing (R-INT-6), for a Page and
    // for an Instagram business account alike
    const ig = await connectFlow(h, owner, 'instagram_business', { externalAccountId: 'ig-100', displayName: 'Harbor Instagram' }, [{ id: 'ig-100' }]);
    expect(ig.cb.result).toBe('CONNECTED');
    const caps = async (kind: string, id: string) => (await list()).services.find((s) => s.kind === kind)!.connections.find((c) => c.id === id)!.capabilities;
    const publishing = [['facebook_page', f.connectionId], ['instagram_business', ig.connectionId]] as const;
    for (const [kind, id] of publishing) expect(await caps(kind, id), kind).toEqual([{ name: 'publish_posts', available: false, reason: 'Waits for counsel review of platform:fair_housing.' }]);
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:fair_housing' AND status = 'published'");
    try {
      for (const [kind, id] of publishing) expect(await caps(kind, id), kind).toEqual([{ name: 'publish_posts', available: true, reason: null }]);
      expect((await list()).platformPacks.find((p) => p.key === 'platform:fair_housing')).toMatchObject({ reviewed: true });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:fair_housing' AND status = 'published'");
    }
  });

  it('E160: a Page the token does not manage is refused; nothing is linked; the row stays unconfigured; the token is revoked', async () => {
    const f = await connectFlow(h, owner, 'facebook_page', { externalAccountId: 'page-not-mine' }, [{ id: 'page-other' }]);
    expect(f.cb.result).toBe('ACCOUNT_NOT_MANAGED');
    expect(await connectionRow(h, f.connectionId)).toMatchObject({ status: 'not_configured', external_account_id: null, credential_id: null, capabilities: {}, last_error_code: 'ACCOUNT_NOT_MANAGED' });
    expect(h.providers.integrations.oauth.meta.revoked.length).toBeGreaterThan(0);
    expect((await auditRows(h, owner.tenantId!, 'integration.connect_refused')).at(-1)).toMatchObject({ reason: 'ACCOUNT_NOT_MANAGED' });
    expect(await resolve('facebook_page', 'page-not-mine')).toEqual([]);
  });

  it('a platform still reviewing the account ends in pending_review: reserved, but routes nothing (R-TEN-11)', async () => {
    const f = await connectFlow(h, owner, 'instagram_business', { externalAccountId: 'ig-200' }, [{ id: 'ig-200', reviewPending: true }]);
    expect(f.cb.result).toBe('PENDING_REVIEW');
    expect((await connectionRow(h, f.connectionId))!.status).toBe('pending_review');
    expect(await resolve('instagram_business', 'ig-200')).toEqual([]);
    const conn = (await list()).services.find((s) => s.kind === 'instagram_business')!.connections.find((c) => c.id === f.connectionId)!;
    expect(conn.statusSentence).toMatch(/nothing is sent or received yet/);
    expect(conn.capabilities.every((c) => !c.available)).toBe(true);
  });

  it('R-MKT-12 D2: the Meta connect asks for publishing scopes only (no FORBIDDEN_SCOPES for facebook_page or instagram_business, never messaging or Lead Ads); Google Business Profile asks for its management scope', async () => {
    const fb = await startFlow(owner, 'facebook_page', { externalAccountId: 'page-scope' }, { reauth: h });
    const ig = await startFlow(owner, 'instagram_business', { externalAccountId: 'ig-scope' }, { reauth: h });
    const gb = await startFlow(owner, 'gbp_location', { externalAccountId: 'loc-scope' }, { reauth: h });
    const scopes = (u: string) => new URL(u).searchParams.get('scope')!.split(' ');
    expect(scopes(fb.authorizeUrl)).toEqual([...META_PUBLISH_SCOPES.facebook_page]);
    expect(scopes(ig.authorizeUrl)).toEqual([...META_PUBLISH_SCOPES.instagram_business]);
    expect(scopes(gb.authorizeUrl)).toEqual([...GOOGLE_GBP_SCOPES]);
    for (const u of [fb, ig, gb]) for (const f of FORBIDDEN_SCOPES) expect(scopes(u.authorizeUrl)).not.toContain(f);
    // the catalog itself: no service, and no Meta publishing kind, can ever ask for a forbidden scope
    for (const s of SERVICES) for (const f of FORBIDDEN_SCOPES) expect(s.scopes ?? [], s.kind).not.toContain(f);
    for (const kind of ['facebook_page', 'instagram_business'] as const) for (const f of FORBIDDEN_SCOPES) expect(META_PUBLISH_SCOPES[kind], kind).not.toContain(f);
    // FORBIDDEN_SCOPES lists the names we know (VERIFY); a messaging, Lead Ads or webhook permission under any other
    // name is refused too: no Meta scope, in the catalog or in an authorize URL, matches the pattern
    const notPublishing = /messag|leads_retrieval|manage_metadata/i;
    for (const f of FORBIDDEN_SCOPES) expect(f).toMatch(notPublishing);
    const metaScopes = [...Object.values(META_PUBLISH_SCOPES).flat(), ...SERVICES.filter((s) => s.oauthProvider === 'meta').flatMap((s) => s.scopes ?? []), ...scopes(fb.authorizeUrl), ...scopes(ig.authorizeUrl)];
    expect(metaScopes.length).toBeGreaterThan(0);
    expect(metaScopes.filter((s) => notPublishing.test(s))).toEqual([]);
  });

  it('R-ADS-13: the Google Ads connect asks for exactly GOOGLE_ADS_SCOPES and completes on the fake provider; reading spend works at once, changing budgets waits for counsel review and then for the vendor check of platform:ads', async () => {
    expect([...GOOGLE_ADS_SCOPES]).toEqual(['https://www.googleapis.com/auth/adwords']);
    expect(SERVICES.find((s) => s.kind === 'ads_google')).toMatchObject({ connect: 'oauth', oauthProvider: 'google', needsLeadSource: false, usedBy: 'Google Ads budget proposals and spend', scopes: GOOGLE_ADS_SCOPES });
    const f = await connectFlow(h, owner, 'ads_google', { externalAccountId: 'fake-ads-scope', leadSourceId: src }, [{ id: 'fake-ads-scope' }]);
    expect(new URL(f.authorizeUrl).searchParams.get('scope')!.split(' ')).toEqual([...GOOGLE_ADS_SCOPES]);
    expect(f.cb.result).toBe('CONNECTED');
    expect(await connectionRow(h, f.connectionId)).toMatchObject({ status: 'connected', external_account_id: 'fake-ads-scope', lead_source_id: src });
    const caps = async () => (await list()).services.find((s) => s.kind === 'ads_google')!.connections.find((c) => c.id === f.connectionId)!.capabilities;
    expect(await caps()).toEqual([
      { name: 'change_budget', available: false, reason: 'Waits for counsel review of platform:ads.' },
      { name: 'read_spend', available: true, reason: null },
    ]);
    try {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ads' AND status = 'published'");
      expect((await caps())[0]).toEqual({ name: 'change_budget', available: false, reason: 'Waits for the vendor check of platform:ads.' });
      await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' WHERE key = 'platform:ads' AND status = 'published'`);
      expect((await caps())[0]).toEqual({ name: 'change_budget', available: true, reason: null });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL, rules = rules - 'vendor_ready_at' WHERE key = 'platform:ads' AND status = 'published'");
    }
  });

  it('R-INT-3 D2: a publishing kind never takes a lead source: the API refuses one on connect and on rename, and the 0025 CHECK refuses a direct write', async () => {
    // DATA_MODEL §6.3; 0025 CHECK integration_connections_publishing_no_source (E228, R-MKT-12)
    // D2: a publishing-only account is never an inbound channel, so its connect needs no lead source
    const fb = await startFlow(owner, 'facebook_page', { externalAccountId: 'page-nosrc' }, { reauth: h });
    expect(fb.status).toBe(201);
    for (const kind of ['facebook_page', 'instagram_business']) {
      expect((await startFlow(owner, kind, { externalAccountId: `${kind}-src`, leadSourceId: src }, { reauth: h })).code, kind).toBe('LEAD_SOURCE_NOT_ALLOWED');
    }
    expect((await startFlow(owner, 'facebook_page', { connectionId: fb.connectionId, externalAccountId: 'page-nosrc', leadSourceId: src }, { reauth: h })).code).toBe('LEAD_SOURCE_NOT_ALLOWED');
    await freshReauth(h, owner);
    expect((await call(owner, 'PATCH', `/admin/integrations/connections/${fb.connectionId}`, { leadSourceId: src })).code).toBe('LEAD_SOURCE_NOT_ALLOWED');
    expect((await call(owner, 'PATCH', `/admin/integrations/connections/${fb.connectionId}`, { displayName: 'Harbor posts', leadSourceId: null })).status).toBe(200);
    expect(await connectionRow(h, fb.connectionId)).toMatchObject({ status: 'not_configured', lead_source_id: null });
    const ig = await connectFlow(h, owner, 'instagram_business', { externalAccountId: 'ig-nosrc' }, [{ id: 'ig-nosrc' }]);
    expect(ig.cb.result).toBe('CONNECTED');
    await freshReauth(h, owner);
    expect((await call(owner, 'PATCH', `/admin/integrations/connections/${ig.connectionId}`, { leadSourceId: src })).code).toBe('LEAD_SOURCE_NOT_ALLOWED');
    expect(await connectionRow(h, ig.connectionId)).toMatchObject({ status: 'connected', lead_source_id: null });

    // the database refuses it to anyone who goes around the API: an Owner's insert or update, and the system's
    const as = (actor: Parameters<typeof withTenantTx>[0], q: ReturnType<typeof sql>) => withTenantTx(actor, async (tx) => void (await q.execute(tx)), { db: h.database });
    for (const kind of ['facebook_page', 'instagram_business']) {
      await expect(as(owner.actor(), sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${randomUUID()}, ${kind}, 'Direct', ${src})`), kind).rejects.toThrow(
        /integration_connections_publishing_no_source/,
      );
    }
    await expect(as(owner.actor(), sql`UPDATE integration_connections SET lead_source_id = ${src} WHERE id = ${fb.connectionId}`)).rejects.toThrow(/integration_connections_publishing_no_source/);
    await expect(as(systemActor(owner.tenantId!, 'provider'), sql`UPDATE integration_connections SET lead_source_id = ${src} WHERE id = ${ig.connectionId}`)).rejects.toThrow(/integration_connections_publishing_no_source/);
    expect((await h.su.query("SELECT count(*)::int AS n FROM integration_connections WHERE kind IN ('facebook_page','instagram_business') AND lead_source_id IS NOT NULL")).rows[0].n).toBe(0);
  });

  it('partner and later kinds are not connectable; unknown kinds too', async () => {
    for (const kind of ['zillow_feed', 'mls_feed', 'web_chat_widget', 'ads_meta', 'meta_lead_ads', 'bogus']) {
      expect((await startFlow(owner, kind, { externalAccountId: 'x' }, { reauth: h })).code).toBe('INTEGRATION_NOT_CONNECTABLE');
    }
  });

  it('R-INT-2 R-INT-3: the four out-of-scope kinds (D2) cannot start OAuth, and a validly signed state for one completes no callback; a live row made before D2 routes nothing, stays listed as not offered, offers no capability, and can still be disconnected', async () => {
    expect([...OUT_OF_SCOPE_KINDS].sort()).toEqual(['messenger_page', 'instagram_account', 'meta_lead_ads', 'ads_meta'].sort());
    for (const kind of OUT_OF_SCOPE_KINDS) {
      expect((await startFlow(owner, kind, { externalAccountId: `${kind}-x` }, { reauth: h })).code, kind).toBe('INTEGRATION_NOT_CONNECTABLE');
      expect((await startFlow(owner, kind, { externalAccountId: `${kind}-y`, leadSourceId: src }, { reauth: h })).code, kind).toBe('INTEGRATION_NOT_CONNECTABLE');
    }

    // a Messenger row made before D2 (an Owner may create unconfigured rows, R-INT-3), and a state the old code
    // signed for it: valid MAC, current fence, not expired
    const legacy = randomUUID();
    await withTenantTx(owner.actor(), async (tx) => void (await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${legacy}, 'messenger_page', 'Old Page', ${src})`.execute(tx)), { db: h.database });
    expect((await startFlow(owner, 'messenger_page', { connectionId: legacy, externalAccountId: 'legacy-page' }, { reauth: h })).code).toBe('INTEGRATION_NOT_CONNECTABLE');
    const fence = (await h.su.query<{ f: string }>('SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS f FROM integration_connections WHERE id = $1', [legacy])).rows[0]!.f;
    const st: OAuthState = { tenantId: owner.tenantId!, connectionId: legacy, userId: owner.userId!, kind: 'messenger_page', externalAccountId: 'legacy-page', fence, expiresAt: Date.now() + 60_000, nonce: randomBytes(16).toString('base64url') };
    const verifier = pkceVerifier(h.config.sessionSecret, st);
    const meta = h.providers.integrations.oauth.meta;
    const code = meta.issueCode({ codeChallenge: pkceChallengeOf(verifier), accounts: [{ id: 'legacy-page' }] });
    const creds = async () => Number((await h.su.query('SELECT count(*)::int AS n FROM provider_credentials WHERE tenant_id = $1', [owner.tenantId])).rows[0].n);
    const before = await creds();
    expect((await callback(h, 'messenger_page', { state: signState(h.config.sessionSecret, st), code })).result).toBe('STATE_INVALID');
    expect(await connectionRow(h, legacy)).toMatchObject({ status: 'not_configured', external_account_id: null, credential_id: null, capabilities: {}, last_error_code: null });
    expect(await creds()).toBe(before);
    // refused before any provider call: the authorization code was never exchanged, so it still works once
    await expect(meta.exchangeCode({ code, codeVerifier: verifier, redirectUri: 'unused' })).resolves.toMatchObject({ accessToken: expect.any(String) });

    // what the pre-D2 callback (the system actor) could have done: linked the account and made it live (the Messenger
    // row also with publish_posts reported, as when it carried publishing)
    const goLive = async (id: string, account: string, capabilities: Record<string, boolean>) => {
      const credential = randomUUID();
      await withTenantTx(
        systemActor(owner.tenantId!, 'provider'),
        async (tx) => {
          await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref) VALUES (app.tenant_id(), ${credential}, 'meta', ${Buffer.from([1])}, 1, ${account})`.execute(tx);
          await sql`UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = ${account}, credential_id = ${credential}, capabilities = ${JSON.stringify(capabilities)}::jsonb WHERE id = ${id}`.execute(tx);
        },
        { db: h.database },
      );
      expect(await connectionRow(h, id)).toMatchObject({ status: 'connected', external_account_id: account, credential_id: credential });
      return credential;
    };
    const credentialId = await goLive(legacy, 'legacy-page', { publish_posts: true });
    // D2 (0024): a live pre-D2 row of an inbound Meta kind routes nothing; resolve_channel_account never returns these kinds
    expect(await resolve('messenger_page', 'legacy-page')).toEqual([]);
    for (const kind of ['instagram_account', 'meta_lead_ads']) {
      const id = randomUUID();
      await withTenantTx(owner.actor(), async (tx) => void (await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${id}, ${kind}, 'Old account', ${src})`.execute(tx)), { db: h.database });
      await goLive(id, `${kind}-live`, {});
      expect(await resolve(kind, `${kind}-live`), kind).toEqual([]);
    }
    // still listed under its own kind, not offered, and it offers nothing even once counsel cleared publishing
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:fair_housing' AND status = 'published'");
    try {
      const svc = (await list()).services.find((s) => s.kind === 'messenger_page')!;
      expect(svc).toMatchObject({ canConnect: false, sentence: 'Not offered: the owner has taken this out of scope.' });
      expect(svc.connections.find((c) => c.id === legacy)!.capabilities).toEqual([{ name: 'publish_posts', available: false, reason: 'Not offered: the owner has taken this out of scope.' }]);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:fair_housing' AND status = 'published'");
    }
    // an Owner can still retire it: disconnected and the credential revoked in the same transaction (R-INT-5)
    await freshReauth(h, owner);
    expect((await call(owner, 'POST', `/admin/integrations/connections/${legacy}/disconnect`)).status).toBe(200);
    expect((await connectionRow(h, legacy))!.status).toBe('disconnected');
    expect((await h.su.query('SELECT status FROM provider_credentials WHERE id = $1', [credentialId])).rows[0].status).toBe('revoked');
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
    const f = await connectFlow(h, owner, 'facebook_page', { externalAccountId: 'page-dis' }, [{ id: 'page-dis' }]);
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
    expect((await startFlow(owner, 'facebook_page', { connectionId: f.connectionId, externalAccountId: 'page-dis' }, { reauth: h })).code).toBe('CONNECTION_NOT_CONNECTABLE');
    const again = await connectFlow(h, owner, 'facebook_page', { externalAccountId: 'page-dis' }, [{ id: 'page-dis' }]);
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
