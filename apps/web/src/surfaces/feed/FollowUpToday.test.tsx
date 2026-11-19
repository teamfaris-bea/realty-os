// R-TODAY-6 / R-TODAY-8 (web): the "Follow up today" group on Today. A list of people with a reason each, between
// "Due now" and "Next up"; a person is shown once; the count has its denominator; the empty state is in plain words.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, card, err, feed, offerCard, reachability } from './lib/testing.js';
import type { FeedCard, FeedResponse, FollowUpTodayCard } from './lib/types.js';

const NOBODY = 'Nobody is due today. People you promise to follow up with will show here.';

function person(over: Partial<FollowUpTodayCard> = {}): FollowUpTodayCard {
  return {
    ...card({
      id: IDS.jane,
      itemType: 'warm_follow_up',
      contact: { id: IDS.jane, name: 'Dana Reyes' },
      reasons: [{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }],
      primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane },
      alternatives: [{ kind: 'text', label: 'Text', contactId: IDS.jane }, { kind: 'open_contact', label: 'Open', contactId: IDS.jane }],
      subjectType: 'contact',
      subjectId: IDS.jane,
      why: ['Connected: no conversation for 9 days'],
      stage: { key: 'connected', label: 'Connected' },
    }),
    taskIds: [],
    ...over,
  };
}

function withPlan(f: FeedResponse, people: FollowUpTodayCard[], total = people.length, totalIsMinimum = false): FeedResponse {
  return { ...f, followUpToday: { people, total, totalIsMinimum } };
}

function open(body: FeedResponse) {
  const fake = new FakeFetch().on('GET /feed', { status: 200, body }).on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane), reachability(IDS.pat)] } });
  agentApp(fake);
  return fake;
}
const group = () => screen.findByRole('region', { name: 'Follow up today' });

