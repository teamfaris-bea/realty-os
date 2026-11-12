// Settings → Gmail in jsdom on a scripted API (module 69): not available (in the server's words, no
// button), not connected (the disclosure word for word, ONE Connect Gmail tap posts its hash and leaves for
// Google), back from Google (every callback result in words; "Sync Gmail with these clients?" pre-checked,
// ONE bulk confirm), later suggestions one tap each, stop syncing an address, status in words, Import
// again, Disconnect in 2 taps with the exact copy, REAUTH_REQUIRED, error sentences, axe.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, App, buildRoutes, createQueryClient } from '../../../shell/index.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { DISCLOSURE_PARAGRAPHS, DISCLOSURE_TITLE } from './disclosure.js';
import { MAIL_SETTINGS_PATH, surface } from './index.js';
import { browser } from './MailSettingsPage.js';
import type { MailLinkResponse, MailLinkView, SyncPointsResponse } from './types.js';
import { COPY, MAIL_ERROR_MESSAGES, RESULT_WORDS } from './words.js';

const HASH = 'ec50c5cae564be2d99e7e3f8720e0e91b26491bc8bb0cf2d2233416910793306';
const AUTH_URL = 'https://accounts.fake.invalid/o/oauth2/v2/auth?state=s1&code_challenge=c1';
type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

const link = (over: Partial<MailLinkView> = {}): MailLinkView => ({
  id: '01900000-0000-7000-8000-00000000a001',
  status: 'connected',
  mailboxAddress: 'ava@gmail.example',
  connectedAt: '2026-11-10T15:00:00.000Z',
  lastSyncedAt: '2026-11-11T15:04:00.000Z',
  lastErrorCode: null,
  revokeReason: null,
  backfillRequestedAt: null,
  backfillDoneAt: null,
  statusSentence: 'Connected.',
  ...over,
});

const view = (over: Partial<MailLinkResponse> = {}): MailLinkResponse => ({
  available: { cleared: true, enabled: true, configured: true, canConnect: true, sentence: 'Gmail sync is on for your team.' },
  link: null,
  backfillDays: 30,
  pollIntervalSeconds: 120,
  disclosureSha256: HASH,
  ...over,
});

const P1 = '01900000-0000-7000-8000-0000000000p1';
const P2 = '01900000-0000-7000-8000-0000000000p2';
const P3 = '01900000-0000-7000-8000-0000000000p3';
const suggestions = [
  { pointId: P1, contactId: 'c1', contactName: 'Jane Doe', address: 'jane@example.test' },
  { pointId: P2, contactId: 'c2', contactName: 'Omar Haddad', address: 'omar@example.test' },
];

function mount(fake: FakeFetch, o: { role?: Role; path?: string } = {}) {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role: o.role ?? 'agent' };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  const table = tableWith(surface);
  const api = new ApiClient({ fetch: fake.fetch });
  const router = createMemoryRouter(buildRoutes(table), { initialEntries: [o.path ?? MAIL_SETTINGS_PATH] });
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false, staleTime: Infinity } });
  render(
    <StrictMode>
      <App api={api} table={table} router={router} queryClient={qc} />
    </StrictMode>,
  );
  return { router };
}

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Gmail' });

afterEach(() => vi.restoreAllMocks());

describe('Settings → Gmail: not available', () => {
  const cases: [string, MailLinkResponse['available']][] = [
    ['the pack is not cleared', { cleared: false, enabled: false, configured: true, canConnect: false, sentence: "Gmail sync isn't available yet: it is not reviewed by counsel." }],
    ['the Owner switch is off', { cleared: true, enabled: false, configured: true, canConnect: false, sentence: 'Your Owner has not turned Gmail sync on.' }],
    ['no provider is configured', { cleared: true, enabled: true, configured: false, canConnect: false, sentence: "Gmail isn't set up on this deployment." }],
  ];
  for (const [why, available] of cases) {
    it(`when ${why}: the server's sentence, no Connect Gmail button, no axe violations`, async () => {
      mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view({ available }) }));
      await heading();
      expect(await screen.findByText(available.sentence)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull();
      expect(await violations()).toEqual([]);
    });
  }
});

