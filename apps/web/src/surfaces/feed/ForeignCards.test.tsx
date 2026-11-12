// Phase 2/3 cards in the Priority Feed (module 18a), in jsdom on a scripted API. They are written by their
// owning modules under their own key families; the feed shows each with its label and one primary action,
// reachable in one tap: the listing, contact, weekly plan and daily tip pages. A marketing review whose piece has
// no listing the viewer can open is the one card that opens its own lines in place (show_details; batch 7 review
// ui/F9). The same cards run against the real API in e2e/feed/cards.spec.ts.
import { FEED_ITEM_TYPES, FOREIGN_CARD_LABEL, FOREIGN_FEED_ITEM_TYPES } from '@realty/core/priority';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ITEM_LABEL, itemLabel } from './lib/format.js';
import { FakeFetch, IDS, agentApp, card, feed } from './lib/testing.js';

const user = () => userEvent.setup();
const LISTING = '01900000-0000-7000-8000-0000000115a1';

const foreign = () => ({
  seller: card({ itemType: 'seller_update', contact: { id: IDS.jane, name: 'Jane Doe' }, reasons: [{ code: 'SELLER_UPDATE_READY', label: 'This week’s update for 12 Oak St is ready' }], primaryAction: { kind: 'open_listing', label: 'Open listing', listingId: LISTING } }),
  marketing: card({ itemType: 'marketing_review', contact: null, reasons: [{ code: 'MARKETING_DRAFT', label: 'A social post draft is ready for your review' }], primaryAction: { kind: 'open_listing', label: 'Open listing', listingId: LISTING } }),
  plan: card({ itemType: 'weekly_plan', contact: null, reasons: [{ code: 'PLAN_ITEM', label: 'Call back last weekend’s leads' }, { code: 'PLAN_ITEM', label: 'Log outcomes for your consults' }], primaryAction: { kind: 'open_plan', label: 'See the plan', week: '2026-W46' } }),
  tip: card({ itemType: 'coaching_fix', contact: null, reasons: [{ code: 'COACHING_FIX', label: 'Ask about their timeline before the price' }], primaryAction: { kind: 'open_coaching_fix', label: 'See the tip' } }),
  // api/workspace/feed.ts foreignActions: a marketing piece with no listing opens its details in place
  marketingNoListing: card({ itemType: 'marketing_review', contact: null, reasons: [{ code: 'MARKETING_DRAFT', label: 'A post about your open house is ready for your review' }], primaryAction: { kind: 'show_details', label: 'See details' } }),
  likely: card({ itemType: 'likely_to_move', contact: { id: IDS.pat, name: 'Pat Lee' }, reasons: [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home for many years' }], primaryAction: { kind: 'open_contact', label: 'Open contact', contactId: IDS.pat } }),
});

const articleOf = async (label: string) => (await screen.findByText(label)).closest('article') as HTMLElement;

describe('Phase 2/3 cards', () => {
  it('every card type core can store has a label, and the five foreign ones match core/priority FOREIGN_CARD_LABEL', () => {
    for (const t of FEED_ITEM_TYPES) expect(ITEM_LABEL[t]).toBeTruthy();
    for (const t of FOREIGN_FEED_ITEM_TYPES) expect(itemLabel(t)).toBe(FOREIGN_CARD_LABEL[t]);
  });

  it('each of the five card types shows its label and a primary action; the feed adds no score or number', async () => {
    const { marketingNoListing: _inPlace, ...five } = foreign();
    agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], Object.values(five)) }));
    for (const [label, action] of [
      ['Seller update to review', 'Open listing'],
      ['Marketing to review', 'Open listing'],
      ['Your plan this week', 'See the plan'],
      ["Today's coaching tip", 'See the tip'],
      ['May be thinking of moving', 'Open contact'],
    ] as const) {
      expect(within(await articleOf(label)).getByRole('button', { name: action })).toBeEnabled();
    }
    expect(screen.getByRole('main').textContent).not.toMatch(/confidence|probability|score|%/i);
  });

  it('open_plan (weekly plan) is 1 tap to that week’s plan page', async () => {
    const f = foreign();
    const { router } = agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [f.plan]) }));
    await user().click(within(await articleOf('Your plan this week')).getByRole('button', { name: 'See the plan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/plan/2026-W46'));
  });

  it('open_listing is 1 tap to the listing page; open_contact (likely to move) is 1 tap to the contact', async () => {
    const f = foreign();
    const { router } = agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [f.seller, f.likely]) }));
    const u = user();
    await u.click(within(await articleOf('Seller update to review')).getByRole('button', { name: 'Open listing' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/listings/${LISTING}`));
    await act(async () => {
      await router.navigate('/');
    });
    await u.click(within(await articleOf('May be thinking of moving')).getByRole('button', { name: 'Open contact' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.pat}`));
  });

  it('b7 ui/F9: open_coaching_fix (the daily tip) is 1 tap to the /coaching page', async () => {
    const f = foreign();
    const { router } = agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [f.tip]) }));
    await user().click(within(await articleOf("Today's coaching tip")).getByRole('button', { name: 'See the tip' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/coaching'));
  });

  it('b7 ui/F9: show_details (a marketing review with no listing to open) opens the card’s own lines in place in 1 tap (aria-expanded), with no duplicate "Why this" toggle; axe finds nothing', async () => {
    const f = foreign();
    agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [f.plan, f.marketingNoListing]) }));
    const article = await articleOf('Marketing to review');
    const see = within(article).getByRole('button', { name: 'See details' });
    expect(see).toHaveAttribute('aria-expanded', 'false');
    expect(within(article).queryByRole('button', { name: 'Why this' })).toBeNull();
    await user().click(see);
    const details = within(article).getByRole('list', { name: 'Details' });
    expect(within(details).getByText('A post about your open house is ready for your review')).toBeInTheDocument();
    expect(see).toHaveAttribute('aria-expanded', 'true');
    expect(see).toHaveAttribute('aria-controls', details.id);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
