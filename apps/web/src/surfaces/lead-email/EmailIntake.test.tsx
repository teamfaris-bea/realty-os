// Email intake of a lead source on Lead routing (Owner/Admin): off → "Turn on lead email" with the
// suggested sender domains as removable chips (each marked "suggested", with one plain sentence that they
// are unconfirmed until a test lead from each portal becomes a lead automatically; the internal VERIFY marker
// never shows) and re-auth on a stale session; on → the address read-only with Copy ("Copied" announced),
// sender domains add/remove/Save, and "Get a new address" behind a confirm that says the old address stops
// working at once. Codes never show.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { member, settings } from '../admin/lib/testing.js';
import { ROTATE_WARNING, TRUST_SENTENCE, cleanDomain } from './EmailIntake.js';
import { LEAD_EMAIL_ERROR_MESSAGES } from './messages.js';
import { ADDRESS, FakeFetch, SRC, enabledInbox, err, inbox, leadEmailApp } from './testing.js';
import type { Inbox } from './types.js';

const session = { user: { id: 'u', email: 'me@example.test', displayName: 'Me' }, tenant: { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role: 'owner' }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'csrf-2' };

function routingFake(box: Inbox | null = inbox()) {
  const f = new FakeFetch()
    .on('GET /routing-rules', { status: 200, body: { rules: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } })
    .on('GET /members', { status: 200, body: { members: [member()], invites: [] } })
    .on('GET /lead-sources', { status: 200, body: { sources: [{ id: SRC, name: 'Portal', kind: 'portal', active: true, hasToken: true, createdAt: '' }] } })
    .on('GET /settings', { status: 200, body: { settings } });
  if (box) f.on(`GET /lead-sources/${SRC}/lead-email`, { status: 200, body: { inbox: box } });
  return f;
}

const intake = async () => within(await screen.findByRole('region', { name: 'Email intake for Portal' }));
type Box = Awaited<ReturnType<typeof intake>>;