describe('Settings → Gmail: not connected', () => {
  it('shows the disclosure exactly as disclosure.json says, then ONE tap posts its SHA-256 and leaves for Google', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    const fake = new FakeFetch().on('GET /me/mail-link', { status: 200, body: view() }).on('POST /me/mail-link/connect', { status: 201, body: { authorizeUrl: AUTH_URL, expiresAt: '2026-11-11T16:00:00.000Z' } });
    mount(fake);
    await heading();
    const region = await screen.findByRole('region', { name: DISCLOSURE_TITLE });
    const shown = [...region.querySelectorAll('p')].map((p) => p.textContent);
    expect(shown).toEqual([...DISCLOSURE_PARAGRAPHS]);
    expect(await violations()).toEqual([]);
    await userEvent.click(within(region).getByRole('button', { name: 'Connect Gmail' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
    expect(fake.callsTo('POST /me/mail-link/connect').map((c) => c.body)).toEqual([{ disclosureSha256: HASH }]);
  });

  it('a connect refused (stale disclosure) says why in words and goes nowhere', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view() }).on('POST /me/mail-link/connect', err(409, 'MAIL_DISCLOSURE_STALE')));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    expect(await screen.findByText(MAIL_ERROR_MESSAGES.MAIL_DISCLOSURE_STALE!)).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('MAIL_DISCLOSURE_STALE');
  });

  it('an authorize URL that is not https is never followed', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view() }).on('POST /me/mail-link/connect', { status: 201, body: { authorizeUrl: 'javascript:alert(1)', expiresAt: '' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
  });

  it('Google access removed: "Google access was removed: connect again", and the disclosure with Connect Gmail', async () => {
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view({ link: link({ status: 'revoked', revokeReason: 'PROVIDER_REVOKED' }) }) }));
    expect(await screen.findByText(COPY.providerRevoked)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: DISCLOSURE_TITLE })).toBeVisible();
  });

  it('after Disconnect, it says so and offers Connect Gmail again', async () => {
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view({ link: link({ status: 'revoked', revokeReason: 'USER_DISCONNECTED' }) }) }));
    expect(await screen.findByText('Gmail is disconnected. Your copies were removed from Realty OS.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeVisible();
  });
});

describe('Settings → Gmail: back from Google', () => {
  for (const [code, words] of [...Object.entries(RESULT_WORDS), ['SOMETHING_NEW', { text: 'Gmail was not connected. Tap Connect Gmail to try again.' }] as const]) {
    it(`?result=${code} is said in words, never as a code, and leaves the URL`, async () => {
      const connected = code === 'CONNECTED' || code === 'ALREADY_CONNECTED';
      const fake = new FakeFetch().on('GET /me/mail-link', { status: 200, body: view(connected ? { link: link() } : {}) }).on('GET /me/mail-sync-points', { status: 200, body: { confirmed: [], suggestions: [] } });
      const { router } = mount(fake, { path: `${MAIL_SETTINGS_PATH}?result=${code}` });
      expect(await screen.findByText(words.text)).toBeVisible();
      expect(document.body.textContent).not.toContain(code);
      await waitFor(() => expect(router.state.location.search).toBe(''));
    });
  }

  it('"Sync Gmail with these clients?": every suggestion pre-checked; ONE tap confirms them all (2 taps from Connect Gmail)', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link({ lastSyncedAt: null, backfillRequestedAt: '2026-11-11T15:00:00.000Z' }) }) })
      .on('GET /me/mail-sync-points', (_c, n) => ({ status: 200, body: (n === 1 ? { confirmed: [], suggestions } : { confirmed: suggestions.map((s) => ({ ...s, confirmedAt: '2026-11-11T15:01:00.000Z' })), suggestions: [] }) satisfies SyncPointsResponse }))
      .on('POST /me/mail-sync-points', { status: 200, body: { confirmed: 2 } });
    mount(fake, { path: `${MAIL_SETTINGS_PATH}?result=CONNECTED` });
    const region = await screen.findByRole('region', { name: COPY.confirmTitle });
    expect(within(region).getByText(COPY.onlyConfirmed)).toBeVisible();
    const boxes = within(region).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b).toBeChecked();
    expect(within(region).getByLabelText(/Jane Doe/)).toBeChecked();
    expect(within(region).getByText('jane@example.test')).toBeVisible();
    expect(screen.getByText('Connected: ava@gmail.example. Not synced yet.')).toBeVisible();
    expect(screen.getByText('Importing mail from the last 30 days with your synced clients.')).toBeVisible();
    expect(await violations()).toEqual([]);
    await userEvent.click(within(region).getByRole('button', { name: 'Sync these clients' }));
    expect(await screen.findByText('Syncing Gmail with 2 clients.')).toBeVisible();
    expect(fake.callsTo('POST /me/mail-sync-points').map((c) => c.body)).toEqual([{ pointIds: [P1, P2] }]);
    const synced = await screen.findByRole('region', { name: 'Clients you sync' });
    expect(within(synced).getAllByRole('button', { name: 'Stop syncing this address' })).toHaveLength(2);
  });

  it('an unticked client is left out of the confirm; with none ticked there is nothing to confirm', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
      .on('GET /me/mail-sync-points', { status: 200, body: { confirmed: [], suggestions } })
      .on('POST /me/mail-sync-points', { status: 200, body: { confirmed: 1 } });
    mount(fake);
    const region = await screen.findByRole('region', { name: COPY.confirmTitle });
    await userEvent.click(within(region).getByLabelText(/Omar Haddad/));
    await userEvent.click(within(region).getByRole('button', { name: 'Sync these clients' }));
    expect(await screen.findByText('Syncing Gmail with 1 client.')).toBeVisible();
    expect(fake.callsTo('POST /me/mail-sync-points').map((c) => c.body)).toEqual([{ pointIds: [P1] }]);
    await userEvent.click(within(region).getByLabelText(/Jane Doe/));
    expect(within(region).getByRole('button', { name: 'Sync these clients' })).toBeDisabled();
  });

  it('with no client email on file it says so, and that nothing syncs unconfirmed', async () => {
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view({ link: link() }) }).on('GET /me/mail-sync-points', { status: 200, body: { confirmed: [], suggestions: [] } }));
    expect(await screen.findByText(/None of your clients has an email address on file yet/)).toBeVisible();
    expect(screen.getByText(COPY.onlyConfirmed)).toBeVisible();
  });
});

