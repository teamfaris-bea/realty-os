// axe-core over the lead-email pages rendered with realistic data, in the same way as
// surfaces/admin/a11y.test.tsx (WCAG 2.2 AA rules axe can check in jsdom; color contrast needs layout and
// is checked by the Playwright sweep, e2e/a11y/pages.ts lists /team/lead-email): Needs review with held
// emails (one expanded, one with the accept form open), Decided, the empty state, and Lead routing with
// a source whose email intake is on and one whose intake is off.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { member, settings } from '../admin/lib/testing.js';
import { FakeFetch, SRC, enabledInbox, inbox, leadEmailApp, review } from './testing.js';

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const SRC2 = '01900000-0000-7000-8000-00000000500b';
const noPoint = review({ id: '01900000-0000-7000-8000-0000000e1002', subject: 'Inquiry', canAccept: false, fields: null, receivedAt: '2026-11-11T16:00:00.000Z' });

function fake(held = [review(), noPoint]) {
  return new FakeFetch()
    .on('GET /lead-email/reviews?status=needs_review', { status: 200, body: { items: held, pendingCount: held.length } })
    .on('GET /lead-email/reviews?status=decided', { status: 200, body: { items: [review({ status: 'accepted', contactId: '01900000-0000-7000-8000-00000000c0c1', canAccept: false, decidedAt: '2026-11-11T16:30:00.000Z' })], pendingCount: held.length } })
    .on('GET /routing-rules', { status: 200, body: { rules: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } })
    .on('GET /members', { status: 200, body: { members: [member()], invites: [] } })
    .on('GET /settings', { status: 200, body: { settings } })
    .on('GET /lead-sources', {
      status: 200,
      body: {
        sources: [
          { id: SRC, name: 'Portal', kind: 'portal', active: true, hasToken: true, createdAt: '' },
          { id: SRC2, name: 'Website', kind: 'portal', active: true, hasToken: true, createdAt: '' },
        ],
      },
    })
    .on(`GET /lead-sources/${SRC}/lead-email`, { status: 200, body: { inbox: enabledInbox() } })
    .on(`GET /lead-sources/${SRC2}/lead-email`, { status: 200, body: { inbox: inbox({ leadSourceId: SRC2 }) } });
}

describe('accessibility (axe-core): lead email', () => {
  it('Needs review (/team/lead-email) with held emails, an excerpt open and the accept form open, has no axe violations', async () => {
    leadEmailApp(fake(), '/team/lead-email', 'team_lead');
    expect(await screen.findByRole('heading', { level: 1, name: 'Needs review' })).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click((await screen.findAllByText('Show the email'))[0]!);
    await u.click(screen.getByRole('button', { name: 'Accept: Inquiry' }));
    expect(screen.getByRole('form', { name: 'Accept as a lead' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('Needs review: the Decided tab and the empty state have no axe violations', async () => {
    leadEmailApp(fake([]), '/team/lead-email', 'owner');
    expect(await screen.findByText('Nothing needs review')).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Decided' }));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('Discard confirm on Needs review has no axe violations', async () => {
    leadEmailApp(fake(), '/team/lead-email', 'admin');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Discard: New lead for 12 Elm St' }));
    expect(screen.getByRole('dialog', { name: 'Discard this email?' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('Lead routing (/admin/routing) with email intake on for one source and off for another has no axe violations, nor does the new-address confirm', async () => {
    leadEmailApp(fake(), '/admin/routing', 'owner', { reauthenticatedAt: new Date().toISOString() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Lead routing' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Inbound address for Portal')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Turn on lead email' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    const portal = screen.getAllByRole('article').find((a) => within(a).queryByRole('heading', { level: 3, name: /Portal/ }))!;
    await userEvent.setup().click(within(portal).getByRole('button', { name: 'Get a new address' }));
    expect(screen.getByRole('dialog', { name: 'Get a new address?' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });
});
