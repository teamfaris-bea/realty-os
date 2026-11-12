// Admin → Gmail sync in jsdom on a scripted API (module 69): the Owner switch (disabled with the review
// sentence until platform:gmail is cleared), the backfill window (Owner only, 0–90), an Admin can only
// turn it off, re-auth, error sentences, no per-agent mailbox/token/sync state, axe.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient, App, buildRoutes, createQueryClient } from '../../../shell/index.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { MAIL_ERROR_MESSAGES } from '../../settings/mail/words.js';
import { type AdminMailView, packWords } from './AdminMailPage.js';
import { ADMIN_MAIL_PATH, surface } from './index.js';

const view = (over: Partial<AdminMailView> = {}): AdminMailView => ({
  enabled: false,
  backfillDays: 30,
  pack: { cleared: true, reviewedByCounsel: true, vendorReady: true, sentence: 'Cleared.' },
  canTurnOn: true,
  role: 'owner',
  ...over,
});

function mount(fake: FakeFetch, role: 'owner' | 'admin' | 'agent' = 'owner') {
  const s = sessionFixture({ reauthenticatedAt: new Date().toISOString() });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  const table = tableWith(surface);
  const router = createMemoryRouter(buildRoutes(table), { initialEntries: [ADMIN_MAIL_PATH] });
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false, staleTime: Infinity } });
  render(
    <StrictMode>
      <App api={new ApiClient({ fetch: fake.fetch })} table={table} router={router} queryClient={qc} />
    </StrictMode>,
  );
}

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('packWords', () => {
  it('says "not reviewed by counsel" and "waiting for Google verification" where true', () => {
    expect(packWords({ cleared: false, reviewedByCounsel: false, vendorReady: false, sentence: '' })).toBe("Gmail sync is not reviewed by counsel and waiting for Google verification, so it can't be turned on yet.");
    expect(packWords({ cleared: false, reviewedByCounsel: false, vendorReady: true, sentence: '' })).toBe("Gmail sync is not reviewed by counsel, so it can't be turned on yet.");
    expect(packWords({ cleared: false, reviewedByCounsel: true, vendorReady: false, sentence: '' })).toBe("Gmail sync is waiting for Google verification, so it can't be turned on yet.");
    expect(packWords({ cleared: false, reviewedByCounsel: true, vendorReady: true, sentence: 'Held by the platform.' })).toBe('Held by the platform.');
    expect(packWords({ cleared: true, reviewedByCounsel: true, vendorReady: true, sentence: '' })).toBe('Gmail sync is reviewed by counsel and verified by Google.');
  });
});

describe('Admin → Gmail sync', () => {
  it('uncleared: the switch is disabled and described by the review sentence; no axe violations', async () => {
    const pack = { cleared: false, reviewedByCounsel: false, vendorReady: false, sentence: 'Not cleared.' };
    mount(new FakeFetch().on('GET /admin/mail-sync', { status: 200, body: view({ pack, canTurnOn: false }) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Gmail sync' })).toBeVisible();
    const on = await screen.findByRole('button', { name: 'Turn Gmail sync on' });
    expect(on).toBeDisabled();
    expect(on).toHaveAccessibleDescription(packWords(pack));
    expect(screen.getByText(/not reviewed by counsel and waiting for Google verification/)).toBeVisible();
    expect(await violations()).toEqual([]);
  });

  it('the Owner turns it on (re-auth first) and the page says what that means', async () => {
    const fake = new FakeFetch()
      .on('GET /admin/mail-sync', { status: 200, body: view() })
      .on('PUT /admin/mail-sync', (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: view({ enabled: true }) }))
      .on('POST /auth/reauth', { status: 200, body: { session: sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, reauthenticatedAt: new Date().toISOString() }) } });
    mount(fake);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn Gmail sync on' }));
    const pw = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await userEvent.type(within(pw).getByLabelText('Password'), 'pw');
    await userEvent.click(within(pw).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/^Gmail sync is on\. Each person connects their own Gmail/)).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Gmail sync is on' })).toBeVisible();
    expect(fake.callsTo('PUT /admin/mail-sync').map((c) => c.body)).toEqual([
      { enabled: true, backfillDays: 30 },
      { enabled: true, backfillDays: 30 },
    ]);
  });

  it('the Owner sets the backfill window 0–90; out of range cannot be saved', async () => {
    const fake = new FakeFetch().on('GET /admin/mail-sync', { status: 200, body: view({ enabled: true }) }).on('PUT /admin/mail-sync', { status: 200, body: view({ enabled: true, backfillDays: 90 }) });
    mount(fake);
    const field = await screen.findByLabelText('Days of past mail to import when someone connects');
    await userEvent.clear(field);
    await userEvent.type(field, '91');
    expect(screen.getByText('Enter a number from 0 to 90.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '90');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. New connections import up to 90 days of past mail.')).toBeVisible();
    expect(fake.callsTo('PUT /admin/mail-sync').map((c) => c.body)).toEqual([{ enabled: true, backfillDays: 90 }]);
  });

  it('an Admin can only turn it off, and sees the window without changing it', async () => {
    const fake = new FakeFetch()
      .on('GET /admin/mail-sync', { status: 200, body: view({ enabled: true, role: 'admin', canTurnOn: false }) })
      .on('PUT /admin/mail-sync', { status: 200, body: view({ enabled: false, role: 'admin', canTurnOn: false }) });
    mount(fake, 'admin');
    expect(await screen.findByText('New connections import up to 30 days of past mail. Only the Owner can change this.')).toBeVisible();
    expect(screen.queryByLabelText(/Days of past mail/)).toBeNull();
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Turn Gmail sync off' }));
    expect(await screen.findByText(/^Gmail sync is off\./)).toBeVisible();
    expect(screen.getByText('Only the Owner can turn Gmail sync on.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Turn Gmail sync on' })).toBeNull();
  });

  it('a refused write is said in words (MAIL_SYNC_NOT_CLEARED, OWNER_REQUIRED), never as a code', async () => {
    for (const code of ['MAIL_SYNC_NOT_CLEARED', 'OWNER_REQUIRED']) {
      mount(new FakeFetch().on('GET /admin/mail-sync', { status: 200, body: view() }).on('PUT /admin/mail-sync', err(code === 'OWNER_REQUIRED' ? 403 : 409, code)));
      await userEvent.click(await screen.findByRole('button', { name: 'Turn Gmail sync on' }));
      expect(await screen.findByText(MAIL_ERROR_MESSAGES[code]!)).toBeVisible();
      expect(document.body.textContent).not.toContain(code);
      document.body.innerHTML = '';
    }
  });

  it('shows no per-agent mailbox, token or sync state', async () => {
    // even if a response carried more, the page renders only the fields of AdminMailView
    mount(new FakeFetch().on('GET /admin/mail-sync', { status: 200, body: { ...view({ enabled: true }), links: [{ mailboxAddress: 'ava@gmail.example', refreshToken: 'TOKEN-CANARY', lastSyncedAt: '2026-11-11T00:00:00Z' }] } }));
    await screen.findByRole('heading', { level: 2, name: 'Gmail sync is on' });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('@');
    expect(text).not.toContain('TOKEN-CANARY');
    expect(text).not.toMatch(/last synced/i);
  });

  it('is not shown to an agent', async () => {
    mount(new FakeFetch().on('GET /admin/mail-sync', { status: 200, body: view() }), 'agent');
    await screen.findByRole('main');
    expect(screen.queryByRole('button', { name: /Turn Gmail sync/ })).toBeNull();
  });
});