describe('Settings → Gmail: connected', () => {
  const later = (): SyncPointsResponse => ({
    confirmed: [{ ...suggestions[0]!, confirmedAt: '2026-11-10T15:01:00.000Z' }],
    suggestions: [suggestions[1]!, { pointId: P3, contactId: 'c3', contactName: 'Lee Park', address: 'lee@example.test' }],
  });

  it('a later suggestion is ONE tap: Sync posts just that address', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
      .on('GET /me/mail-sync-points', { status: 200, body: later() })
      .on('POST /me/mail-sync-points', { status: 200, body: { confirmed: 1 } });
    mount(fake);
    const region = await screen.findByRole('region', { name: 'New clients you can sync' });
    expect(screen.queryByRole('region', { name: COPY.confirmTitle })).toBeNull();
    expect(within(region).queryAllByRole('checkbox')).toHaveLength(0);
    expect(await violations()).toEqual([]);
    await userEvent.click(within(region).getByRole('button', { name: 'Sync omar@example.test' }));
    expect(await screen.findByText('Syncing Gmail with 1 client.')).toBeVisible();
    expect(fake.callsTo('POST /me/mail-sync-points').map((c) => c.body)).toEqual([{ pointIds: [P2] }]);
  });

  it('"Stop syncing this address" removes that one confirmation', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
      .on('GET /me/mail-sync-points', { status: 200, body: later() })
      .on(`DELETE /me/mail-sync-points/${P1}`, { status: 200, body: { removed: true } });
    mount(fake);
    const synced = await screen.findByRole('region', { name: 'Clients you sync' });
    expect(within(synced).getByText(COPY.onlyConfirmed)).toBeVisible();
    await userEvent.click(within(synced).getByRole('button', { name: 'Stop syncing this address' }));
    expect(await screen.findByText('Stopped syncing jane@example.test. Its copies left Realty OS.')).toBeVisible();
    expect(fake.callsTo(`DELETE /me/mail-sync-points/${P1}`)).toHaveLength(1);
  });

  it('status in words, read-only line, Import again', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link({ backfillRequestedAt: '2026-11-10T15:00:00.000Z', backfillDoneAt: '2026-11-10T15:10:00.000Z' }) }) })
      .on('GET /me/mail-sync-points', { status: 200, body: later() })
      .on('POST /me/mail-link/import-again', { status: 200, body: { link: link() } });
    mount(fake);
    const mine = await screen.findByRole('region', { name: 'Your Gmail' });
    expect(within(mine).getByText(/^Connected: ava@gmail\.example\. Last synced Nov 11, /)).toBeVisible();
    expect(within(mine).getByText('Mail from the last 30 days with your synced clients was imported.')).toBeVisible();
    expect(within(mine).getByText('Read-only: Realty OS never sends, labels or deletes in your Gmail.')).toBeVisible();
    await userEvent.click(within(mine).getByRole('button', { name: 'Import again' }));
    expect(await screen.findByText(/^Importing again\./)).toBeVisible();
    expect(fake.callsTo('POST /me/mail-link/import-again')).toHaveLength(1);
  });

  it('a degraded link says the server sentence', async () => {
    mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view({ link: link({ status: 'degraded', statusSentence: "Gmail didn't answer at the last sync. Realty OS tries again on its own." }) }) }).on('GET /me/mail-sync-points', { status: 200, body: later() }));
    expect(await screen.findByText("Gmail didn't answer at the last sync. Realty OS tries again on its own.")).toBeVisible();
  });

  it('Disconnect is 2 taps; the sheet shows the exact disconnect copy', async () => {
    let gone = false;
    const fake = new FakeFetch()
      .on('GET /me/mail-link', () => ({ status: 200, body: view({ link: gone ? link({ status: 'revoked', revokeReason: 'USER_DISCONNECTED' }) : link() }) }))
      .on('GET /me/mail-sync-points', { status: 200, body: later() })
      .on('DELETE /me/mail-link', () => {
        gone = true;
        return { status: 200, body: { link: link({ status: 'revoked', revokeReason: 'USER_DISCONNECTED' }) } };
      });
    mount(fake);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const sheet = await screen.findByRole('dialog', { name: 'Disconnect Gmail?' });
    expect(sheet).toHaveAccessibleDescription(COPY.disconnect);
    expect(within(sheet).getByText(COPY.disconnect)).toBeVisible();
    expect(await violations()).toEqual([]);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Disconnect Gmail' }));
    expect(await screen.findByText('Gmail is disconnected. Your copies disappeared from Realty OS.')).toBeVisible();
    expect(fake.callsTo('DELETE /me/mail-link')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeVisible();
  });

  it('REAUTH_REQUIRED asks for the password, then sends the same request once more', async () => {
    const fake = new FakeFetch()
      .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
      .on('GET /me/mail-sync-points', { status: 200, body: later() })
      .on('DELETE /me/mail-link', (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { link: link({ status: 'revoked', revokeReason: 'USER_DISCONNECTED' }) } }))
      .on('POST /auth/reauth', { status: 200, body: { session: sessionFixture({ reauthenticatedAt: new Date().toISOString() }) } });
    mount(fake);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Disconnect Gmail?' })).getByRole('button', { name: 'Disconnect Gmail' }));
    const pw = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await userEvent.type(within(pw).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(pw).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Gmail is disconnected. Your copies disappeared from Realty OS.')).toBeVisible();
    expect(fake.callsTo('DELETE /me/mail-link')).toHaveLength(2);
  });

  it('a failed confirm says why in words (MAIL_NOT_CONNECTED)', async () => {
    mount(
      new FakeFetch()
        .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
        .on('GET /me/mail-sync-points', { status: 200, body: { confirmed: [], suggestions } })
        .on('POST /me/mail-sync-points', err(404, 'MAIL_NOT_CONNECTED')),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sync these clients' }));
    expect(await screen.findByText(MAIL_ERROR_MESSAGES.MAIL_NOT_CONNECTED!)).toBeVisible();
    expect(document.body.textContent).not.toContain('MAIL_NOT_CONNECTED');
  });

  it('every staff role opens it', async () => {
    for (const role of ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const) {
      const { router } = mount(new FakeFetch().on('GET /me/mail-link', { status: 200, body: view() }), { role });
      expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeVisible();
      router.dispose();
      document.body.innerHTML = '';
    }
  });
});

describe('Settings → Gmail: client rows on a phone', () => {
  it('rows stack on a phone (button under the name) and the name block has a real basis; addresses never break mid-word while they fit', async () => {
    mount(
      new FakeFetch()
        .on('GET /me/mail-link', { status: 200, body: view({ link: link() }) })
        .on('GET /me/mail-sync-points', { status: 200, body: { confirmed: [{ ...suggestions[0]!, confirmedAt: '2026-11-10T15:01:00.000Z' }], suggestions: [suggestions[1]!] } }),
    );
    await screen.findByRole('region', { name: 'Clients you sync' });
    const rows = [...document.querySelectorAll('[data-point-row]')];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.className).toMatch(/(^| )flex-col( |$)/);
      expect(r.className).toContain('sm:flex-row');
      const name = r.querySelector('[data-point-name]')!;
      // full width when stacked; the basis applies only in a row (in a column a basis would set the HEIGHT)
      expect(name.className).toMatch(/(^| )w-full( |$)/);
      expect(name.className).toContain('sm:basis-[12rem]');
      expect(name.className).not.toMatch(/(^| )basis-/);
      expect(name.innerHTML).not.toContain('overflow-wrap:anywhere');
    }
  });
});