describe('R-TODAY-6: "Follow up today" on Today', () => {
  it('sits between "Due now" and "Next up", and lists each person with their reason and the three lines', async () => {
    open(withPlan(feed([offerCard()], [card({ contact: { id: IDS.pat, name: 'Pat L.' }, primaryAction: { kind: 'text', label: 'Text', contactId: IDS.pat } })]), [person()]));
    const g = await group();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Due now', 'Follow up today', 'Next up']);
    const row = within(g).getByRole('article', { name: 'Dana Reyes' });
    expect(within(row).getByText('Connected: no conversation for 9 days')).toBeInTheDocument();
    expect(within(row).getByText('No conversation yet.')).toBeInTheDocument();
    expect(within(row).getByText('No next step set.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Call' })).toBeEnabled();
    // a row of the plan is not a stored card: nothing to snooze or dismiss
    expect(within(row).queryByRole('button', { name: 'Later' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('E854: a person due by a task is shown once: their task’s own card leaves "Next up" for the row', async () => {
    const taskCard: FeedCard = card({ itemType: 'task_due', contact: { id: IDS.jane, name: 'Dana Reyes' }, task: { id: IDS.task, title: 'Send the comps' }, reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 3 h' }], primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, subjectType: 'task', subjectId: IDS.task });
    const other = card({ contact: { id: IDS.pat, name: 'Pat L.' }, primaryAction: { kind: 'text', label: 'Text', contactId: IDS.pat } });
    open(withPlan(feed([], [taskCard, other]), [person({ itemType: 'task_due', task: { id: IDS.task, title: 'Send the comps' }, taskIds: [IDS.task], reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 3 h' }], why: ['Overdue by 3 h'], subjectType: 'task', subjectId: IDS.task })]));
    await group();
    expect(screen.getAllByRole('article', { name: 'Dana Reyes' })).toHaveLength(1);
    expect(within(await group()).getByRole('article', { name: 'Dana Reyes' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Next up' })).getAllByRole('article')).toHaveLength(1);
  });

  it('E854: a person in the plan is shown once even when another task of theirs has a card (the follow-up just set for tomorrow): that card leaves "Next up" too', async () => {
    const tomorrow: FeedCard = card({ itemType: 'task_due', contact: { id: IDS.jane, name: 'Dana Reyes' }, task: { id: IDS.task, title: 'Follow up with Dana' }, reasons: [{ code: 'TASK_DUE', label: 'Due in 14 h' }], primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, subjectType: 'task', subjectId: IDS.task });
    // a card about the same person that is not a task (their reply is waiting) stays: it is other work
    const reply: FeedCard = card({ contact: { id: IDS.jane, name: 'Dana Reyes' }, reasons: [{ code: 'CLIENT_WAITING', label: 'They texted 5 min ago; no reply yet' }], primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane } });
    open(withPlan(feed([], [tomorrow, reply]), [person()]));
    await group();
    const next = within(screen.getByRole('region', { name: 'Next up' })).getAllByRole('article');
    expect(next).toHaveLength(1);
    expect(within(next[0]!).getByText('They texted 5 min ago; no reply yet')).toBeInTheDocument();
    expect(screen.queryByText('Due in 14 h')).toBeNull();
  });

  it('a row of the warm kind is headed "Gone quiet", never the generic "For you"', async () => {
    open(withPlan(feed(), [person()]));
    const row = within(await group()).getByRole('article', { name: 'Dana Reyes' });
    expect(within(row).getByText('Gone quiet')).toBeInTheDocument();
    expect(within(row).queryByText('For you')).toBeNull();
  });

  it('when "Next up" holds only cards the group already shows, there is no empty "Next up" heading', async () => {
    const taskCard: FeedCard = card({ itemType: 'task_due', contact: { id: IDS.jane, name: 'Dana Reyes' }, task: { id: IDS.task, title: 'Send the comps' }, primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, subjectType: 'task', subjectId: IDS.task });
    open(withPlan(feed([], [taskCard]), [person({ taskIds: [IDS.task] })]));
    await group();
    expect(screen.queryByRole('heading', { level: 2, name: 'Next up' })).toBeNull();
    // and the page is not called empty
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  it('E859: the count has its denominator when the plan is capped ("Showing 2 of 27 people due"), and says "at least" when the total is a lower bound', async () => {
    const two = [person(), person({ id: IDS.pat, contact: { id: IDS.pat, name: 'Pat Lindqvist' }, primaryAction: { kind: 'call', label: 'Call', contactId: IDS.pat } })];
    open(withPlan(feed(), two, 27));
    expect(within(await group()).getByText('Showing 2 of 27 people due')).toBeInTheDocument();
  });
  it('… and "at least" when more are due than were counted', async () => {
    open(withPlan(feed(), [person()], 60, true));
    expect(within(await group()).getByText('Showing 1 of at least 60 people due')).toBeInTheDocument();
  });

  it('R-TODAY-8: nobody due: "Nobody is due today. People you promise to follow up with will show here."', async () => {
    open(withPlan(feed([], [card({ contact: { id: IDS.pat, name: 'Pat L.' }, primaryAction: { kind: 'text', label: 'Text', contactId: IDS.pat } })]), []));
    const g = await group();
    expect(within(g).getByText(NOBODY)).toBeInTheDocument();
    expect(within(g).queryByRole('article')).toBeNull();
    // no tutorial, no overlay
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an empty feed with nobody due says both, once each, and still has no accessibility violations', async () => {
    open(withPlan(feed(), []));
    expect(await screen.findByText(NOBODY)).toBeInTheDocument();
    expect(screen.getByText("You're caught up")).toBeInTheDocument();
    const r = await axe.run(document.body, { rules: { region: { enabled: false }, 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('loading and error are said in plain words, and an answer without the plan (an older server) draws no group and does not break', async () => {
    const fake = new FakeFetch().on('GET /feed', err(500, 'INTERNAL_ERROR'));
    agentApp(fake);
    expect(await screen.findByText("Can't load your feed")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Follow up today' })).toBeNull();
  });
  it('… an answer without the plan draws no group', async () => {
    open(feed([], [card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } })]));
    await screen.findByRole('heading', { level: 2, name: 'Next up' });
    expect(screen.queryByRole('region', { name: 'Follow up today' })).toBeNull();
  });
});

// b19 Today fix 1 (M4; R-TODAY-13): "Nobody is due today." is said only of a COMPLETE read that found nobody. A read
// that stopped at its bound says how many people it checked and offers to look further.
describe('M4 (R-TODAY-13): "nobody is due" only after a complete read', () => {
  const partial = (over: Partial<NonNullable<FeedResponse['followUpToday']>> = {}): FeedResponse => ({ ...feed(), followUpToday: { people: [], total: 0, totalIsMinimum: true, checked: 120, complete: false, ...over } });

  it('an incomplete read that found nobody says how many it checked and offers to look further; it never says "Nobody is due today" or "You’re caught up"', async () => {
    open(partial());
    const g = await group();
    expect(within(g).getByText('Checked 120 of your people so far, and nobody is due yet. There are more to check.')).toBeInTheDocument();
    expect(within(g).getByRole('button', { name: 'Look further' })).toBeEnabled();
    expect(screen.queryByText(NOBODY)).toBeNull();
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  it('"Look further" asks the server to check more (followUpDepth), and the people it finds are shown; then "nobody" is no longer on the page', async () => {
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: partial() })
      .on('GET /feed?followUpDepth=4', { status: 200, body: withPlan(feed(), [person()]) })
      .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } });
    agentApp(fake);
    const g = await group();
    await userEvent.setup().click(within(g).getByRole('button', { name: 'Look further' }));
    expect(await within(await group()).findByRole('article', { name: 'Dana Reyes' })).toBeInTheDocument();
    expect(fake.callsTo('GET /feed?followUpDepth=4')).toHaveLength(1);
    expect(screen.queryByText(/nobody is due/i)).toBeNull();
  });

  it('looking further that still finds nobody says the new count; at the deepest read it says that is as far as Today looks', async () => {
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: partial() })
      .on('GET /feed?followUpDepth=4', { status: 200, body: partial({ checked: 240 }) })
      .on('GET /feed?followUpDepth=8', { status: 200, body: partial({ checked: 480 }) })
      .on('GET /feed?followUpDepth=10', { status: 200, body: partial({ checked: 600 }) });
    agentApp(fake);
    const u = userEvent.setup();
    for (const n of [240, 480]) {
      await u.click(within(await group()).getByRole('button', { name: 'Look further' }));
      await waitFor(async () => expect(within(await group()).getByText(`Checked ${n} of your people so far, and nobody is due yet. There are more to check.`)).toBeInTheDocument());
    }
    await u.click(within(await group()).getByRole('button', { name: 'Look further' }));
    await waitFor(async () => expect(within(await group()).getByText('Checked 600 of your people, and nobody is due yet. That is as far as Today looks; your People list has everyone.')).toBeInTheDocument());
    expect(within(await group()).queryByRole('button', { name: 'Look further' })).toBeNull();
    expect(screen.queryByText(NOBODY)).toBeNull();
  });

  it('an incomplete read that found some people shows them and says more may be due, with the way to look further', async () => {
    open(partial({ people: [person()], total: 1, checked: 120 }));
    const g = await group();
    expect(within(g).getByRole('article', { name: 'Dana Reyes' })).toBeInTheDocument();
    expect(within(g).getByText('Checked 120 of your people so far. More may be due.')).toBeInTheDocument();
    expect(within(g).getByRole('button', { name: 'Look further' })).toBeEnabled();
  });

  it('a complete read that found nobody still says "Nobody is due today."', async () => {
    open({ ...feed(), followUpToday: { people: [], total: 0, totalIsMinimum: false, checked: 62, complete: true } });
    expect(await screen.findByText(NOBODY)).toBeInTheDocument();
  });

  it('W1 (the reviewer’s case): an answer that only says the total is a lower bound (no `complete`) is not a complete read either', async () => {
    open({ ...feed(), followUpToday: { people: [], total: 0, totalIsMinimum: true } });
    await group();
    expect(screen.queryByText(NOBODY)).toBeNull();
    expect(within(await group()).getByText('Nobody is due among the people checked so far. There are more to check.')).toBeInTheDocument();
  });
});
