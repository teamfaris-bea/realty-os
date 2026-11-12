// axe-core over the Lead sources pages with realistic data, as surfaces/admin/a11y.test.tsx does (WCAG 2.2 AA rules
// axe can check in jsdom; contrast needs layout and is checked by the Playwright sweep, e2e/a11y/pages.ts lists both
// pages): the list, the Add a source sheet, a source with every path open, the off confirm, and the agent-forwarding
// guide.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { enabledInbox } from '../lead-email/testing.js';
import { ADDR, GKEY, S1, S2, googleForm, overview, phone, source, sourcesApp, sourcesFake } from './testing.js';

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const on = source({
  id: S1,
  name: 'Zillow',
  lastLeadAt: new Date(Date.now() - 7_200_000).toISOString(),
  leadsLast30Days: 14,
  heldEmails: 2,
  hasConsentText: true,
  paths: {
    email: { state: 'on', address: ADDR, lastEmailAt: null },
    googleLeadForm: { state: 'on', createdAt: '2026-11-12T10:00:00.000Z', inquiryType: 'value', citesSourceDisclosure: true, lastTestAt: '2026-11-12T10:05:00.000Z', lastUnreadableAt: null, unreadableCount: 0 },
    trackingNumbers: [{ id: 'n1', e164: '+14155550100' }],
    partnerFeeds: [{ kind: 'zillow_feed', status: 'pending' }],
  },
});
const plain = source({ id: S2, name: 'Yard signs', kind: 'sign_call' });

function fake() {
  return sourcesFake(overview([on, plain]))
    .on(`GET /lead-sources/${S1}/lead-email`, { status: 200, body: { inbox: enabledInbox({ leadSourceId: S1, address: ADDR }) } })
    .on(`GET /lead-sources/${S1}/google-lead-form`, { status: 200, body: googleForm({ state: 'on', key: GKEY, inquiryType: 'value', citesSourceDisclosure: true, sourceHasConsentText: true, lastTestAt: '2026-11-12T10:05:00.000Z' }) })
    .on('GET /numbers', { status: 200, body: { numbers: [phone({ leadSourceId: S1 }), phone({ id: 'n2', e164: '+14155550122' })] } });
}

describe('accessibility (axe-core): lead sources', () => {
  it('the list and the Add a source sheet have no axe violations', async () => {
    sourcesApp(fake(), '/admin/lead-sources', 'owner');
    expect(await screen.findByRole('heading', { level: 2, name: 'Zillow' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add a source' }));
    expect(screen.getByRole('dialog', { name: 'Add a source' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('a source with every path open, then the off confirm, have no axe violations', async () => {
    sourcesApp(fake(), `/admin/lead-sources/${S1}`, 'owner');
    expect(await screen.findByLabelText('Inbound address for Zillow')).toBeInTheDocument();
    for (const d of document.querySelectorAll('details')) d.open = true;
    expect(await screen.findByLabelText('Key')).toHaveValue(GKEY);
    expect(await violations()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn off' }));
    expect(screen.getByRole('dialog', { name: 'Turn off Zillow?' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('the agent-forwarding guide has no axe violations', async () => {
    sourcesApp(fake(), '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add a source' }));
    const add = within(screen.getByRole('dialog', { name: 'Add a source' }));
    await u.click(add.getByRole('radio', { name: /An agent's forwarded email/ }));
    await u.click(add.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('dialog', { name: "An agent's forwarded email" })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });
});
