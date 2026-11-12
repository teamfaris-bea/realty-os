// Lead sources list in jsdom: one card per source with its kind and one status sentence from the overview's facts
// only (no score, no invented activity), what waits in Needs review (linked there), path chips in words (never a
// code; a partner feed is never said to be connected), one primary action (Copy the lead-email address in one tap,
// or Set up), and Add a source (the kind defaults from "How do leads arrive?" and can be changed; it then opens that
// path's setup). Two taps from phone Home (More → Lead sources), one on desktop. One column at phone width.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPageTable, navFor, pagesFor, tapsTo } from '../../shell/index.js';
import { ADDR, S1, S2, err, overview, source, sourcesApp, sourcesFake } from './testing.js';
import { TELEPHONY_OFF_SETUP } from '../admin/lib/telephony.js';
import { ago, statusSentence } from './words.js';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const zillow = source({ id: S1, name: 'Zillow', lastLeadAt: hoursAgo(2.2), leadsLast30Days: 14, heldEmails: 2, forwardingConfirmations: 1, paths: { email: { state: 'on', address: ADDR, lastEmailAt: hoursAgo(1) }, partnerFeeds: [{ kind: 'zillow_feed', status: 'connected' }] } });
const signs = source({ id: S2, name: 'Yard signs', kind: 'sign_call', paths: { googleLeadForm: { state: 'not_available', createdAt: null, inquiryType: null, citesSourceDisclosure: null, lastTestAt: null, lastUnreadableAt: null, unreadableCount: 0 } } });
const off = source({ id: '01900000-0000-7000-8000-00000000510c', name: 'Old site', kind: 'website', active: false, offSince: '2026-11-01T17:05:00.000Z', lastLeadAt: hoursAgo(400), leadsLast30Days: 3 });

const card = async (name: string) => within((await screen.findByRole('heading', { level: 2, name })).closest('article')!);

afterEach(() => vi.restoreAllMocks());

