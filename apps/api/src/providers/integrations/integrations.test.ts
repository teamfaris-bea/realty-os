// Phase 2-3 adapters (R-INT-1): every adapter has a deterministic fake that is the default; real adapters
// refuse to start unconfigured; production without partner apps is honest ("not configured").
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../auth/testHarness.js';
import { createFakeProviders, createProviders } from '../index.js';
import {
  CONNECTION_KINDS,
  FAKE_CAPABILITIES,
  IntegrationConfigError,
  PlatformOAuth,
  createFakeIntegrations,
  createRealIntegrations,
  createUnconfiguredIntegrations,
  pkceChallenge,
  selectIntegrations,
} from './index.js';

describe('R-INT-1 fakes are the default and deterministic', () => {
  it('the Providers bag carries the Phase 2-3 adapters as fakes in dev and test', () => {
    const p = createFakeProviders();
    expect(p.integrations.mode).toBe('fake');
    const q = createProviders(testConfig(), { clock: { now: () => 0 as never } });
    expect(q.integrations.mode).toBe('fake');
  });

  it('two fresh fake bags give identical results for the same calls', async () => {
    const run = async () => {
      const a = createFakeIntegrations();
      const code = a.oauth.meta.issueCode({ codeChallenge: pkceChallenge('v'.repeat(43)), accounts: [{ id: 'page-1', name: 'Harbor' }] });
      const tok = await a.oauth.meta.exchangeCode({ code, codeVerifier: 'v'.repeat(43), redirectUri: 'https://x.test/cb' });
      return {
        url: a.oauth.meta.authorizeUrl({ kind: 'facebook_page', state: 's', codeChallenge: 'c', redirectUri: 'https://x.test/cb', scopes: ['pages_manage_posts'] }),
        tok,
        accounts: await a.oauth.meta.listManagedAccounts(tok, 'facebook_page'),
        igAccounts: await a.oauth.meta.listManagedAccounts(tok, 'instagram_business'),
        mls: await a.mlsFeed.changes(null, 1),
        mls2: await a.mlsFeed.changes((await a.mlsFeed.changes(null, 1)).cursor, 5),
        media: await a.mlsFeed.media('FAKE-MLS-1001'),
        license: a.mlsFeed.describeLicense(),
        avm: await a.avm.estimate({ line1: '12 Harbor Way', city: 'Charleston', region: 'SC', postalCode: '29401' }),
        avmNone: await a.avm.estimate({ line1: '1 X', city: 'Y', region: 'SC', postalCode: '29410' }),
        pdf: await a.renderer.renderPdf({ templateKey: 'flyer/v1', fields: { b: '2', a: '1' }, imageCount: 2 }),
        gbp: await a.oauth.google.listManagedAccounts(await a.oauth.google.exchangeCode({ code: a.oauth.google.issueCode({ codeChallenge: pkceChallenge('g'.repeat(43)), accounts: [{ id: 'loc-1' }] }), codeVerifier: 'g'.repeat(43), redirectUri: 'r' }), 'gbp_location'),
        cal: await a.calendar.google.pushEvent({ provider: 'google', accessToken: 't', calendarRef: 'primary' }, { appointmentId: 'ap1', startsAt: 'a', endsAt: 'b', title: 'Showing', externalEventRef: null, externalEtag: null }, { syncVersion: 3 }),
        calStale: await a.calendar.google.pushEvent({ provider: 'google', accessToken: 't', calendarRef: 'primary' }, { appointmentId: 'ap1', startsAt: 'a', endsAt: 'b', title: 'Showing', externalEventRef: null, externalEtag: null }, { syncVersion: 2 }),
        leads: await a.leadFeeds.zillow.poll({ externalAccountId: 'z', accessToken: 't', cursor: null }),
        showings: await a.showing.changes({ externalAccountId: 's', accessToken: 't', cursor: null }),
      };
    };
    const one = await run();
    expect(JSON.stringify(await run())).toBe(JSON.stringify(one));
    expect(one.accounts[0]!.capabilities).toEqual({ publish_posts: true }); // D2: a Page connection publishes, never messages
    expect(one.igAccounts[0]!.capabilities).toEqual({ publish_posts: true }); // D2: so does an Instagram business account
    expect(one.gbp[0]!.capabilities).toEqual({ publish_posts: true, read_reviews: true, reply_reviews: true });
    expect(one.calStale).toEqual({ kind: 'stale', syncVersion: 3 }); // sync_version fence
    expect(one.avmNone).toEqual({ available: false });
    expect(one.license.rules.displayToPublic).toBe(false); // strictest default until a licence pack is entered
    expect(one.mls.listings).toHaveLength(1);
    expect(one.mls2.listings.map((l) => l.listingKey)).toEqual(['FAKE-MLS-1002']);
  });

  it('the fake OAuth provider checks PKCE and makes codes single-use', async () => {
    const a = createFakeIntegrations();
    const code = a.oauth.meta.issueCode({ codeChallenge: pkceChallenge('right'.padEnd(43, 'x')), accounts: [{ id: 'p' }] });
    await expect(a.oauth.meta.exchangeCode({ code, codeVerifier: 'wrong'.padEnd(43, 'x'), redirectUri: 'r' })).rejects.toMatchObject({ providerCode: 'PKCE_MISMATCH' });
    await expect(a.oauth.meta.exchangeCode({ code, codeVerifier: 'right'.padEnd(43, 'x'), redirectUri: 'r' })).rejects.toMatchObject({ providerCode: 'INVALID_GRANT' });
  });

  it('D2: there is no Meta messaging adapter, DM webhook parser or Lead Ads retrieval in the bag', () => {
    const a = createFakeIntegrations() as unknown as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(['avm', 'calendar', 'leadFeeds', 'mlsFeed', 'mode', 'oauth', 'renderer', 'showing', 'social']);
    expect(Object.keys(a.oauth as object).sort()).toEqual(['google', 'meta', 'microsoft']);
  });

  it('D2: the fake platform reports capabilities for the publishing kinds and nothing for the out-of-scope Meta kinds', async () => {
    expect(Object.keys(FAKE_CAPABILITIES).sort()).toEqual(['ads_google', 'facebook_page', 'gbp_location', 'instagram_business']);
    const a = createFakeIntegrations();
    const code = a.oauth.meta.issueCode({ codeChallenge: pkceChallenge('m'.repeat(43)), accounts: [{ id: 'page-1' }] });
    const tok = await a.oauth.meta.exchangeCode({ code, codeVerifier: 'm'.repeat(43), redirectUri: 'r' });
    for (const kind of ['messenger_page', 'instagram_account', 'meta_lead_ads', 'ads_meta'] as const) {
      expect((await a.oauth.meta.listManagedAccounts(tok, kind))[0]!.capabilities, kind).toEqual({});
    }
  });
});

