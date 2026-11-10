// Search in jsdom: type-ahead from 2 characters with one request per settled query, pond/offer-card
// contacts labelled (R-PERM-6 display; the server never matches them on phone or email), and groups
// that hit the server's time limit reported as possibly incomplete instead of silently short.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp } from '../feed/lib/testing.js';
import type { SearchResponse } from '../feed/lib/types.js';

const empty: SearchResponse = { contacts: [], listings: [], deals: [], notes: [], messages: [], incomplete: [] };

describe('Search', () => {
  it('type-ahead: nothing is sent below 2 characters, and typing fast sends one request for the settled text', async () => {
    const fake = new FakeFetch().on('GET /search?q=jan', { status: 200, body: { ...empty, contacts: [{ id: IDS.jane, name: 'Jane Doe', view: 'full', ownershipState: 'owned', matchedOn: 'name' }] } });
    agentApp(fake, '/search');
    const u = userEvent.setup();
    const box = await screen.findByRole('searchbox');
    await u.type(box, 'j');
    expect(await screen.findByText('Type at least 2 characters.')).toBeInTheDocument();
    await u.type(box, 'an');
    const link = await screen.findByRole('link', { name: /Jane Doe/ });
    expect(link).toHaveAttribute('href', `/contacts/${IDS.jane}`);
    const searches = fake.calls.filter((c) => c.path.startsWith('/search'));
    expect(searches.map((c) => c.path)).toEqual(['/search?q=jan']);
  });

  it('finds a contact by phone digits and says what matched', async () => {
    const fake = new FakeFetch().on('GET /search?q=5550123', { status: 200, body: { ...empty, contacts: [{ id: IDS.jane, name: 'Jane Doe', view: 'full', ownershipState: 'owned', matchedOn: 'phone' }] } });
    agentApp(fake, '/search');
    await userEvent.setup().type(await screen.findByRole('searchbox'), '5550123');
    expect(await screen.findByText('Matched on phone')).toBeInTheDocument();
  });

  it('R-PERM-6: a pond/offer-card contact is labelled as such and shows no matched detail', async () => {
    const fake = new FakeFetch().on('GET /search?q=pat', { status: 200, body: { ...empty, contacts: [{ id: IDS.pat, name: 'Pat L.', view: 'card', ownershipState: 'in_pond', matchedOn: 'name' }] } });
    agentApp(fake, '/search');
    await userEvent.setup().type(await screen.findByRole('searchbox'), 'pat');
    expect(await screen.findByText('Pond or offer lead · claim or accept to see details')).toBeInTheDocument();
  });

  it('a group that hit the time limit is reported as possibly incomplete', async () => {
    const fake = new FakeFetch().on('GET /search?q=oak', { status: 200, body: { ...empty, listings: [{ id: '01900000-0000-7000-8000-0000000115e1', address: '12 Oak St', city: 'Oakland', status: 'active', listPriceCents: 85_000_000 }], incomplete: ['messages'] } });
    agentApp(fake, '/search');
    await userEvent.setup().type(await screen.findByRole('searchbox'), 'oak');
    expect(await screen.findByText('Some results may be missing: messages took too long to search.')).toBeInTheDocument();
    expect(screen.getByText('Oakland · active · $850,000')).toBeInTheDocument();
  });

  it('says plainly when nothing matched', async () => {
    const fake = new FakeFetch().on('GET /search?q=zz', { status: 200, body: empty });
    agentApp(fake, '/search');
    await userEvent.setup().type(await screen.findByRole('searchbox'), 'zz');
    await waitFor(() => expect(screen.getByText('No matches for “zz”.')).toBeInTheDocument());
  });
});
