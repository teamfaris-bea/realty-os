// R-TODAY-6 / R-TODAY-8 (web): the "Follow up today" group on Today. A list of people with a reason each, between
// "Due now" and "Next up"; a person is shown once; the count has its denominator; the empty state is in plain words.
import { screen, within } from '@testing-library/react';
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

describe('"Follow up today" on Today', () => {
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

  it('a person due by a task is shown once: their task’s own card leaves "Next up" for the row', async () => {
    const taskCard: FeedCard = card({ itemType: 'task_due', contact: { id: IDS.jane, name: 'Dana Reyes' }, task: { id: IDS.task, title: 'Send the comps' }, reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 3 h' }], primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, subjectType: 'task', subjectId: IDS.task });
    const other = card({ contact: { id: IDS.pat, name: 'Pat L.' }, primaryAction: { kind: 'text', label: 'Text', contactId: IDS.pat } });
    open(withPlan(feed([], [taskCard, other]), [person({ itemType: 'task_due', task: { id: IDS.task, title: 'Send the comps' }, taskIds: [IDS.task], reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 3 h' }], why: ['Overdue by 3 h'], subjectType: 'task', subjectId: IDS.task })]));
    await group();
    expect(screen.getAllByRole('article', { name: 'Dana Reyes' })).toHaveLength(1);
    expect(within(await group()).getByRole('article', { name: 'Dana Reyes' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Next up' })).getAllByRole('article')).toHaveLength(1);
  });

  it('when "Next up" holds only cards the group already shows, there is no empty "Next up" heading', async () => {
    const taskCard: FeedCard = card({ itemType: 'task_due', contact: { id: IDS.jane, name: 'Dana Reyes' }, task: { id: IDS.task, title: 'Send the comps' }, primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, subjectType: 'task', subjectId: IDS.task });
    open(withPlan(feed([], [taskCard]), [person({ taskIds: [IDS.task] })]));
    await group();
    expect(screen.queryByRole('heading', { level: 2, name: 'Next up' })).toBeNull();
    // and the page is not called empty
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  it('the count has its denominator when the plan is capped ("Showing 2 of 27 people due"), and says "at least" when the total is a lower bound', async () => {
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
