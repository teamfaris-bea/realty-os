// The listing page's "Listing agent" control (b11 review api-ui/F8; R-OWN-22, R-PERM-15, E543, R-SELL-1) in jsdom on a
// scripted API. MEMBER_HAS_LISTINGS tells the Owner to change the listings' agent before making the member a TC, and
// the "no active listing agent" card says the same: this is where they do it (PATCH /listings/:id/agent,
// listing.reassign, Owner/Admin). The real API (fenced, audited writer) is tested in api leads/deactivationListings.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, err, iso } from '../feed/lib/testing.js';

const user = () => userEvent.setup();
const LISTING = '01900000-0000-7000-8000-0000000115b1';
const SAM = '01900000-0000-7000-8000-00000000a101';
const RIO = '01900000-0000-7000-8000-00000000a102';
const TESS = '01900000-0000-7000-8000-00000000a103';
const OLLIE = '01900000-0000-7000-8000-00000000a104';

function listing(over: Record<string, unknown> = {}) {
  return { id: LISTING, source: 'team', mlsNumber: null, status: 'active', addressLine1: '7 Pier Rd', addressLine2: null, city: 'Charleston', region: 'SC', postalCode: '29401', listPriceCents: 52_000_000, beds: 3, bathsX10: 20, sqft: 1600, propertyType: 'single_family', listingAgentUserId: SAM, description: null, listDate: null, editable: true, createdAt: iso(-1), priceHistory: [], contacts: [], showings: { total: 0, completed: 0, withFeedback: 0 }, ...over };
}

const member = (userId: string, displayName: string, role: string, status = 'active') => ({ userId, displayName, email: `${displayName.split(' ')[0]!.toLowerCase()}@example.test`, role, status, acceptingLeads: true, mfaEnabled: false, joinedAt: iso(-86_400_000), version: 1 });
const MEMBERS = [
  member(IDS.me, 'Ava Agent', 'owner'),
  member(SAM, 'Sam Seller', 'agent'),
  member(RIO, 'Rio Reyes', 'agent'),
  member(TESS, 'Tess Coordinator', 'tc'),
  member(OLLIE, 'Ollie Away', 'agent', 'suspended'),
];

function app(role: 'owner' | 'admin' | 'agent' | 'team_lead', l = listing(), extra: (f: FakeFetch) => FakeFetch = (f) => f) {
  const fake = extra(
    new FakeFetch()
      .on(`GET /listings/${LISTING}`, { status: 200, body: { listing: l } })
      .on(`GET /listings/${LISTING}/showings`, { status: 200, body: { showings: [] } })
      .on(`GET /listings/${LISTING}/seller-update`, { status: 200, body: { update: null, nextDueAt: null } })
      .on('GET /members', { status: 200, body: { members: MEMBERS } }),
  );
  agentApp(fake, `/listings/${LISTING}`, role);
  return fake;
}

const agentSection = async () => (await screen.findByRole('heading', { name: 'Listing agent' })).closest('section')!;

describe('Listing agent control (b11 review api-ui/F8)', () => {
  it('R-OWN-22 R-PERM-15 E543 (web): an Owner sees who the listing agent is and changes it; the choices are active members who can hold leads, never a TC or a suspended member', async () => {
    const fake = app('owner', listing(), (f) => f.on(`PATCH /listings/${LISTING}/agent`, (c) => ({ status: 200, body: { listing: listing({ listingAgentUserId: (c.body as { listingAgentUserId: string }).listingAgentUserId }) } })));
    const s = await agentSection();
    expect(await within(s).findByText('Sam Seller')).toBeInTheDocument();
    const pick = within(s).getByLabelText('New listing agent');
    const options = within(pick).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose a member', 'Ava Agent (you)', 'Rio Reyes']);
    expect(within(s).getByText('This changes who handles the listing in Realty OS, not the listing agreement.')).toBeInTheDocument();
    const go = within(s).getByRole('button', { name: 'Change listing agent' });
    expect(go).toBeDisabled();
    await user().selectOptions(pick, RIO);
    await user().click(go);
    expect(await within(s).findByText('Listing agent changed to Rio Reyes.')).toBeInTheDocument();
    expect(fake.callsTo(`PATCH /listings/${LISTING}/agent`).map((c) => c.body)).toEqual([{ listingAgentUserId: RIO }]);
    expect((await axe.run(s)).violations).toEqual([]);
  });

  it('R-PERM-15 (web): an agent or a Team Lead sees no control and the page reads no member list; an MLS listing has none either', async () => {
    for (const role of ['agent', 'team_lead'] as const) {
      const fake = app(role);
      await screen.findByRole('heading', { name: 'Listing' });
      expect(screen.queryByRole('heading', { name: 'Listing agent' })).toBeNull();
      expect(fake.callsTo('GET /members')).toEqual([]);
      document.body.innerHTML = '';
    }
    app('admin', listing({ source: 'mls', listingAgentUserId: null, editable: false }));
    await screen.findByRole('heading', { name: 'Listing' });
    expect(screen.queryByRole('heading', { name: 'Listing agent' })).toBeNull();
  });

  it('R-OWN-22 (web): a refusal says why in listing words', async () => {
    app('admin', listing(), (f) => f.on(`PATCH /listings/${LISTING}/agent`, err(409, 'ASSIGNEE_NOT_ELIGIBLE')));
    const s = await agentSection();
    await within(s).findByText('Sam Seller');
    await user().selectOptions(within(s).getByLabelText('New listing agent'), RIO);
    await user().click(within(s).getByRole('button', { name: 'Change listing agent' }));
    expect(await within(s).findByText("That person can't be a listing agent now (not active, or a TC). Choose someone else.")).toBeInTheDocument();
  });

  it('R-OWN-22 R-SELL-1 (web; b11 review api-ui/F8, API side): a 500 from the change says the agent was not changed and nothing was saved, never that it changed; the page still names the agent the listing has', async () => {
    const fake = app('owner', listing(), (f) => f.on(`PATCH /listings/${LISTING}/agent`, err(500, 'INTERNAL_ERROR')));
    const s = await agentSection();
    await within(s).findByText('Sam Seller');
    await user().selectOptions(within(s).getByLabelText('New listing agent'), RIO);
    await user().click(within(s).getByRole('button', { name: 'Change listing agent' }));
    expect(await within(s).findByText('The listing agent was not changed, and nothing was saved. If it happens again, this listing’s record needs a fix on our side.')).toBeInTheDocument();
    expect(within(s).queryByText(/Listing agent changed/)).toBeNull();
    expect(within(s).queryByText(/Try again in a moment/)).toBeNull();
    expect(within(s).getByText('Sam Seller')).toBeInTheDocument();
    // one request: a 500 is not retried behind the person's back
    expect(fake.callsTo(`PATCH /listings/${LISTING}/agent`).map((c) => c.body)).toEqual([{ listingAgentUserId: RIO }]);
  });
});