/** What each sender-domain chip says (its text, without the Remove control). */
const chips = (box: Box) => within(box.getByRole('list', { name: 'Allowed sender domains' })).queryAllByRole('listitem').map((li) => li.querySelector('span')?.textContent ?? '');
// What confirms a suggestion is the trust sentence's own condition: a test lead that arrives but waits in Needs
// review (signed by the portal's email vendor, say) confirms nothing, so "arrives" would mislead.
const UNCONFIRMED = 'Suggested domains are unconfirmed until a test lead from each portal becomes a lead automatically.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Email intake on Lead routing', () => {
  it('lists the lead source with the plain trust sentence; off, it offers Turn on lead email with the suggested domains as chips marked "suggested" and says in plain words they are unconfirmed (never the internal VERIFY marker)', async () => {
    leadEmailApp(routingFake(), '/admin/routing', 'owner');
    expect(await screen.findByRole('heading', { level: 3, name: /Portal/ })).toBeInTheDocument();
    const box = await intake();
    expect(await box.findByRole('button', { name: 'Turn on lead email' })).toBeInTheDocument();
    expect(box.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Only emails DKIM-signed by an allowed domain become leads automatically; everything else waits in Needs review.')).toBeInTheDocument();
    expect(box.getByRole('link', { name: 'Needs review' })).toHaveAttribute('href', '/team/lead-email');
    expect(chips(box)).toEqual(['zillow.com · Zillow · suggested', 'realtor.com · Realtor.com · suggested']);
    expect(box.getByText(UNCONFIRMED)).toBeInTheDocument();
    expect(box.getByRole('list', { name: 'Allowed sender domains' })).toHaveAccessibleDescription(UNCONFIRMED);
    expect(box.getByRole('button', { name: 'Remove zillow.com' })).toBeInTheDocument();
    // VERIFY is an internal marker for engineers and counsel: an Owner never reads it
    expect(document.body.textContent).not.toMatch(/VERIFY/);
    for (const s of [TRUST_SENTENCE, ROTATE_WARNING, ...Object.values(LEAD_EMAIL_ERROR_MESSAGES)]) expect(s).not.toMatch(/VERIFY/);
  });

  it('a domain the Owner types is not marked suggested; with no suggestion left on the list, the unconfirmed sentence goes', async () => {
    leadEmailApp(routingFake(), '/admin/routing', 'owner');
    const u = userEvent.setup();
    const box = await intake();
    await u.type(await box.findByLabelText('Add a sender domain'), 'homes.example.test');
    await u.click(box.getByRole('button', { name: 'Add domain' }));
    await u.click(box.getByRole('button', { name: 'Remove zillow.com' }));
    expect(chips(box)).toEqual(['realtor.com · Realtor.com · suggested', 'homes.example.test']);
    expect(box.getByText(UNCONFIRMED)).toBeInTheDocument();
    await u.click(box.getByRole('button', { name: 'Remove realtor.com' }));
    expect(chips(box)).toEqual(['homes.example.test']);
    expect(box.queryByText(UNCONFIRMED)).toBeNull();
    expect(box.getByRole('list', { name: 'Allowed sender domains' })).not.toHaveAttribute('aria-describedby');
  });

  it('on: a saved suggestion keeps its "suggested" mark and the sentence, a typed domain has neither; nothing says VERIFY', async () => {
    leadEmailApp(routingFake(enabledInbox({ allowedSenderDomains: ['zillow.com', 'homes.example.test'] })), '/admin/routing', 'owner');
    const box = await intake();
    expect(await box.findByLabelText('Inbound address for Portal')).toHaveValue(ADDRESS);
    expect(chips(box)).toEqual(['zillow.com · Zillow · suggested', 'homes.example.test']);
    expect(box.getByText(UNCONFIRMED)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/VERIFY/);
  });

  it('turning it on sends the chips left after a removal and an addition; a stale session asks for the password once and sends the same request', async () => {
    let n = 0;
    let current = inbox();
    const fake = routingFake(null)
      .on(`GET /lead-sources/${SRC}/lead-email`, () => ({ status: 200, body: { inbox: current } }))
      .on(`POST /lead-sources/${SRC}/lead-email`, () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : ((current = enabledInbox({ allowedSenderDomains: ['zillow.com', 'homes.example.test'] })), { status: 200, body: { inbox: current } })))
      .on('POST /auth/reauth', { status: 200, body: { session } });
    leadEmailApp(fake, '/admin/routing', 'owner');
    const u = userEvent.setup();
    const box = await intake();
    await u.click(await box.findByRole('button', { name: 'Remove realtor.com' }));
    await u.type(box.getByLabelText('Add a sender domain'), ' Homes.Example.TEST. ');
    await u.click(box.getByRole('button', { name: 'Add domain' }));
    expect(box.getByRole('button', { name: 'Remove homes.example.test' })).toBeInTheDocument();
    await u.click(box.getByRole('button', { name: 'Turn on lead email' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    // the confirmed session re-renders the page: look the section up again
    expect(await (await intake()).findByLabelText('Inbound address for Portal')).toHaveValue(ADDRESS);
    const calls = fake.callsTo(`POST /lead-sources/${SRC}/lead-email`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ allowedSenderDomains: ['zillow.com', 'homes.example.test'] });
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  it('a domain that is not shaped like one is refused in place and not added', async () => {
    leadEmailApp(routingFake(), '/admin/routing', 'owner');
    const u = userEvent.setup();
    const box = await intake();
    await u.type(await box.findByLabelText('Add a sender domain'), 'zillow');
    await u.click(box.getByRole('button', { name: 'Add domain' }));
    expect(box.getByText('Enter a domain like zillow.com.')).toBeInTheDocument();
    expect(box.queryByRole('button', { name: 'Remove zillow' })).toBeNull();
    expect(cleanDomain('@Zillow.com.')).toBe('zillow.com');
    expect(cleanDomain('*.zillow.com')).toBeNull();
    expect(cleanDomain('https://zillow.com')).toBeNull();
  });

  it('on a deployment without an inbound domain it says so in a sentence and offers nothing to turn on', async () => {
    leadEmailApp(routingFake(inbox({ inboundDomainConfigured: false })), '/admin/routing', 'owner');
    const box = await intake();
    expect(await box.findByText(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED!)).toBeInTheDocument();
    expect(box.queryByRole('button', { name: 'Turn on lead email' })).toBeNull();
  });

  it('on: the address is read-only; Copy writes it to the clipboard and announces "Copied"', async () => {
    leadEmailApp(routingFake(enabledInbox()), '/admin/routing', 'owner');
    const u = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const box = await intake();
    const field = await box.findByLabelText('Inbound address for Portal');
    expect(field).toHaveValue(ADDRESS);
    expect(field).toHaveAttribute('readonly');
    await u.click(box.getByRole('button', { name: 'Copy the inbound address for Portal' }));
    expect(write).toHaveBeenCalledWith(ADDRESS);
    const status = box.getAllByRole('status').find((s) => s.textContent === 'Copied');
    expect(status).toBeDefined();
  });

  it('when the clipboard is refused, the address is selected and the page says to copy it from the field', async () => {
    leadEmailApp(routingFake(enabledInbox()), '/admin/routing', 'owner');
    const u = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const box = await intake();
    await u.click(await box.findByRole('button', { name: 'Copy the inbound address for Portal' }));
    expect(await box.findByText("Couldn't copy here. The address is selected: copy it from the field.")).toBeInTheDocument();
  });

  it('sender domains: Save is off until something changes, sends the whole list, and a refused domain is a sentence, never the code', async () => {
    let n = 0;
    const fake = routingFake(enabledInbox()).on(`PUT /lead-sources/${SRC}/lead-email/sender-domains`, () => (++n === 1 ? err(422, 'LEAD_EMAIL_DOMAIN_INVALID', { domain: 'co.uk' }) : { status: 200, body: { inbox: enabledInbox({ allowedSenderDomains: ['zillow.com'] }) } }));
    leadEmailApp(fake, '/admin/routing', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const box = await intake();
    const save = await box.findByRole('button', { name: 'Save sender domains' });
    expect(save).toBeDisabled();
    await u.type(box.getByLabelText('Add a sender domain'), 'co.uk');
    await u.click(box.getByRole('button', { name: 'Add domain' }));
    await u.click(save);
    expect(await box.findByText(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_DOMAIN_INVALID!)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/LEAD_EMAIL_|DKIM_/);
    expect(fake.callsTo(`PUT /lead-sources/${SRC}/lead-email/sender-domains`)[0]!.body).toEqual({ domains: ['zillow.com', 'realtor.com', 'co.uk'] });
    await u.click(box.getByRole('button', { name: 'Remove co.uk' }));
    await u.click(box.getByRole('button', { name: 'Remove realtor.com' }));
    await u.click(save);
    expect(await box.findByText('Sender domains saved')).toBeInTheDocument();
    expect(fake.callsTo(`PUT /lead-sources/${SRC}/lead-email/sender-domains`)[1]!.body).toEqual({ domains: ['zillow.com'] });
  });

  it('Get a new address asks first and says the old address stops working at once; Keep this address sends nothing; confirming rotates', async () => {
    const next = `leads+${'cd'.repeat(20)}@leads.realty-os.invalid`;
    let current = enabledInbox();
    const fake = routingFake(null)
      .on(`GET /lead-sources/${SRC}/lead-email`, () => ({ status: 200, body: { inbox: current } }))
      .on(`POST /lead-sources/${SRC}/lead-email/rotate`, () => ((current = enabledInbox({ address: next })), { status: 200, body: { inbox: current } }));
    leadEmailApp(fake, '/admin/routing', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const box = await intake();
    await u.click(await box.findByRole('button', { name: 'Get a new address' }));
    let dialog = await screen.findByRole('dialog', { name: 'Get a new address?' });
    expect(dialog).toHaveAccessibleDescription(ROTATE_WARNING);
    expect(ROTATE_WARNING).toMatch(/stops working at once/);
    await u.click(within(dialog).getByRole('button', { name: 'Keep this address' }));
    expect(fake.callsTo(`POST /lead-sources/${SRC}/lead-email/rotate`)).toHaveLength(0);
    await u.click(box.getByRole('button', { name: 'Get a new address' }));
    dialog = await screen.findByRole('dialog', { name: 'Get a new address?' });
    await u.click(within(dialog).getByRole('button', { name: 'Get a new address now' }));
    await waitFor(() => expect(box.getByLabelText('Inbound address for Portal')).toHaveValue(next));
    expect(fake.callsTo(`POST /lead-sources/${SRC}/lead-email/rotate`)).toHaveLength(1);
    expect(await box.findByText('New address made. The old one no longer works.')).toBeInTheDocument();
  });

  it('an Admin who cannot see the inbox (404) gets the plain not-available sentence, not a code', async () => {
    const fake = routingFake(null).on(`GET /lead-sources/${SRC}/lead-email`, err(404, 'NOT_FOUND'));
    leadEmailApp(fake, '/admin/routing', 'admin');
    const box = await intake();
    expect(await box.findByText("This isn't available. It may have moved, or you may not have access to it.")).toBeInTheDocument();
  });
});
