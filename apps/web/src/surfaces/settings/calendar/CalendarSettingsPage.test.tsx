// The calendar settings page in jsdom (module 41's calendar page over module 34): the connection state in plain
// words, connect hands off to the provider, disconnect takes two taps and says what happened, the provider
// redirect's result is stated, and detached appointments (E103) are listed with their sentence.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import type { CalendarView, ProviderView } from './CalendarSettingsPage.js';
import { surface } from './index.js';

const provider = (over: Partial<ProviderView> & Pick<ProviderView, 'provider' | 'name'>): ProviderView => ({
  state: 'not_connected',
  sentence: `Not connected. Nothing is sent to your ${over.name}.`,
  canConnect: true,
  canDisconnect: false,
  blockedSentence: null,
  lastSyncedAt: null,
  ...over,
});

const view = (providers: ProviderView[], detached: CalendarView['detached'] = []): CalendarView => ({
  adapterMode: 'fake',
  syncSentence: 'One way: appointments you make or change in Realty OS are added to your calendar.',
  privacySentence: 'Only you see this connection. Owners and Admins cannot see your calendar, your busy times or this link.',
  providers,
  detached,
});

const notConnected = view([provider({ provider: 'google_calendar', name: 'Google Calendar' }), provider({ provider: 'microsoft_calendar', name: 'Microsoft Outlook calendar' })]);
const connected = view(
  [
    provider({ provider: 'google_calendar', name: 'Google Calendar', state: 'connected', sentence: 'Connected. New and changed appointments are added to your Google Calendar.', canConnect: false, canDisconnect: true }),
    provider({ provider: 'microsoft_calendar', name: 'Microsoft Outlook calendar', canConnect: false, blockedSentence: 'Disconnect Google Calendar first to use Microsoft Outlook calendar instead. Realty OS adds appointments to one calendar.' }),
  ],
  [{ appointmentId: '01900000-0000-7000-8000-00000000ap01', kind: 'buyer_consult', startsAt: '2026-11-20T15:00:00.000Z', sentence: 'Edited in Google Calendar; times may differ. Realty OS stopped updating this event so your change is kept.' }],
);

function mount(f: FakeFetch, path = '/settings/calendar') {
  const s = sessionFixture();
  f.on('GET /auth/session', { status: 200, body: s });
  return renderApp({ fake: f, path, table: tableWith(surface) });
}

afterEach(() => vi.restoreAllMocks());

describe('Calendar settings', () => {
  it('says what syncs and who can see it, and offers Connect for each provider when nothing is connected', async () => {
    mount(new FakeFetch().on('GET /me/calendar', { status: 200, body: notConnected }));
    expect(await screen.findByRole('heading', { level: 2, name: 'What syncs' })).toBeInTheDocument();
    expect(screen.getByText(/^One way:/)).toBeInTheDocument();
    expect(screen.getByText(/Owners and Admins cannot see your calendar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Microsoft Outlook calendar' })).toBeInTheDocument();
  });

  it('connect is one tap: it asks the API for the provider URL and goes there', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    const f = new FakeFetch().on('GET /me/calendar', { status: 200, body: notConnected }).on('POST /me/calendar/google_calendar/connect', { status: 201, body: { authorizeUrl: 'https://oauth.fake.invalid/google/authorize?x=1', expiresAt: '2026-11-11T00:10:00Z' } });
    mount(f);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://oauth.fake.invalid/google/authorize?x=1'));
    // back from the provider with the Back button (a bfcache restore): Connect works again
    expect(screen.getByRole('button', { name: 'Opening' })).toHaveAttribute('aria-busy', 'true');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).not.toHaveAttribute('aria-busy'));
  });

  it('a connected calendar shows its state, the other provider says why it cannot connect, and detached appointments are listed in words (E103)', async () => {
    mount(new FakeFetch().on('GET /me/calendar', { status: 200, body: connected }));
    expect(await screen.findByText('Connected. New and changed appointments are added to your Google Calendar.')).toBeInTheDocument();
    expect(screen.getByText(/^Disconnect Google Calendar first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Microsoft Outlook calendar' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'No longer updated in your calendar' })).toBeInTheDocument();
    expect(screen.getByText('Edited in Google Calendar; times may differ. Realty OS stopped updating this event so your change is kept.')).toBeInTheDocument();
  });

  it('disconnect takes two taps, then says what changed and what did not', async () => {
    const f = new FakeFetch().on('GET /me/calendar', { status: 200, body: connected }).on('POST /me/calendar/google_calendar/disconnect', { status: 200, body: notConnected });
    mount(f);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Disconnect Google Calendar' }));
    expect(f.callsTo('POST /me/calendar/google_calendar/disconnect')).toHaveLength(0);
    // focus moves into the confirmation, and back to Disconnect when it is dismissed (never to <body>)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Yes, disconnect' })));
    await u.click(screen.getByRole('button', { name: 'Keep connected' }));
    expect(screen.queryByRole('button', { name: 'Yes, disconnect' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disconnect Google Calendar' })));
    await u.click(screen.getByRole('button', { name: 'Disconnect Google Calendar' }));
    await u.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(await screen.findByText(/Google Calendar is disconnected\. Nothing more is sent to it\./, { selector: '[role=status] *' })).toBeInTheDocument();
    expect(f.callsTo('POST /me/calendar/google_calendar/disconnect')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeInTheDocument();
    // focus lands on the card's heading, and the result is announced
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Google Calendar' })));
  });

  it('needs reconnect (E102) and not configured are stated honestly', async () => {
    mount(
      new FakeFetch().on('GET /me/calendar', {
        status: 200,
        body: view([
          provider({ provider: 'google_calendar', name: 'Google Calendar', state: 'needs_reconnect', sentence: 'Needs reconnect: Google Calendar stopped accepting Realty OS (the access was removed).', canDisconnect: true }),
          provider({ provider: 'microsoft_calendar', name: 'Microsoft Outlook calendar', state: 'not_configured', sentence: 'Not set up on this platform yet: Microsoft Outlook calendar cannot be connected here until the platform\'s app is approved.', canConnect: false }),
        ]),
      }),
    );
    expect(await screen.findByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Google Calendar' })).toBeInTheDocument();
    // dismissing the warning is called what it is: no access is being revoked (it already was)
    expect(screen.getByRole('button', { name: 'Remove Google Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect Google Calendar' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove Google Calendar' }));
    expect(screen.getByText(/Realty OS already has no access to Google Calendar\. This only clears the reconnect warning/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, remove' })).toBeInTheDocument();
    expect(screen.getByText('Not set up on this platform')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Microsoft Outlook calendar' })).toBeNull();
  });

  it('states the provider redirect result, including a refused scope', async () => {
    mount(new FakeFetch().on('GET /me/calendar', { status: 200, body: connected }), '/settings/calendar?result=CONNECTED');
    expect(await screen.findByText('Your calendar is connected. New and changed appointments will appear there.')).toBeInTheDocument();
  });

  it('a refused scope says nothing was connected; an error from connect is a sentence, never a code', async () => {
    const f = new FakeFetch().on('GET /me/calendar', { status: 200, body: notConnected }).on('POST /me/calendar/google_calendar/connect', err(409, 'CALENDAR_ALREADY_CONNECTED'));
    mount(f, '/settings/calendar?result=SCOPE_MISMATCH');
    expect(await screen.findByText(/did not match the access Realty OS asks for/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(await screen.findByText('You already have a calendar connected. Disconnect it first to use another one.')).toBeInTheDocument();
    expect(screen.queryByText('CALENDAR_ALREADY_CONNECTED')).toBeNull();
  });
});
