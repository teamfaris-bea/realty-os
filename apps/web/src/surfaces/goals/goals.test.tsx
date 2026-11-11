// Goals and the weekly plan page (module 40; R-PLAN-1…3; E110, E111): pace in words with how it is counted (never a
// grade), setting a goal for a member, the plan page the feed card opens (deadline first, evidence on each item, the
// E110 note), and the one-tap accept that adds the ticked items to the member's tasks.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AGENT, DEAL, FakeFetch, err, goalsBody, insightsApp, plan } from '../owner/testing.js';
import { periodStartOf, todayIn } from './GoalsPage.js';

const violations = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => v.id);

describe('Goals', () => {
  it('R-PLAN-2: each goal shows its pace in words and how it was counted; status is said in words, never a grade', async () => {
    insightsApp(new FakeFetch().on('GET /goals', { status: 200, body: goalsBody() }), '/goals', 'team_lead');
    expect(await screen.findByText('1 of 4 closings; 1.3 expected by now; 3 to go in 20 days')).toBeInTheDocument();
    expect(screen.getByText('On pace')).toBeInTheDocument();
    expect(screen.getByText(/Counted from the scoreboard/)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/\bgrade|\bscore\b|%|confiden/i);
    expect(await violations()).toEqual([]);
  });

  it('R-PLAN-2: a Team Lead sets a goal for a member in one tap: the period starts where it starts in the team zone', async () => {
    const fake = new FakeFetch().on('GET /goals', { status: 200, body: goalsBody() }).on('POST /goals', { status: 201, body: { goal: goalsBody().goals[0] } });
    insightsApp(fake, '/goals', 'team_lead');
    const u = userEvent.setup();
    await screen.findByText('Set a goal');
    await u.selectOptions(screen.getByLabelText('Period'), 'quarter');
    await u.selectOptions(screen.getByLabelText('What to count'), 'appointments_set');
    await u.type(screen.getByLabelText('Target'), '12');
    await u.click(screen.getByRole('button', { name: 'Set goal' }));
    await waitFor(() => expect(fake.callsTo('POST /goals')).toHaveLength(1));
    expect(fake.callsTo('POST /goals')[0]!.body).toEqual({ userId: AGENT, periodKind: 'quarter', periodStart: periodStartOf('quarter', todayIn('America/Los_Angeles')), metric: 'appointments_set', target: 12 });
    expect(await screen.findByText('Goal set.')).toBeInTheDocument();
  });

  it('R-PLAN-2: an agent who cannot manage goals sees no form and is told who sets them', async () => {
    insightsApp(new FakeFetch().on('GET /goals', { status: 200, body: goalsBody({ members: [{ userId: AGENT, name: 'Ava Agent', role: 'agent', canManage: false }], goals: [] }) }), '/goals', 'agent');
    expect(await screen.findByText(/Your Team Lead or the Owner sets goals/)).toBeInTheDocument();
    expect(screen.queryByText('Set a goal')).toBeNull();
    expect(screen.queryByLabelText('Member')).toBeNull();
  });

  it('period starts: Monday, the 1st, the quarter’s first month, January 1st', () => {
    expect(periodStartOf('week', '2026-11-11')).toBe('2026-11-09');
    expect(periodStartOf('week', '2026-11-09')).toBe('2026-11-09');
    expect(periodStartOf('week', '2026-11-15')).toBe('2026-11-09');
    expect(periodStartOf('month', '2026-11-11')).toBe('2026-11-01');
    expect(periodStartOf('quarter', '2026-11-11')).toBe('2026-10-01');
    expect(periodStartOf('quarter', '2026-03-31')).toBe('2026-01-01');
    expect(periodStartOf('year', '2026-11-11')).toBe('2026-01-01');
  });
});

describe('Weekly plan page', () => {
  it('R-PLAN-1 E110: the plan the card opens: numbered items, deadline first, each with why it is on the list and a link; the pipeline-only note', async () => {
    insightsApp(new FakeFetch().on('GET /me/weekly-plans/2026-W46', { status: 200, body: plan() }), '/plan/2026-W46', 'agent');
    expect(await screen.findByText(/built from your pipeline only/)).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: /built from your pipeline only/ })).getAllByRole('article');
    expect(items.map((a) => within(a).getByRole('heading', { level: 2 }).textContent)).toEqual(['Keep your promise: Send Sam the comps', 'Log the outcome of this appointment', 'Move Ortiz purchase forward']);
    expect(within(items[0]!).getByText(/^Due /)).toBeInTheDocument();
    expect(within(items[2]!).getByText('Deal in prospect for 12 days; median 2 (n=5)')).toBeInTheDocument();
    expect(within(items[2]!).getByRole('link', { name: 'Open the deal' })).toHaveAttribute('href', `/deals/${DEAL}`);
    expect(screen.getByRole('main').textContent).not.toMatch(/\bgrade|\bscore\b|%|confiden/i);
    expect(await violations()).toEqual([]);
  });

  it('R-PLAN-1: nothing is added until the tap; one tap adds the ticked items (untick one first) and the page then says which are on your tasks', async () => {
    const accepted = plan({ accepted: { at: '2026-11-11T18:00:00.000Z', taskIds: ['a', 'b'] }, items: plan().items!.map((x) => ({ ...x, accepted: x.index !== 1 })) });
    const fake = new FakeFetch().on('GET /me/weekly-plans/2026-W46', { status: 200, body: plan() }).on('POST /me/weekly-plans/2026-W46/accept', { status: 200, body: accepted });
    insightsApp(fake, '/plan/2026-W46', 'agent');
    const u = userEvent.setup();
    const add = await screen.findByRole('button', { name: 'Add 3 items to my tasks' });
    expect(fake.callsTo('POST /me/weekly-plans/2026-W46/accept')).toHaveLength(0);
    await u.click(screen.getAllByRole('checkbox', { name: 'Add to my tasks' })[1]!);
    expect(add).toHaveTextContent('Add 2 items to my tasks');
    await u.click(add);
    await waitFor(() => expect(fake.callsTo('POST /me/weekly-plans/2026-W46/accept')).toHaveLength(1));
    expect(fake.callsTo('POST /me/weekly-plans/2026-W46/accept')[0]!.body).toEqual({ itemIndexes: [0, 2] });
    expect(await screen.findAllByText('On your tasks')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open my tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('E111: items dropped since Monday are counted; a second accept elsewhere is said in words; no plan yet says when it comes', async () => {
    const fake = new FakeFetch()
      .on('GET /me/weekly-plans/2026-W46', { status: 200, body: plan({ droppedSinceBuilt: 1 }) })
      .on('POST /me/weekly-plans/2026-W46/accept', err(409, 'PLAN_ALREADY_ACCEPTED'))
      .on('GET /me/weekly-plans/current', { status: 200, body: { week: '2026-W47', exists: false } });
    const { router } = insightsApp(fake, '/plan/2026-W46', 'agent');
    expect(await screen.findByText('1 item no longer applies since the plan was made and is not shown.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add 3 items to my tasks' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/PLAN_ALREADY_ACCEPTED/);
    await router.navigate('/plan');
    expect(await screen.findByText('No plan for this week yet')).toBeInTheDocument();
  });
});
