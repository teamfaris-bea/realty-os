// One lead source in jsdom: each path's steps, values to copy, honest state and actions; where a new lead would go;
// rename, and the off confirm (every path that stops, what happens to what is sent meanwhile, a second explicit
// button, re-auth). Words, never codes; nothing shown as working that the deployment cannot do.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFixture } from '../../shell/testing/fakeApi.js';
import { GOOGLE_STEPS } from './paths/GooglePath.js';
import { CHAT_NO_CONSENT, PARTNER_SENTENCE } from './paths/OtherPaths.js';
import { INTAKE_FIELDS, SHOWN_ONCE } from './paths/WebhookPath.js';
import { firstResponseWords } from './Preview.js';
import { GKEY, HOOK_URL, S1, err, googleForm, overview, phone, source, sourcesApp, sourcesFake } from './testing.js';
import { TELEPHONY_OFF_SETUP, TELEPHONY_SIMULATED } from '../admin/lib/telephony.js';
import { OFF_SENTENCE, TRACKING_SENTENCE } from './words.js';

// the same user and team as the signed-in fixture (a different one would clear the page's data, as a real switch does)
const base = sessionFixture({ reauthenticatedAt: new Date().toISOString() });
const session = { ...base, tenant: { ...base.tenant!, role: 'owner' as const }, csrfToken: 'csrf-2' };
const page = (setup?: string) => `/admin/lead-sources/${S1}${setup ? `?setup=${setup}` : ''}`;
const fresh = { reauthenticatedAt: new Date().toISOString() };
const section = async (title: string) => within((await screen.findByRole('heading', { level: 2, name: title })).closest('details')!);

afterEach(() => vi.restoreAllMocks());

