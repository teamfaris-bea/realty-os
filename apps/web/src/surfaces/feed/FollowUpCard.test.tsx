// R-TODAY-1, R-TODAY-2 (web): a follow-up card on Today says why the person is due, what was last discussed and the
// next promise. An automated message is never the "Last" line; a person with no history says "No conversation yet.".
import { screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, card, feed, reachability } from './lib/testing.js';
import type { FeedCard } from './lib/types.js';

const at = (daysAgo: number, h = 14, m = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const later = (h: number) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

function promiseCard(over: Partial<FeedCard> = {}): FeedCard {
  return card({
    itemType: 'promise_due',
    contact: { id: IDS.jane, name: 'Dana Reyes' },
    task: { id: IDS.task, title: 'Send lender intro' },
    reasons: [{ code: 'PROMISE_DUE', label: 'You promised this; due in 3 h' }],
    primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane },
    alternatives: [{ kind: 'complete_task', label: 'Done', taskId: IDS.task }],
    subjectType: 'task',
    subjectId: IDS.task,
    why: ['You promised this; due in 3 h'],
    stage: { key: 'connected', label: 'Connected' },
    lastTouch: { kind: 'call', at: at(2), byName: 'Ava Agent', byMe: true, direction: 'outbound', outcome: 'talked 6 min', snippet: null, reported: false },
    lastAutomatic: null,
    importedHistoryAt: null,
    nextPromise: { taskId: IDS.task, text: 'Send lender intro', kind: 'promise', dueAt: later(23), dueAllDay: false, overdue: false },
    ...over,
  });
}

function open(c: FeedCard) {
  const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [c]) }).on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } });
  agentApp(fake);
  return fake;
}
const lines = async () => within(await screen.findByRole('article', { name: 'Dana Reyes' })).getByTestId('follow-up-lines');