describe('Lead sources list', () => {
  it('is More → Lead sources on a phone (2 taps) and in the sidebar on desktop (1), for Owner and Admin only', () => {
    const table = defaultPageTable();
    for (const role of ['owner', 'admin'] as const) {
      const nav = navFor(pagesFor(table, role));
      expect(tapsTo(nav, '/admin/lead-sources', 'phone')).toBe(2);
      expect(tapsTo(nav, '/admin/lead-sources', 'desktop')).toBe(1);
      expect(nav.more.find((i) => i.path === '/admin/lead-sources')?.label).toBe('Lead sources');
    }
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) expect(tapsTo(navFor(pagesFor(table, role)), '/admin/lead-sources', 'phone')).toBeNull();
  });

  it('each card says its kind in words and one status sentence from the facts: last lead and the 30-day count, no leads yet, or off since when', async () => {
    sourcesApp(sourcesFake(overview([zillow, signs, off])), '/admin/lead-sources', 'owner');
    const z = await card('Zillow');
    expect(z.getByText('Portal')).toBeInTheDocument();
    expect(z.getByText('Last lead 2 hours ago · 14 in the last 30 days')).toBeInTheDocument();
    const y = await card('Yard signs');
    expect(y.getByText('Sign or ad calls')).toBeInTheDocument();
    expect(y.getByText('No leads yet')).toBeInTheDocument();
    const o = await card('Old site');
    expect(o.getByText(/^Off since Nov 1, .*: leads sent to it are not received$/)).toBeInTheDocument();
    // no score, no percentage, no code anywhere
    expect(document.body.textContent).not.toMatch(/score|%|sign_call|not_available|zillow_feed|LEAD_|VERIFY/);
    expect(statusSentence({ active: true, offSince: null, lastLeadAt: null, leadsLast30Days: 0 }, NOW)).toBe('No leads yet');
    expect(ago(new Date(NOW - 61_000).toISOString(), NOW)).toBe('1 minute ago');
    expect(ago(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('3 days ago');
  });

  it('says what waits in Needs review (held emails and a forwarding confirmation) and links there', async () => {
    sourcesApp(sourcesFake(overview([zillow])), '/admin/lead-sources', 'owner');
    const z = await card('Zillow');
    expect(z.getByRole('link', { name: '2 emails wait and 1 forwarding confirmation waits in Needs review' })).toHaveAttribute('href', '/team/lead-email');
  });

  it('path chips are words; a partner feed only ever "Needs partner access", even when its connection row says connected', async () => {
    sourcesApp(sourcesFake(overview([zillow, signs, off])), '/admin/lead-sources', 'owner');
    const z = within((await card('Zillow')).getByRole('list', { name: 'Paths of Zillow' }));
    expect(z.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Lead email: On', 'Google Ads lead form: Not set up', 'Tracking number: Not set up', 'Webhook: Not set up', 'Partner feed: Needs partner access']);
    expect(within((await card('Yard signs')).getByRole('list', { name: 'Paths of Yard signs' })).getByText('Google Ads lead form: Not available on this deployment')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/connected/i);
  });

  it('one tap copies the lead-email address when lead email is on; otherwise the one action is Set up, which opens the source', async () => {
    sourcesApp(sourcesFake(overview([zillow, signs])), '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const z = await card('Zillow');
    await u.click(z.getByRole('button', { name: 'Copy the lead-email address of Zillow' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(ADDR);
    expect(z.getByRole('status')).toHaveTextContent('Copied');
    const y = await card('Yard signs');
    expect(y.queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(y.getByRole('link', { name: 'Set up Yard signs' })).toHaveAttribute('href', `/admin/lead-sources/${S2}`);
  });

  it('when the clipboard is refused the address is shown to copy by hand', async () => {
    sourcesApp(sourcesFake(overview([zillow])), '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const z = await card('Zillow');
    await u.click(z.getByRole('button', { name: 'Copy the lead-email address of Zillow' }));
    expect(await z.findByText(ADDR)).toBeInTheDocument();
  });

  it('at phone width it is one column (two from md up) and every action is a 44 px target', async () => {
    sourcesApp(sourcesFake(overview([zillow, signs])), '/admin/lead-sources', 'owner');
    const list = (await screen.findByRole('heading', { level: 2, name: 'Zillow' })).closest('ul')!;
    expect(list.className).toMatch(/\bgrid-cols-1\b/);
    expect(list.className).toMatch(/\bmd:grid-cols-2\b/);
    expect(list.className).not.toMatch(/(^|\s)grid-cols-2\b/);
    for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-tap/);
    expect(screen.getByRole('link', { name: 'Set up Yard signs' }).className).toMatch(/min-h-tap/);
  });

  it('with no sources it says so; a failed read is a sentence, never a code', async () => {
    sourcesApp(sourcesFake(overview([])), '/admin/lead-sources', 'owner');
    expect(await screen.findByText('No lead sources yet')).toBeInTheDocument();
  });

  it('a failed read is a sentence', async () => {
    sourcesApp(sourcesFake().on('GET /lead-sources/overview', err(500, 'INTERNAL_ERROR')), '/admin/lead-sources', 'owner');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/INTERNAL_ERROR/);
  });
});

describe('Add a source', () => {
  it('R-TWL-1 b9 ui/F3: "A tracking phone number" says live texting and calling are off before anything is made (switch off or simulated), and nothing when live', async () => {
    for (const telephony of ['off', 'simulated', 'live'] as const) {
      const { view } = sourcesApp(sourcesFake(overview([zillow], { telephony })), '/admin/lead-sources', 'owner');
      const u = userEvent.setup();
      await u.click(await screen.findByRole('button', { name: 'Add a source' }));
      const dialog = within(screen.getByRole('dialog', { name: 'Add a source' }));
      await u.click(dialog.getByLabelText('A tracking phone number'));
      if (telephony === 'live') expect(dialog.queryByText((t) => t.startsWith(TELEPHONY_OFF_SETUP))).toBeNull();
      else expect(dialog.getByText((t) => t.startsWith(TELEPHONY_OFF_SETUP))).toBeInTheDocument();
      view.unmount();
    }
  });

  it('"Google Ads lead form" defaults the kind to Ads (which can be changed); it creates the source and opens its Google setup', async () => {
    const fake = sourcesFake(overview([zillow])).on('POST /lead-sources', (c) => ({ status: 201, body: { source: { id: S2, name: (c.body as { name: string }).name, kind: 'ads', active: true, hasToken: true, createdAt: '' }, ingestToken: 't', intakePath: '/api/intake/t' } }));
    const { router } = sourcesApp(fake, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add a source' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add a source' }));
    await u.type(dialog.getByLabelText('Name'), 'Home value form');
    await u.click(dialog.getByLabelText('Google Ads lead form'));
    expect(dialog.getByLabelText('Kind')).toHaveValue('ads');
    await u.click(dialog.getByLabelText('A tracking phone number'));
    expect(dialog.getByLabelText('Kind')).toHaveValue('sign_call');
    await u.click(dialog.getByLabelText('Google Ads lead form'));
    await u.selectOptions(dialog.getByLabelText('Kind'), 'website');
    await u.selectOptions(dialog.getByLabelText('Kind'), 'ads');
    await u.click(dialog.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(fake.callsTo('POST /lead-sources')).toHaveLength(1));
    expect(fake.callsTo('POST /lead-sources')[0]!.body).toEqual({ name: 'Home value form', kind: 'ads' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/lead-sources/${S2}`));
    expect(router.state.location.search).toBe('?setup=google');
  });

  it('every way leads arrive is offered in words, and the consent text is optional (both parts are sent when given)', async () => {
    const fake = sourcesFake(overview([])).on('POST /lead-sources', { status: 201, body: { source: { id: S2, name: 'Site', kind: 'website', active: true, hasToken: true, createdAt: '' }, ingestToken: 't', intakePath: '/api/intake/t' } });
    sourcesApp(fake, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add a source' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add a source' }));
    expect(dialog.getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual([
      'Portal or website emails',
      'Google Ads lead form',
      'A tracking phone number',
      'A website or system that posts leadsFor developers',
      'A Zillow or Realtor.com partner feedNeeds partner access from them',
      'A chat on your website',
      "An agent's forwarded emailA guided setup for one agent",
      'Typed in or imported',
    ]);
    await u.type(dialog.getByLabelText('Name'), 'Site');
    await u.click(dialog.getByRole('radio', { name: /A website or system that posts leads/ }));
    await u.click(dialog.getByLabelText('Add the consent text people see (optional)'));
    expect(dialog.getByRole('button', { name: 'Add source' })).toBeDisabled();
    await u.type(dialog.getByLabelText('Consent text'), 'By sending this you agree we may call and text you.');
    await u.type(dialog.getByLabelText('Who it names as the seller'), 'Harbor Home Team');
    await u.click(dialog.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(fake.callsTo('POST /lead-sources')).toHaveLength(1));
    expect(fake.callsTo('POST /lead-sources')[0]!.body).toEqual({ name: 'Site', kind: 'website', consentDisclosure: { text: 'By sending this you agree we may call and text you.', namesSeller: 'Harbor Home Team' } });
  });

  it('a name already taken is said in a sentence; a deployment without public https says Google cannot reach it before anything is made', async () => {
    const fake = sourcesFake(overview([zillow], { publicHttps: false })).on('POST /lead-sources', err(409, 'VERSION_CONFLICT', { field: 'name' }));
    sourcesApp(fake, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add a source' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add a source' }));
    await u.type(dialog.getByLabelText('Name'), 'Zillow');
    await u.click(dialog.getByLabelText('Google Ads lead form'));
    expect(dialog.getByText("This deployment has no public https address, so Google can't reach it.")).toBeInTheDocument();
    await u.click(dialog.getByRole('button', { name: 'Add source' }));
    expect(await dialog.findByText('Another lead source already has this name. Pick a different one.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/VERSION_CONFLICT/);
  });
});

describe('R-LSRC-2 skipped while off', () => {
  it('R-LSRC-2 E597: the card says how many partner-feed leads were skipped while the source was off, in words', async () => {
    const { skippedSentence } = await import('./words.js');
    expect(skippedSentence({ skippedWhileOffLast30Days: 0 })).toBeNull();
    expect(skippedSentence({ skippedWhileOffLast30Days: 1 })).toBe('1 lead skipped while this source was off (last 30 days)');
    expect(skippedSentence({ skippedWhileOffLast30Days: 3 })).toBe('3 leads skipped while this source was off (last 30 days)');
  });
});
