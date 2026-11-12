// The Integrations page (module 41) in jsdom on a scripted API: every in-scope service with its sentence, each
// platform pack's counsel-review state with an honest banner, capabilities in words, D2 (no Meta DM, lead-ads or
// Meta-ads kind is ever offered; platform:meta is never shown as a review to clear; a pre-D2 row can only be
// disconnected, with re-auth), the provider callback's result in words, Owner/Admin only, no axe violations.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, ID, NOT_ADMINS, err, integrations, mount, reauthOk, violations } from './testing.js';
import { GOOGLE_ADS_HINT, PAGE_PATH, PARTNER_FEED_HINT } from './words.js';

const OUT_OF_SCOPE_NAMES = ['Facebook Messenger', 'Instagram direct messages', 'Meta Lead Ads', 'Meta ads account'];

describe('Integrations page', () => {
  it('shows every in-scope service with its state in words, on the test adapters', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'Integrations' })).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Services' });
    for (const name of ['Facebook Page (publishing)', 'Instagram business account (publishing)', 'Google Ads account', 'Google Business Profile', 'Zillow lead feed', 'realtor.com lead feed', 'Lead email inbox', 'Website chat', 'MLS listings (Spark, read-only)']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    // the banner does not call the MLS connection simulated: the MLS card says what it does
    // b7 ui/F3: the list names the personal calendars too (the same adapters)
    expect(screen.getByText(/test adapters for Meta, Google, Zillow, realtor\.com, the showing service and personal calendars/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/every connection here is simulated/);
    // there is no connect control here, and the page says so for the services that connect with a login
    expect(screen.getAllByText(/Connecting is not available from this page yet\./)).toHaveLength(3);
    expect(screen.getAllByText(/Needs partner access: Zillow lead feed has not granted/)).toHaveLength(1);
    expect(screen.getByText('Arrives with ads (Phase 3); it cannot be connected yet.')).toBeInTheDocument();
    // keyed services point at their own page, not at "inbox settings"
    expect(screen.queryByText(/inbox settings/)).toBeNull();
    expect(screen.getAllByText('It has no outside account to connect; it is set up on its own page (below).')).toHaveLength(2);
    // a raw status code in the server's sentence is not shown
    expect(screen.getByText('Connected with problems. Some messages may be delayed.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PROVIDER_ERRORS|platform:/);
    expect(await violations()).toEqual([]);
  });

  it('D2: never offers a Meta DM, lead-ads or Meta-ads kind, and has no connect action at all', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations({ messengerRow: 'disconnected' }) }), PAGE_PATH);
    await screen.findByRole('heading', { level: 2, name: 'Services' });
    for (const n of OUT_OF_SCOPE_NAMES) expect(screen.queryByText(new RegExp(n))).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No longer offered' })).toBeNull();
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Messenger|direct messages|Lead Ads|Meta ads/);
  });

  it('D2: even if the server listed an out-of-scope kind as connectable, the page does not show it', async () => {
    const body = integrations();
    body.services = body.services.map((s) => (s.kind === 'meta_lead_ads' ? { ...s, connect: 'oauth', sentence: 'Test adapter: connects to a simulated account only.' } : s));
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body }), PAGE_PATH);
    await screen.findByRole('heading', { level: 2, name: 'Services' });
    expect(screen.queryByText(/Meta Lead Ads/)).toBeNull();
  });

  it('every review pack shows whether counsel reviewed it, with a "Not reviewed by counsel" banner; platform:meta is never shown as one to clear', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH);
    const section = (await screen.findByRole('heading', { level: 2, name: 'Counsel review' })).closest('section')!;
    expect(within(section).getByText('Not reviewed by counsel', { selector: 'p' })).toBeInTheDocument();
    expect(within(section).getByText(/None of the 2 review packs has been reviewed by counsel yet/)).toBeInTheDocument();
    expect(within(section).getAllByText('Not reviewed by counsel', { selector: 'span' })).toHaveLength(2);
    expect(within(section).getByText('Publishing marketing (fair-housing rules)')).toBeInTheDocument();
    expect(within(section).getByText('Gmail inbox sync')).toBeInTheDocument();
    expect(screen.queryByText(/Meta messaging/)).toBeNull();
  });

  it('b10 review api-ui/F3 D9: the platform:cma pack is named, never "Another feature", and its line says client CMAs are not built in this version', async () => {
    const body = integrations();
    const sentence = 'Client CMAs and seller value ranges: not built in this version, so nothing built from MLS sales reaches a client; they would also wait for counsel review (pack 2026.11.0, not yet reviewed).';
    body.platformPacks.push({ key: 'platform:cma', version: '2026.11.0', reviewed: false, sentence });
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body }), PAGE_PATH);
    const section = (await screen.findByRole('heading', { level: 2, name: 'Counsel review' })).closest('section')!;
    expect(within(section).getByText('Client CMAs and seller value ranges (a later version)')).toBeInTheDocument();
    expect(within(section).getByText(sentence)).toBeInTheDocument();
    expect(within(section).queryByText('Another feature')).toBeNull();
  });

  it('when every pack is reviewed it says so, and a pack still waiting on the vendor check says that too', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations({ packsReviewed: true }) }), PAGE_PATH);
    const section = (await screen.findByRole('heading', { level: 2, name: 'Counsel review' })).closest('section')!;
    expect(within(section).queryByText('Not reviewed by counsel')).toBeNull();
    expect(within(section).getByText('Reviewed by counsel', { selector: 'p' })).toBeInTheDocument();
    expect(within(section).getAllByText('Reviewed by counsel', { selector: 'span' })).toHaveLength(2);
    expect(within(section).getByText(/it also waits for the vendor check/)).toBeInTheDocument();
  });

  it('a capability is "Works now" only when the server says it is available, and otherwise says why in words', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH);
    const caps = await screen.findByRole('list', { name: 'What Harbor Facebook Page can do' });
    expect(caps).toHaveTextContent('Publish posts: Waits for counsel review of the publishing marketing (fair-housing rules) rules.');
    expect(caps).not.toHaveTextContent('Works now');
  });

  it('an available capability reads "Works now"', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations({ fbCapability: { available: true, reason: null } }) }), PAGE_PATH);
    expect(await screen.findByRole('list', { name: 'What Harbor Facebook Page can do' })).toHaveTextContent('Publish posts: Works now.');
  });

  it('the keyed and key-based services link to where they are set up', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH);
    expect(await screen.findByRole('link', { name: 'Set up website chat' })).toHaveAttribute('href', '/admin/web-chat');
    // lead email, Google Ads (its lead forms) and the two partner feeds (b9 ui/F8)
    const toSources = screen.getAllByRole('link', { name: 'Open Lead sources' });
    expect(toSources).toHaveLength(4);
    for (const l of toSources) expect(l).toHaveAttribute('href', '/admin/lead-sources');
    expect(screen.getByRole('link', { name: 'Open MLS' })).toHaveAttribute('href', '/admin/integrations/mls');
  });

  it('R-GADS-1 b9 ui/F8: Google Ads points to the lead form on Lead sources (where it says whether the deployment can take them) and says the account itself is not connected; the partner feeds point there too', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH);
    const card = async (name: string) => within((await screen.findByRole('heading', { level: 3, name })).closest('li')!);
    const ads = await card('Google Ads account');
    expect(ads.getByRole('link', { name: 'Open Lead sources' })).toHaveAttribute('href', '/admin/lead-sources');
    expect(ads.getByText(GOOGLE_ADS_HINT)).toBeInTheDocument();
    // never "works now": a deployment without public https cannot take them, and Lead sources says so
    expect(GOOGLE_ADS_HINT).not.toMatch(/work now/);
    expect(GOOGLE_ADS_HINT).toMatch(/account itself is not connected/);
    for (const name of ['Zillow lead feed', 'realtor.com lead feed']) {
      const c = await card(name);
      expect(c.getByRole('link', { name: 'Open Lead sources' })).toHaveAttribute('href', '/admin/lead-sources');
      expect(c.getByText(PARTNER_FEED_HINT)).toBeInTheDocument();
    }
  });

  it('a live pre-D2 row is listed only to be disconnected; re-auth is asked and the same request is sent again', async () => {
    let disconnected = false;
    const fake = new FakeFetch()
      .on('GET /admin/integrations', () => ({ status: 200, body: integrations({ messengerRow: disconnected ? 'disconnected' : 'live' }) }))
      .on(`POST /admin/integrations/connections/${ID.messenger}/disconnect`, (_c, n) => {
        if (n === 1) return err(401, 'REAUTH_REQUIRED');
        disconnected = true;
        return { status: 200, body: { connection: {} } };
      })
      .on('POST /auth/reauth', reauthOk);
    mount(fake, PAGE_PATH);
    const block = (await screen.findByRole('heading', { level: 2, name: 'No longer offered' })).closest('section')!;
    expect(within(block).getByText(/Not offered\. Nothing is sent or received through it\./)).toBeInTheDocument();
    expect(within(block).getAllByRole('button')).toHaveLength(1);
    await userEvent.click(within(block).getByRole('button', { name: 'Disconnect Old Messenger page' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Old Messenger page?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    const prompt = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await userEvent.type(within(prompt).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Old Messenger page is disconnected. Its access was revoked.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /admin/integrations/connections/${ID.messenger}/disconnect`)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'No longer offered' })).toBeNull());
    // focus is kept on the page (the heading), not dropped to <body>
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Integrations' })));
  });

  it('the provider callback result is said in words, an unknown one too', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), `${PAGE_PATH}?result=ACCOUNT_NOT_MANAGED`);
    expect(await screen.findByText("The login you used doesn't manage that account, so nothing was connected.")).toBeInTheDocument();
  });

  it('a failed callback does not tell the person to start again from a page that has no connect control', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), `${PAGE_PATH}?result=STATE_EXPIRED`);
    expect(await screen.findByText('That sign-in took too long and expired, so nothing was connected.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Start again/);
  });

  it('an unknown callback result is not shown raw', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), `${PAGE_PATH}?result=SOMETHING_NEW`);
    expect(await screen.findByText(/ended in a way this page cannot describe/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SOMETHING_NEW');
  });

  it('a failed load says so in words', async () => {
    mount(new FakeFetch().on('GET /admin/integrations', err(500, 'INTERNAL_ERROR')), PAGE_PATH);
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong/);
  });

  for (const role of ['owner', 'admin'] as const) {
    it(`the ${role} finds it in the Admin sidebar`, async () => {
      mount(new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() }), PAGE_PATH, role);
      expect(within(await screen.findByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', PAGE_PATH);
    });
  }

  for (const role of NOT_ADMINS) {
    it(`a ${role} has no nav entry and gets "not available", and no request is made`, async () => {
      const fake = new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations() });
      mount(fake, PAGE_PATH, role);
      expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Integrations' })).toBeNull();
      expect(fake.callsTo('GET /admin/integrations')).toHaveLength(0);
    });
  }
});

describe('internal markers never reach the page', () => {
  // VERIFY / VERIFY WITH COUNSEL markers stay in code comments and docs; the Owner sees plain words
  const spark = { status: 200, body: { provider: 'spark', liveCalls: false, sentence: 'Live MLS calls are turned off on this deployment.', authSchemeDefault: 'Bearer', connection: { id: ID.mls, status: 'connected', statusSentence: 'Connected.', keyLabel: 'CRM key', credentialSaved: true, lastResult: 'CONNECTED', connectedAt: null } } };
  const mlsBody = { connections: [{ id: ID.mls, displayName: 'Test MLS feed', status: 'connected', statusSentence: 'Connected.', lastSyncedAt: null, nextSyncAt: null, mlsDataAsOf: 'MLS data as of never', feedStale: true, clientDisplay: false, clientDisplaySentence: 'MLS listings are not shown to clients: the licence pack is not counsel-reviewed.', licensePack: { values: [], reviewedByCounselAt: null, unreviewedCount: 9, sentence: '' } }] };
  const pages: [string, () => FakeFetch, string][] = [
    ['/admin/integrations', () => new FakeFetch().on('GET /admin/integrations', { status: 200, body: integrations({ messengerRow: 'live' }) }), 'Counsel review'],
    ['/admin/integrations/mls', () => new FakeFetch().on('GET /admin/mls', { status: 200, body: mlsBody }).on('GET /admin/integrations/mls/spark', spark), 'Replace the Spark key'],
    ['/admin/web-chat', () => new FakeFetch().on('GET /admin/web-chat/widgets', { status: 200, body: { widgets: [] } }).on('GET /lead-sources', { status: 200, body: { sources: [{ id: ID.source, name: 'Website', active: true }] } }), 'Add a chat widget'],
  ];
  for (const [path, fake, ready] of pages) {
    it(`${path} renders no "VERIFY" marker, in text or in attributes`, async () => {
      mount(fake(), path);
      await screen.findByRole('heading', { level: 2, name: ready });
      expect(document.body.innerHTML).not.toMatch(/VERIFY/i);
    });
  }
});