describe('R-INT-1 real adapters refuse to start unconfigured', () => {
  it('Meta and OAuth adapters need their platform app configuration', () => {
    expect(() => new PlatformOAuth('meta', { clientId: 'x', clientSecret: '', authorizeEndpoint: 'https://a.test' })).toThrow(IntegrationConfigError);
    expect(() => new PlatformOAuth('google', { clientId: 'x', clientSecret: 'y', authorizeEndpoint: 'http://plain.test' })).toThrow(IntegrationConfigError);
    expect(() => createRealIntegrations({})).toThrow(IntegrationConfigError);
  });

  it('a configured real adapter that has no vendor integration yet says so instead of pretending', async () => {
    const r = createRealIntegrations({
      META_APP_ID: 'app',
      META_APP_SECRET: 's'.repeat(32),
      META_OAUTH_AUTHORIZE_URL: 'https://meta.example.test/dialog/oauth',
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'h',
      GOOGLE_OAUTH_AUTHORIZE_URL: 'https://google.example.test/o/oauth2/auth',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'n',
      MICROSOFT_OAUTH_AUTHORIZE_URL: 'https://login.example.test/oauth2/v2.0/authorize',
    });
    expect(r.mode).toBe('real');
    await expect(r.oauth.meta.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).rejects.toMatchObject({ kind: 'not_configured' });
    await expect(r.leadFeeds.zillow.poll({ externalAccountId: 'z', accessToken: 't', cursor: null })).rejects.toMatchObject({ providerCode: 'NEEDS_PARTNER_ACCESS' });
    expect(r.leadFeeds.realtor.access).toBe('needs_partner_access');
  });

  it('production without an explicit demo flag never runs the fakes: everything reports not configured', async () => {
    const u = selectIntegrations({ env: 'production', allowFakeProviders: false });
    expect(u.mode).toBe('unconfigured');
    expect(u.oauth.meta.configured).toBe(false);
    expect(u.mlsFeed.access).toBe('needs_partner_access');
    expect(u.oauth.microsoft.configured).toBe(false);
    expect(await u.avm.estimate({ line1: 'a', city: 'b', region: 'SC', postalCode: '29401' })).toEqual({ available: false });
    expect(selectIntegrations({ env: 'production', allowFakeProviders: true }).mode).toBe('fake');
    expect(createUnconfiguredIntegrations().mode).toBe('unconfigured');
    expect(CONNECTION_KINDS).toHaveLength(14); // 0018's twelve plus 0025's facebook_page and instagram_business (D2)
  });
});
