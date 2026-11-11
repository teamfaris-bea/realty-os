// Pond in jsdom: masked cards with one-tap Claim (R-PERM-6 display: the card fields only), the claim
// race loser's sentence (E1 display), which ponds each role is shown (R-OWN-16: exactly the ponds the member
// may claim from, GET /me/ponds), and why a member whose own totals block a claim sees no cards.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, err, findToast, pondCard } from '../feed/lib/testing.js';
import type { MyPondsResponse } from '../feed/lib/types.js';
import { blockedSentence } from './PondPage.js';

const myPonds = (over: Partial<MyPondsResponse['ponds'][number]> = {}, me: Partial<MyPondsResponse> = {}): MyPondsResponse => ({
  ponds: [{ id: IDS.pond, name: 'Team pond', isDefault: true, claimsPerDay: 5, blockedBy: null, ...over }],
  claimsToday: 0,
  uncontactedOwned: 0,
  capacityCap: 5,
  ...me,
});

describe('Pond', () => {
  it("R-OWN-16: says why the member's own totals block a claim, with the numbers it rests on", () => {
    const me = { claimsToday: 5, uncontactedOwned: 5, capacityCap: 5 };
    expect(blockedSentence(myPonds().ponds[0]!, me)).toBeNull();
    expect(blockedSentence(myPonds({ blockedBy: 'CLAIM_LIMIT_REACHED' }).ponds[0]!, me)).toBe("You've claimed 5 of the 5 leads this pond allows a day. You can claim from it again tomorrow.");
    expect(blockedSentence(myPonds({ blockedBy: 'CAPACITY_REACHED' }).ponds[0]!, me)).toBe('5 of your leads are still waiting for a first call, text or email (the most is 5). Reach one of them before claiming more.');
  });

  it('R-PERM-6: pond cards show only card fields; Claim is one tap; losing the race says so', async () => {
    let lost = false;
    const fake = new FakeFetch()
      .on('GET /me/ponds', { status: 200, body: myPonds() })
      // once the late claim was answered, the refresh no longer lists the lead (someone else owns it now)
      .on(`GET /ponds/${IDS.pond}/cards?limit=50`, () => ({ status: 200, body: { pond: { id: IDS.pond, name: 'Team pond', claimable: true }, cards: lost ? [] : [pondCard()], nextCursor: null } }))
      .on(`POST /leads/${IDS.pat}/claim`, () => {
        lost = true;
        return err(409, 'LEAD_ALREADY_CLAIMED', { observedSeq: 7 });
      });
    agentApp(fake, '/pond');
    const cardEl = (await screen.findByRole('heading', { level: 3, name: 'Pat L.' })).closest('article')!;
    expect(within(cardEl).getByText('Buyer · 94110 · $600k–$800k')).toBeInTheDocument();
    expect(cardEl.textContent).not.toMatch(/\+1\d{10}|@/);
    await userEvent.setup().click(within(cardEl).getByRole('button', { name: 'Claim' }));
    expect(await findToast('Someone else claimed this lead just now.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)).toHaveLength(1);
    // journey J2: the card goes away with the refresh, and the loser can still read why
    await waitFor(() => expect(screen.queryByRole('heading', { level: 3, name: 'Pat L.' })).toBeNull());
    expect(within(screen.getByTestId('toast')).getByText('Someone else claimed this lead just now.')).toBeVisible();
  });

  it('Owner/Admin see every pond from the pond list', async () => {
    const fake = new FakeFetch()
      .on('GET /ponds', { status: 200, body: { ponds: [{ id: IDS.pond, name: 'Team pond' }] } })
      .on(`GET /ponds/${IDS.pond}/cards?limit=50`, { status: 200, body: { pond: { id: IDS.pond, name: 'Team pond', claimable: false }, cards: [pondCard()], nextCursor: null } });
    agentApp(fake, '/pond', 'owner');
    expect(await screen.findByText("You can't claim from this pond.")).toBeInTheDocument();
    expect(fake.callsTo('GET /ponds').length).toBeGreaterThanOrEqual(1);
    expect(fake.callsTo('GET /me/ponds')).toHaveLength(0);
  });

  it('R-OWN-16: an agent sees exactly the ponds they may claim from (never the admin pond list); with none the page says so', async () => {
    const fake = new FakeFetch().on('GET /me/ponds', { status: 200, body: myPonds({}, { ponds: [] }) });
    agentApp(fake, '/pond');
    expect(await screen.findByText('No pond leads to claim right now')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo('GET /ponds')).toHaveLength(0));
  });

  it("R-OWN-16: a pond where the member's own totals block a claim says why and lists no leads", async () => {
    const fake = new FakeFetch().on('GET /me/ponds', { status: 200, body: myPonds({ blockedBy: 'CLAIM_LIMIT_REACHED' }, { claimsToday: 5 }) });
    agentApp(fake, '/pond');
    const section = (await screen.findByRole('heading', { level: 2, name: 'Team pond' })).closest('section')!;
    expect(within(section).getByText("You've claimed 5 of the 5 leads this pond allows a day. You can claim from it again tomorrow.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull();
    expect(fake.callsTo(`GET /ponds/${IDS.pond}/cards?limit=50`)).toHaveLength(0);
  });

  it('a transaction coordinator is not shown the pond (TCs never claim leads)', async () => {
    agentApp(new FakeFetch(), '/pond', 'tc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
  });
});
