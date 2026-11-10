// Pond in jsdom: masked cards with one-tap Claim (R-PERM-6 display: the card fields only), the claim
// race loser's sentence (E1 display), and which ponds each role is shown.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, card, err, feed, pondCard } from '../feed/lib/testing.js';
import { pondIdsFromFeed } from './PondPage.js';

const pondFeed = () => feed([], [card({ itemType: 'pond_new', contact: { id: IDS.pat, name: 'Pat L.' }, primaryAction: { kind: 'claim', label: 'Claim', contactId: IDS.pat, pondId: IDS.pond } })]);

describe('Pond', () => {
  it('finds the ponds named by claim actions in the feed', () => {
    expect(pondIdsFromFeed(pondFeed())).toEqual([IDS.pond]);
    expect(pondIdsFromFeed(undefined)).toEqual([]);
  });

  it('R-PERM-6: pond cards show only card fields; Claim is one tap; losing the race says so', async () => {
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: pondFeed() })
      .on(`GET /ponds/${IDS.pond}/cards?limit=50`, { status: 200, body: { pond: { id: IDS.pond, name: 'Team pond', claimable: true }, cards: [pondCard()], nextCursor: null } })
      .on(`POST /leads/${IDS.pat}/claim`, err(409, 'LEAD_ALREADY_CLAIMED', { observedSeq: 7 }));
    agentApp(fake, '/pond');
    const cardEl = (await screen.findByRole('heading', { level: 3, name: 'Pat L.' })).closest('article')!;
    expect(within(cardEl).getByText('Buyer · 94110 · $600k–$800k')).toBeInTheDocument();
    expect(cardEl.textContent).not.toMatch(/\+1\d{10}|@/);
    await userEvent.setup().click(within(cardEl).getByRole('button', { name: 'Claim' }));
    expect(await within(cardEl).findByRole('alert')).toHaveTextContent('Someone else claimed this lead just now.');
    expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)).toHaveLength(1);
  });

  it('Owner/Admin see every pond from the pond list', async () => {
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed() })
      .on('GET /ponds', { status: 200, body: { ponds: [{ id: IDS.pond, name: 'Team pond' }] } })
      .on(`GET /ponds/${IDS.pond}/cards?limit=50`, { status: 200, body: { pond: { id: IDS.pond, name: 'Team pond', claimable: false }, cards: [pondCard()], nextCursor: null } });
    agentApp(fake, '/pond', 'owner');
    expect(await screen.findByText("You can't claim from this pond.")).toBeInTheDocument();
    expect(fake.callsTo('GET /ponds').length).toBeGreaterThanOrEqual(1);
  });

  it('an agent is never sent to the admin pond list; with no pond leads in the feed the page says so', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed() });
    agentApp(fake, '/pond');
    expect(await screen.findByText('No pond leads to claim right now')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo('GET /ponds')).toHaveLength(0));
  });

  it('a transaction coordinator is not shown the pond (TCs never claim leads)', async () => {
    agentApp(new FakeFetch(), '/pond', 'tc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
  });
});