describe('A lead source: Google Ads lead form', () => {
  it('?setup=google puts the Google path first and open; turning it on sends the inquiry type and the consent choice (after re-auth), then shows the URL and key to copy and the steps', async () => {
    const s = source({ name: 'Home value form', kind: 'ads', hasConsentText: true });
    let form = googleForm({ sourceHasConsentText: true });
    let n = 0;
    const fake = sourcesFake(overview([s]))
      .on(`GET /lead-sources/${S1}/google-lead-form`, () => ({ status: 200, body: form }))
      .on(`POST /lead-sources/${S1}/google-lead-form`, () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : ((form = googleForm({ state: 'on', key: GKEY, inquiryType: 'value', citesSourceDisclosure: true, createdAt: '2026-11-12T10:00:00.000Z', sourceHasConsentText: true })), { status: 201, body: { key: GKEY, webhookUrl: HOOK_URL, createdAt: '2026-11-12T10:00:00.000Z' } })))
      .on('POST /auth/reauth', { status: 200, body: { session } });
    sourcesApp(fake, page('google'), 'owner');
    const u = userEvent.setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home value form' })).toBeInTheDocument();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles[0]).toBe('Google Ads lead form');
    const g = await section('Google Ads lead form');
    expect((screen.getByRole('heading', { level: 2, name: 'Google Ads lead form' }).closest('details') as HTMLDetailsElement).open).toBe(true);
    const picker = g.getByLabelText('What these leads are about');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Buying', 'Selling', 'Renting', 'Home value', 'General']);
    await u.selectOptions(picker, 'value');
    await u.click(g.getByLabelText('This consent text is shown on the Google form'));
    await u.click(g.getByRole('button', { name: 'Turn on the Google lead form' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const g2 = await section('Google Ads lead form');
    expect(await g2.findByLabelText('Key')).toHaveValue(GKEY);
    expect(g2.getByLabelText('Webhook URL')).toHaveValue(HOOK_URL);
    expect(g2.getByRole('button', { name: 'Copy the key' })).toBeInTheDocument();
    expect(g2.getByRole('button', { name: 'Copy the webhook url' })).toBeInTheDocument();
    const calls = fake.callsTo(`POST /lead-sources/${S1}/google-lead-form`);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ inquiryType: 'value', citesSourceDisclosure: true });
    for (const step of GOOGLE_STEPS) expect(g2.getByText(step)).toBeInTheDocument();
    // before any test: the honest caveat, not a claim that the test will arrive
    expect(g2.getByText("Google's test button may not reach us. A real lead from your own form is the check.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/REAUTH_REQUIRED|VERIFY|not_available/);
  });

  it('copying the key is one tap', async () => {
    const fake = sourcesFake(overview([source({ paths: { googleLeadForm: { state: 'on', createdAt: '2026-11-12T10:00:00.000Z', inquiryType: 'value', citesSourceDisclosure: false, lastTestAt: null, lastUnreadableAt: null, unreadableCount: 0 } } })])).on(`GET /lead-sources/${S1}/google-lead-form`, { status: 200, body: googleForm({ state: 'on', key: GKEY, inquiryType: 'value' }) });
    sourcesApp(fake, page(), 'owner');
    const u = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const g = await section('Google Ads lead form');
    await u.click(await g.findByRole('button', { name: 'Copy the key' }));
    expect(write).toHaveBeenCalledWith(GKEY);
    expect(g.getAllByRole('status').some((s) => s.textContent === 'Copied')).toBe(true);
  });

  it('on: says when the test lead came (no one was added), the last lead, and leads Google sent that could not be read', async () => {
    const fake = sourcesFake(overview([source({ paths: { googleLeadForm: { state: 'on', createdAt: '2026-11-12T10:00:00.000Z', inquiryType: 'value', citesSourceDisclosure: false, lastTestAt: '2026-11-12T10:05:00.000Z', lastUnreadableAt: '2026-11-12T11:00:00.000Z', unreadableCount: 2 } } })])).on(`GET /lead-sources/${S1}/google-lead-form`, {
      status: 200,
      body: googleForm({ state: 'on', key: GKEY, inquiryType: 'value', lastTestAt: '2026-11-12T10:05:00.000Z', lastLeadAt: '2026-11-12T10:30:00.000Z', lastUnreadableAt: '2026-11-12T11:00:00.000Z', unreadableCount: 2 }),
    });
    sourcesApp(fake, page(), 'owner');
    const g = await section('Google Ads lead form');
    expect(await g.findByText(/^Test lead received Nov 12, .* \(no one was added\)$/)).toBeInTheDocument();
    expect(g.getByText(/^Last lead Nov 12, /)).toBeInTheDocument();
    expect(g.getByText(/^Google sent 2 leads we couldn't read \(last Nov 12, .*\): download them from Google Ads$/)).toBeInTheDocument();
    expect(g.queryByText(/test button may not reach us/)).toBeNull();
  });

  it('a deployment with no public https address says Google cannot reach it and offers nothing to turn on', async () => {
    const fake = sourcesFake(overview([source({ paths: { googleLeadForm: { state: 'not_available', createdAt: null, inquiryType: null, citesSourceDisclosure: null, lastTestAt: null, lastUnreadableAt: null, unreadableCount: 0 } } })], { publicHttps: false }));
    sourcesApp(fake, page('google'), 'owner');
    const g = await section('Google Ads lead form');
    expect(g.getByText("This deployment has no public https address, so Google can't reach it.")).toBeInTheDocument();
    expect(g.getByText('Not available on this deployment')).toBeInTheDocument();
    expect(g.queryByRole('button', { name: 'Turn on the Google lead form' })).toBeNull();
    expect(fake.callsTo(`GET /lead-sources/${S1}/google-lead-form`)).toHaveLength(0);
  });
});

describe('A lead source: webhook, phone numbers, partner feeds', () => {
  it('webhook: the address and signing secret are shown once with copy buttons and the warning; getting a new one asks first', async () => {
    let n = 0;
    const fake = sourcesFake(overview([source()])).on(`POST /lead-sources/${S1}/webhook`, () => ({ status: 200, body: { intakeUrl: `https://realty.example.test/api/intake/tok${++n}`, signingSecret: `sec${n}`, createdAt: '2026-11-12T10:00:00.000Z' } }));
    sourcesApp(fake, page('webhook'), 'owner', fresh);
    const u = userEvent.setup();
    const w = await section('Webhook (for developers)');
    expect(w.getByText('Not set up. Make an address and a signing secret for your website or system.')).toBeInTheDocument();
    await u.click(w.getByRole('button', { name: 'Make a webhook address' }));
    expect(await w.findByLabelText('Webhook address')).toHaveValue('https://realty.example.test/api/intake/tok1');
    expect(w.getByLabelText('Signing secret')).toHaveValue('sec1');
    expect(w.getByText(SHOWN_ONCE)).toBeInTheDocument();
    expect(w.getByText(/X-Realty-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256\(secret, `\$\{t\}\.\$\{rawBody\}`\)>/)).toBeInTheDocument();
    expect(w.getByText(/older than 5 minutes is refused/)).toBeInTheDocument();
    for (const [k] of INTAKE_FIELDS) expect(w.getByText(k)).toBeInTheDocument();
    expect(w.getByText('If your website can only send email, use the lead email address.')).toBeInTheDocument();
    await u.click(w.getByRole('button', { name: 'Get a new one' }));
    const dialog = await screen.findByRole('dialog', { name: 'Get a new webhook address?' });
    expect(dialog).toHaveAccessibleDescription(/stop working at once/);
    await u.click(within(dialog).getByRole('button', { name: 'Keep the current one' }));
    expect(fake.callsTo(`POST /lead-sources/${S1}/webhook`)).toHaveLength(1);
    await u.click(w.getByRole('button', { name: 'Get a new one' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Get a new webhook address?' })).getByRole('button', { name: 'Get a new one now' }));
    await waitFor(() => expect(w.getByLabelText('Signing secret')).toHaveValue('sec2'));
  });

  it('phone numbers: the exact sentence and the Phone and email link; get a tracking number credited to this source, or use one of yours', async () => {
    const fake = sourcesFake(overview([source(), source({ id: '01900000-0000-7000-8000-00000000510d', name: 'Ads' })]))
      .on('GET /numbers', { status: 200, body: { numbers: [phone({ id: 'n2', e164: '+14155550122', leadSourceId: '01900000-0000-7000-8000-00000000510d' }), phone({ id: 'n3', e164: '+14155550133', purpose: 'team_main' })] } })
      .on('POST /numbers', { status: 201, body: { number: phone({ id: 'n9', e164: '+15105550111', leadSourceId: S1 }) } })
      .on('PATCH /numbers/n2/lead-source', { status: 200, body: { number: phone({ id: 'n2', e164: '+14155550122', leadSourceId: S1 }) } });
    sourcesApp(fake, page('phone'), 'owner');
    const u = userEvent.setup();
    const p = await section('Tracking phone numbers');
    expect(p.getByText(TRACKING_SENTENCE)).toBeInTheDocument();
    expect(TRACKING_SENTENCE).toBe(
      "New callers and texters become leads credited to this source and are offered by its routing rule. The call itself still rings the team's on-duty person (the first catch-all rule), who may not be the person the lead is offered to. People you already know are threaded as before; someone in a pond or unassigned is routed like a returning lead. Recording is unchanged. Texting back from this number needs its registration.",
    );
    expect(p.getByRole('link', { name: /Phone and email/ })).toHaveAttribute('href', '/admin/numbers');
    expect(await p.findByText('No tracking number is tied to this source.')).toBeInTheDocument();
    await u.type(p.getByLabelText('Area code (optional)'), '510');
    await u.click(p.getByRole('button', { name: 'Get a tracking number' }));
    await waitFor(() => expect(fake.callsTo('POST /numbers')).toHaveLength(1));
    expect(fake.callsTo('POST /numbers')[0]!.body).toEqual({ purpose: 'tracking', leadSourceId: S1, areaCode: '510' });
    expect(await p.findByText('(510) 555-0111 now credits Zillow')).toBeInTheDocument();
    // a team line is not offered; a tracking number of another source says which
    const pick = p.getByLabelText('Use one of your tracking numbers');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick a number', '(415) 555-0122 (now credits Ads)']);
    await u.selectOptions(pick, 'n2');
    await u.click(p.getByRole('button', { name: 'Use this number' }));
    await waitFor(() => expect(fake.callsTo('PATCH /numbers/n2/lead-source')).toHaveLength(1));
    expect(fake.callsTo('PATCH /numbers/n2/lead-source')[0]!.body).toEqual({ leadSourceId: S1 });
  });

  it('R-TWL-1 b9 ui/F3: with the kill switch off, the phone path says so before the tap and does not offer to buy a number; tying one you have still works', async () => {
    const fake = sourcesFake(overview([source()], { telephony: 'off' })).on('GET /numbers', { status: 200, body: { numbers: [phone({ id: 'n2', e164: '+14155550122' })], telephony: 'off' } });
    sourcesApp(fake, page('phone'), 'owner');
    const p = await section('Tracking phone numbers');
    expect(await p.findByText(TELEPHONY_OFF_SETUP)).toBeInTheDocument();
    expect(TELEPHONY_OFF_SETUP).toBe('Live texting and calling are off on this deployment: numbers can be set up but nothing reaches a phone yet.');
    expect(p.getByRole('button', { name: 'Get a tracking number' })).toBeDisabled();
    expect(p.getByLabelText('Use one of your tracking numbers')).toBeEnabled();
    expect(fake.callsTo('POST /numbers')).toHaveLength(0);
  });

  it('R-TWL-1 b9 ui/F3: with a simulated provider, the phone path says nothing reaches a phone and that its numbers are test numbers', async () => {
    const fake = sourcesFake(overview([source()], { telephony: 'simulated' })).on('GET /numbers', { status: 200, body: { numbers: [], telephony: 'simulated' } });
    sourcesApp(fake, page('phone'), 'owner');
    const p = await section('Tracking phone numbers');
    expect(await p.findByText(TELEPHONY_OFF_SETUP)).toBeInTheDocument();
    expect(p.getByText(TELEPHONY_SIMULATED)).toBeInTheDocument();
  });

  it('a number bought but not tied says the server’s notice as is', async () => {
    const fake = sourcesFake(overview([source()])).on('POST /numbers', { status: 201, body: { number: phone({ id: 'n9', leadSourceId: null }), notice: 'Bought, but not tied to Zillow: that source was turned off.' } });
    sourcesApp(fake, page('phone'), 'owner');
    const u = userEvent.setup();
    const p = await section('Tracking phone numbers');
    await u.click(p.getByRole('button', { name: 'Get a tracking number' }));
    expect(await p.findByText('Bought, but not tied to Zillow: that source was turned off.')).toBeInTheDocument();
  });

  it('partner feed: "Needs partner access" and use lead email meanwhile; never "connected"', async () => {
    sourcesApp(sourcesFake(overview([source({ paths: { partnerFeeds: [{ kind: 'zillow_feed', status: 'connected' }] } })])), page('partner'), 'owner');
    const f = await section('Zillow or Realtor.com partner feed');
    expect(f.getAllByText(/Needs partner access|needs partner access/).length).toBeGreaterThanOrEqual(2);
    expect(f.getByText(PARTNER_SENTENCE)).toBeInTheDocument();
    expect(f.getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/admin/integrations');
    expect(f.getByRole('link', { name: 'Use lead email' })).toHaveAttribute('href', '#email');
    expect(document.body.textContent).not.toMatch(/connected|zillow_feed/i);
  });

  it('website chat and typed-in leads link to their own pages', async () => {
    sourcesApp(sourcesFake(overview([source()])), page(), 'owner');
    expect((await section('Website chat')).getByRole('link', { name: 'Set up website chat' })).toHaveAttribute('href', '/admin/web-chat');
    const t = await section('Typed in or imported');
    expect(t.getByRole('link', { name: 'Add a person' })).toHaveAttribute('href', '/people/new');
    expect(t.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/imports');
  });
});

describe('A lead source: website chat agrees with the Website chat page (b9 ui/F5)', () => {
  const chatSummary = () => screen.getByRole('heading', { level: 2, name: 'Website chat' }).closest('summary')!;

  it('R-LSRC-1 b9 ui/F5: a live widget on a source with no consent text is "Not working", and the path says why and where to add it', async () => {
    sourcesApp(sourcesFake(overview([source({ hasConsentText: false, paths: { webChats: [{ status: 'connected' }] } })])), page(), 'owner');
    const c = await section('Website chat');
    expect(chatSummary().textContent).toMatch(/Not working: no consent text/);
    expect(chatSummary().textContent).not.toMatch(/\bOn\b/);
    expect(c.getByText(CHAT_NO_CONSENT)).toBeInTheDocument();
  });

  it('R-LSRC-1 b9 ui/F5: a widget the Website chat page calls live (connected, or live with problems) is On when the source has consent text', async () => {
    for (const status of ['connected', 'degraded']) {
      const { view } = sourcesApp(sourcesFake(overview([source({ hasConsentText: true, paths: { webChats: [{ status }] } })])), page(), 'owner');
      await section('Website chat');
      expect(chatSummary().textContent).toMatch(/On/);
      expect(screen.queryByText(CHAT_NO_CONSENT)).toBeNull();
      view.unmount();
    }
  });

  it('R-LSRC-2 b9 ui/F5: saving consent text refreshes the Website chat queries (its widgets, embed checks and lead sources)', async () => {
    const fake = sourcesFake(overview([source({ hasConsentText: false, paths: { webChats: [{ status: 'connected' }] } })])).on(`PATCH /lead-sources/${S1}`, { status: 200, body: { source: { id: S1, name: 'Zillow', kind: 'portal', active: true, hasToken: true, createdAt: '' } } });
    const { qc } = sourcesApp(fake, page(), 'owner', fresh);
    for (const key of [['admin', 'web-chat', 'widgets'], ['admin', 'web-chat', 'embed', 'w1'], ['admin', 'lead-sources', 'web-chat']]) qc.setQueryData(key, []);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add consent text' }));
    await u.type(screen.getByLabelText('New consent text'), 'By sending this you agree we may call and text you.');
    await u.type(screen.getByLabelText('Who it names as the seller'), 'A Team');
    await u.click(screen.getByRole('button', { name: 'Save consent text' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /lead-sources/${S1}`)).toHaveLength(1));
    await waitFor(() => {
      for (const key of [['admin', 'web-chat', 'widgets'], ['admin', 'web-chat', 'embed', 'w1'], ['admin', 'lead-sources', 'web-chat']]) expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    });
  });
});

describe('A lead source: preview, rename, off', () => {
  it('"Where would a new lead go?" sends the type, ZIP and price band in cents and shows the sentence, the rule, reasons in words and the 60-second reply', async () => {
    const fake = sourcesFake(overview([source()])).on(`POST /lead-sources/${S1}/preview`, {
      status: 200,
      body: {
        rule: { id: 'r1', name: 'Sellers' },
        outcome: { kind: 'pond', pondId: 'p1', pondName: 'Team pond', reason: 'Nobody in the matching rule can take a lead right now.' },
        considered: [{ userId: 'u1', name: 'Ava Agent', eligible: false, reason: 'Ava Agent is not accepting leads.' }],
        sentence: 'If a lead came in now, it would go to Team pond. Nobody in the matching rule can take a lead right now.',
        firstResponse: 'off',
      },
    });
    sourcesApp(fake, page(), 'owner');
    const u = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Where would a new lead go?' }));
    await u.selectOptions(form.getByLabelText('What the lead is about'), 'sell');
    await u.type(form.getByLabelText('ZIP code (optional)'), '94110');
    await u.type(form.getByLabelText('Lowest price ($)'), '500,000');
    await u.type(form.getByLabelText('Highest price ($)'), '900000');
    await u.click(form.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('If a lead came in now, it would go to Team pond. Nobody in the matching rule can take a lead right now.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /lead-sources/${S1}/preview`)[0]!.body).toEqual({ inquiryType: 'sell', postalCode: '94110', priceMinCents: 50_000_000, priceMaxCents: 90_000_000 });
    expect(screen.getByText('Decided by the rule "Sellers".')).toBeInTheDocument();
    expect(screen.getByText('Ava Agent is not accepting leads.')).toBeInTheDocument();
    expect(screen.getByText(firstResponseWords('off'))).toBeInTheDocument();
    expect(firstResponseWords('queued')).toMatch(/would be queued/);
  });

  it('a name another source has is said in a sentence, not the code', async () => {
    const fake = sourcesFake(overview([source()])).on(`PATCH /lead-sources/${S1}`, err(409, 'VERSION_CONFLICT', { field: 'name' }));
    sourcesApp(fake, page(), 'owner');
    const u = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Rename' }));
    await u.clear(form.getByLabelText('Name'));
    await u.type(form.getByLabelText('Name'), 'Website');
    await u.click(form.getByRole('button', { name: 'Rename' }));
    expect(await form.findByText('Another lead source already has this name. Pick a different one.')).toBeInTheDocument();
    expect(fake.callsTo(`PATCH /lead-sources/${S1}`)[0]!.body).toEqual({ name: 'Website' });
  });

  it('the off confirm lists every path that stops and what happens meanwhile; Keep it on sends nothing; the second button turns it off (re-auth first)', async () => {
    const s = source({
      lastLeadAt: new Date().toISOString(),
      leadsLast30Days: 3,
      paths: {
        email: { state: 'on', address: 'leads+x@leads.realty-os.invalid', lastEmailAt: null },
        googleLeadForm: { state: 'on', createdAt: '2026-11-12T10:00:00.000Z', inquiryType: 'value', citesSourceDisclosure: false, lastTestAt: null, lastUnreadableAt: null, unreadableCount: 0 },
        trackingNumbers: [{ id: 'n1', e164: '+14155550100' }],
        webChats: [{ status: 'connected' }],
      },
    });
    let n = 0;
    const fake = sourcesFake(overview([s]))
      .on(`POST /lead-sources/${S1}/off`, () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { source: { id: S1, name: 'Zillow', kind: 'portal', active: false, offSince: new Date().toISOString(), hasToken: true, createdAt: '' }, paths: ['Lead emails sent to its address'], sentence: OFF_SENTENCE } }))
      .on('POST /auth/reauth', { status: 200, body: { session } });
    sourcesApp(fake, page(), 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Turn off' }));
    let dialog = within(await screen.findByRole('dialog', { name: 'Turn off Zillow?' }));
    expect(within(dialog.getByRole('list', { name: 'These stop' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Lead emails sent to its address',
      'Leads your website or system posts to its webhook address',
      'Google Ads lead form leads',
      'New callers and texters on its tracking number (calls still ring, as unknown callers)',
      'Website chat',
    ]);
    expect(dialog.getByText("What is sent to it while it's off is not received. Google does not resend; its leads stay downloadable in Google Ads for 30 days. Tracked calls still ring, as unknown callers. Website chat stops.")).toBeInTheDocument();
    await u.click(dialog.getByRole('button', { name: 'Keep it on' }));
    expect(fake.callsTo(`POST /lead-sources/${S1}/off`)).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Turn off' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Turn off Zillow?' }));
    await u.click(dialog.getByRole('button', { name: 'Turn off and stop receiving leads' }));
    const reauth = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(reauth).getByLabelText('Password'), 'correct horse');
    await u.click(within(reauth).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fake.callsTo(`POST /lead-sources/${S1}/off`)).toHaveLength(2));
    expect(await screen.findByText(OFF_SENTENCE)).toBeInTheDocument();
  });

  it('an off source says so in one sentence, offers Turn on, and no path offers to set itself up', async () => {
    const s = source({ active: false, offSince: '2026-11-01T17:05:00.000Z' });
    const fake = sourcesFake(overview([s])).on(`POST /lead-sources/${S1}/on`, { status: 200, body: { source: { id: S1, name: 'Zillow', kind: 'portal', active: true, offSince: null, hasToken: true, createdAt: '' }, paths: ['Lead emails sent to its address'], sentence: 'Leads are received again on every path listed.' } });
    sourcesApp(fake, page('google'), 'owner', fresh);
    const u = userEvent.setup();
    expect(await screen.findByText(/^Off since Nov 1, .*: leads sent to it are not received$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on the Google lead form' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make a webhook address' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Get a tracking number' })).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Leads are received again on every path listed.')).toBeInTheDocument();
  });

  it('one column on a phone, paths beside the preview and settings from lg up', async () => {
    sourcesApp(sourcesFake(overview([source()])), page(), 'owner');
    const first = (await screen.findByRole('heading', { level: 2, name: 'Lead email' })).closest('details')!;
    const grid = first.parentElement!.parentElement!;
    expect(grid.className).toMatch(/\bgrid-cols-1\b/);
    expect(grid.className).toMatch(/lg:grid-cols-/);
    for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-tap/);
    for (const d of document.querySelectorAll('summary')) expect(d.className).toMatch(/min-h-tap/);
  });

  it('a source that does not exist (or is not visible) says so', async () => {
    sourcesApp(sourcesFake(overview([])), page(), 'owner');
    expect(await screen.findByText("This lead source doesn't exist, or you can't see it.")).toBeInTheDocument();
  });
});

describe('A lead source: lead email refreshes the Lead sources list (b9 ui/F1)', () => {
  const OLD = `leads+${'ab'.repeat(20)}@leads.realty-os.invalid`;
  const NEW = `leads+${'cd'.repeat(20)}@leads.realty-os.invalid`;
  const inboxOf = (address: string | null) => ({
    leadSourceId: S1,
    enabled: address !== null,
    connectionId: address ? '01900000-0000-7000-8000-00000000c0aa' : null,
    status: address ? 'connected' : null,
    address,
    addressCreatedAt: address ? '2026-11-10T17:00:00.000Z' : null,
    allowedSenderDomains: address ? ['zillow.com'] : [],
    suggestedSenderDomains: [{ domain: 'zillow.com', label: 'Zillow' }],
    ignoredSenderDomains: [],
    portalCatalog: [{ portal: 'zillow', domain: 'zillow.com', label: 'Zillow', preTicked: true }],
    inboundDomainConfigured: true,
  });
  const withEmail = (address: string | null) => source({ paths: { email: address ? { state: 'on', address, lastEmailAt: null } : { state: 'off', address: null, lastEmailAt: null } } });

  it('E590 b9 ui/F1: after Get a new address, All lead sources then Copy writes the NEW address, never the dead one', async () => {
    let current = OLD;
    const fake = sourcesFake(overview([withEmail(OLD)]))
      .on('GET /lead-sources/overview', () => ({ status: 200, body: overview([withEmail(current)]) }))
      .on(`GET /lead-sources/${S1}/lead-email`, () => ({ status: 200, body: { inbox: inboxOf(current) } }))
      .on(`POST /lead-sources/${S1}/lead-email/rotate`, () => ((current = NEW), { status: 200, body: { inbox: inboxOf(NEW) } }));
    sourcesApp(fake, page('email'), 'owner', fresh);
    const u = userEvent.setup();
    const box = within(await screen.findByRole('region', { name: 'Email intake for Zillow' }));
    await u.click(await box.findByRole('button', { name: 'Get a new address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Get a new address?' });
    await u.click(within(dialog).getByRole('button', { name: 'Get a new address now' }));
    await waitFor(() => expect(box.getByLabelText('Inbound address for Zillow')).toHaveValue(NEW));
    await u.click(screen.getAllByRole('link', { name: 'All lead sources' })[0]!);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await u.click(await screen.findByRole('button', { name: 'Copy the lead-email address of Zillow' }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write).toHaveBeenLastCalledWith(NEW);
    expect(write).not.toHaveBeenCalledWith(OLD);
  });

  it('E590 b9 ui/F1: turning lead email on flips the path summary from Not set up to On', async () => {
    let current: string | null = null;
    const fake = sourcesFake(overview([withEmail(null)]))
      .on('GET /lead-sources/overview', () => ({ status: 200, body: overview([withEmail(current)]) }))
      .on(`GET /lead-sources/${S1}/lead-email`, () => ({ status: 200, body: { inbox: inboxOf(current) } }))
      .on(`POST /lead-sources/${S1}/lead-email`, () => ((current = OLD), { status: 200, body: { inbox: inboxOf(OLD) } }));
    sourcesApp(fake, page('email'), 'owner', fresh);
    const u = userEvent.setup();
    const summary = () => screen.getByRole('heading', { level: 2, name: 'Lead email' }).closest('summary')!;
    await screen.findByRole('heading', { level: 2, name: 'Lead email' });
    expect(summary().textContent).toMatch(/Not set up/);
    const box = within(await screen.findByRole('region', { name: 'Email intake for Zillow' }));
    await u.click(await box.findByRole('button', { name: 'Turn on lead email' }));
    await waitFor(() => expect(box.getByLabelText('Inbound address for Zillow')).toHaveValue(OLD));
    await waitFor(() => expect(summary().textContent).toMatch(/On/));
    expect(summary().textContent).not.toMatch(/Not set up/);
  });
});
