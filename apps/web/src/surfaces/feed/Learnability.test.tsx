// R-TODAY-8 (web): empty, loading and error states of the warm follow-up work, in plain words. No tutorial overlay
// anywhere: a first-time agent reads what a thing is where it is.
//   - "Follow up today", nobody due: FollowUpToday.test.tsx
//   - the person picker of "Log a call or conversation": QuickLog.test.tsx
//   - here: the text sheet opened from a card while the person is read, when the read fails, and for a person the
//     viewer sees only as a card; the Log sheet's own first line; a card whose history could not be said.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { detailsFixture } from '../people-edit/testing.js';
import { FakeFetch, IDS, agentApp, card, err, feed, fullContact, pondCard, reachability } from './lib/testing.js';
import type { FeedCard } from './lib/types.js';

function textCard(over: Partial<FeedCard> = {}): FeedCard {
  return card({
    itemType: 'unanswered_inbound',
    contact: { id: IDS.jane, name: 'Dana Reyes' },
    reasons: [{ code: 'CLIENT_WAITING', label: 'They texted 20 min ago; no reply yet' }],
    primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane },
    why: ['They texted 20 min ago; no reply yet'],
    stage: { key: 'connected', label: 'Connected' },
    ...over,
  });
}

function open(contact: 'hold' | 'error' | 'card' | 'full', c: FeedCard = textCard()) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let fail = contact === 'error';
  const fake = new FakeFetch()
    .on('GET /feed', { status: 200, body: feed([], [c]) })
    .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } })
    .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: reachability(IDS.jane) })
    .on('GET /assistant/inbox', { status: 200, body: { items: [], total: 0 } })
    .on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details: detailsFixture(IDS.jane, 'connected') } })
    .on(`GET /contacts/${IDS.jane}`, async () => {
      if (contact === 'hold') await gate;
      if (fail) return err(500, 'INTERNAL_ERROR');
      return { status: 200, body: { contact: contact === 'card' ? pondCard({ id: IDS.jane, displayName: 'Dana R.' }) : fullContact({ displayName: 'Dana Reyes', firstName: 'Dana', lastName: 'Reyes' }) } };
    });
  agentApp(fake);
  return { fake, release, recover: () => (fail = false), u: userEvent.setup() };
}

const theCard = () => screen.findByRole('article', { name: 'Dana Reyes' });

describe('R-TODAY-8: plain words while a thing loads, when it fails, and when there is nothing', () => {
  it('Text from a card: "Loading" while the person is read, then the same compose box', async () => {
    const { release, u } = open('hold');
    await u.click(within(await theCard()).getByRole('button', { name: 'Text' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Dana Reyes' });
    expect(within(sheet).getByText('Loading')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    release();
    // (the loading sheet is replaced by the text sheet: the box is looked for on the page, then placed in its sheet)
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    expect(screen.getByRole('dialog', { name: 'Text Dana Reyes' })).toContainElement(box);
  });

  it('E858: when the person cannot be read the sheet says so and offers Try again; nothing is sent, and the page is still Today', async () => {
    const { fake, recover, u } = open('error');
    await u.click(within(await theCard()).getByRole('button', { name: 'Text' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Dana Reyes' });
    expect(await within(sheet).findByText("Can't open Dana Reyes")).toBeInTheDocument();
    expect(within(sheet).queryByRole('textbox')).toBeNull();
    recover();
    await u.click(within(sheet).getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('dialog', { name: 'Text Dana Reyes' })).toContainElement(await screen.findByRole('textbox', { name: 'Text message' }));
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });

  it('E858: a person the viewer sees only as a card cannot be texted from here, and the sheet says why instead of an empty box', async () => {
    const { u } = open('card');
    await u.click(within(await theCard()).getByRole('button', { name: 'Text' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Dana Reyes' });
    expect(await within(sheet).findByText('You can text Dana Reyes once they are yours. Open their card to see what you can do now.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('textbox')).toBeNull();
  });

  it('the Log sheet says what it is in its first line, where it opens: something outside the app, shown as logged by you, not counted as reaching them', async () => {
    const { u } = open('full');
    await u.click(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    expect(sheet).toHaveAccessibleDescription('Something that happened outside Realty OS. It shows as logged by you and doesn’t count as reaching Dana.');
    // and what each thing does is on it, not in a tour: the three kinds, who called whom, the outcomes, when
    for (const group of ['What happened', 'Direction', 'Outcome', 'When, quickly']) expect(within(sheet).getByRole('group', { name: group })).toBeInTheDocument();
  });

  it('the Log button says in full what it does to a screen reader, and shows a short word', async () => {
    open('full');
    const b = within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' });
    expect(b).toHaveTextContent(/^Log$/);
  });

  it('"Follow up today" says what it is under its heading, in one line, and the group is described by it', async () => {
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: { ...feed(), followUpToday: { people: [{ ...textCard({ id: IDS.jane, itemType: 'warm_follow_up' }), taskIds: [] }], total: 1, totalIsMinimum: false } } })
      .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } });
    agentApp(fake);
    const group = await screen.findByRole('region', { name: 'Follow up today' });
    expect(group).toHaveAccessibleDescription('People you promised to get back to, and people you have talked with who have gone quiet.');
    expect(within(group).getByText('People you promised to get back to, and people you have talked with who have gone quiet.')).toBeInTheDocument();
  });

  it('no tutorial, tour or overlay opens by itself on Today', async () => {
    open('full');
    await theCard();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/tour|tutorial|got it|next tip/i)).toBeNull();
  });
});