describe('R-TODAY-1: a follow-up card on Today', () => {
  it('says why they are due, what was last discussed and the next promise, each on its own labelled line', async () => {
    open(promiseCard());
    const l = await lines();
    const row = (term: string) => within(l).getByText(term).closest('div')!;
    expect(within(row('Due')).getByText('You promised this; due in 3 h')).toBeInTheDocument();
    expect(row('Last')).toHaveTextContent(/^Last\s*Call \w+, talked 6 min$/);
    expect(row('Next')).toHaveTextContent(/^Next\s*Send lender intro, today 11:00 PM$/);
    // the stage, with the team's own label, beside the kind of card
    const stage = within(await screen.findByRole('article', { name: 'Dana Reyes' })).getByTestId('card-stage');
    expect(stage).toHaveTextContent('Connected');
    expect(stage.parentElement!.parentElement).toHaveTextContent(/^You promised this· Connected$/);
    // the kind of card is still its own element, found by its exact words
    expect(within(await screen.findByRole('article', { name: 'Dana Reyes' })).getByText('You promised this')).toBeInTheDocument();
    // the reason is said once, not also as the old loose line under the name
    expect(screen.getAllByText('You promised this; due in 3 h')).toHaveLength(1);
  });

  it('R-TODAY-2: only an automatic text: "No conversation yet." and the automatic text as its own line, never as the Last line', async () => {
    open(promiseCard({ lastTouch: null, lastAutomatic: { kind: 'text', at: at(2), bulk: false } }));
    const l = await lines();
    const last = within(l).getByText('Last').closest('div')!;
    expect(last).toHaveTextContent(/^Last\s*No conversation yet\.$/);
    const auto = within(l).getByText(/^Automatic text sent \w+$/);
    expect(last).not.toContainElement(auto);
  });

  it('a person with no history says "No conversation yet." and "No next step set."', async () => {
    open(promiseCard({ lastTouch: null, nextPromise: null }));
    const l = await lines();
    expect(within(l).getByText('No conversation yet.')).toBeInTheDocument();
    expect(within(l).getByText('No next step set.')).toBeInTheDocument();
    expect(within(l).queryByText(/Automatic/)).toBeNull();
  });

  it('R-TODAY-4: a logged outside call reads "Logged by you: called from your phone, …", never as a call the system placed', async () => {
    open(promiseCard({ lastTouch: { kind: 'call', at: at(1), byName: 'Ava Agent', byMe: true, direction: 'outbound', outcome: 'left a voicemail', snippet: null, reported: true } }));
    const l = await lines();
    expect(within(l).getByText(/^Logged by you: called from your phone, left a voicemail \(yesterday 2:10 PM\)$/)).toBeInTheDocument();
  });

  it('an overdue promise is said as overdue, in words (not by colour alone)', async () => {
    open(promiseCard({ nextPromise: { taskId: IDS.task, text: 'Send lender intro', kind: 'promise', dueAt: at(2, 9, 0), dueAllDay: false, overdue: true } }));
    expect(within(await lines()).getByText(/^Send lender intro, overdue since \w+ 9:00 AM$/)).toBeInTheDocument();
  });

  it('a 24-character stage label and a long snippet wrap; nothing is cut off', async () => {
    open(promiseCard({ stage: { key: 'attempting', label: 'Trying to reach them now' }, lastTouch: { kind: 'note', at: at(3), byName: 'Ava Agent', byMe: true, direction: null, outcome: null, snippet: 'Wants three bedrooms near the park with a yard for the dog, and the pre-approval letter should arrive next week from the lender.', reported: false } }));
    const article = await screen.findByRole('article', { name: 'Dana Reyes' });
    const stage = within(article).getByText(/Trying to reach them now/);
    expect(stage.className).not.toMatch(/truncate|line-clamp|text-ellipsis|whitespace-nowrap/);
    const l = await lines();
    for (const el of l.querySelectorAll('*')) expect(el.className).not.toMatch(/truncate|line-clamp|text-ellipsis|whitespace-nowrap/);
    expect(within(l).getByText(/pre-approval letter should arrive next week from the lender\.”$/)).toBeInTheDocument();
  });

  it('a card that is not about following up with a person shows no such lines', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [card({ itemType: 'deal_date', contact: null, reasons: [{ code: 'DEAL_DATE_TODAY', label: 'Inspection date is today' }], primaryAction: { kind: 'open_deal', label: 'Open deal', dealId: IDS.deal } })]) });
    agentApp(fake);
    await screen.findByRole('heading', { level: 3, name: 'Inspection date is today' });
    expect(screen.queryByTestId('follow-up-lines')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    open(promiseCard({ lastAutomatic: { kind: 'email', at: at(1), bulk: true } }));
    await lines();
    const r = await axe.run(document.body, { rules: { region: { enabled: false }, 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

// b19 Today fix 5 (M8; R-TODAY-16): a card about a person the viewer cannot open (the server sends it undecorated,
// with the masked name) draws no follow-up line and offers no Log: nothing the server would refuse, nothing it did not say.
describe('M8 (R-TODAY-16): a card about a person the viewer cannot open', () => {
  it('W3: the pond member’s task card: the masked name, the task, its reason; no Last, no Next, no Log, no Call or Text', async () => {
    const c = card({
      itemType: 'task_due',
      contact: { id: IDS.jane, name: 'Sol M.' },
      task: { id: IDS.task, title: 'Chase the paperwork' },
      reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 1 min' }],
      primaryAction: { kind: 'open_task', label: 'Open task', taskId: IDS.task },
      alternatives: [{ kind: 'complete_task', label: 'Done', taskId: IDS.task }],
      subjectType: 'task',
      subjectId: IDS.task,
      why: null,
      stage: null,
      lastTouch: null,
      nextPromise: null,
      quiet: null,
    });
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [c]) }).on('GET /reachability', { status: 200, body: { contacts: [] } });
    agentApp(fake);
    const a = await screen.findByRole('article', { name: 'Sol M.' });
    expect(within(a).getByText('Chase the paperwork')).toBeInTheDocument();
    expect(within(a).getByText('Overdue by 1 min')).toBeInTheDocument();
    expect(within(a).queryByTestId('follow-up-lines')).toBeNull();
    for (const term of ['Last', 'Next', 'Due']) expect(within(a).queryByText(term, { selector: 'dt' })).toBeNull();
    expect(within(a).queryByText(/No conversation yet|No next step set/)).toBeNull();
    for (const name of [/^Log/, 'Call', 'Text', 'Email']) expect(within(a).queryByRole('button', { name })).toBeNull();
    // the name still leads to their card, where what the viewer may do (claim) is said
    expect(within(a).getByRole('link', { name: 'Sol M.' })).toHaveAttribute('href', `/contacts/${IDS.jane}`);
  });
});
