// Scoreboard and momentum in jsdom. R-ACC-4 (display half): every number on the page is shown with
// its denominator. The numbers themselves come from the DB views (proven in api/accountability).
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, board, leadAdminApp } from '../admin/lib/testing.js';
import type { MomentumResponse } from '../admin/lib/types.js';
import { scoreboardLines } from './lib.js';

const range = (key: string) => ({ key, from: '2026-11-03T08:00:00.000Z', to: '2026-11-10T08:00:00.000Z', days: 7, zone: 'America/Los_Angeles' });

const momentum: MomentumResponse = {
  rule: { factor: 1.5, minSample: 5, windowDays: 180 },
  norms: [{ stage: 'under_contract', medianDays: 9, sample: 12, enough: true }],
  agents: [
    {
      userId: ID.ava,
      name: 'Ava Agent',
      openDeals: 3,
      slowDeals: 1,
      stages: [
        { stage: 'under_contract', slow: 1, norm: { medianDays: 9, sample: 12, enough: true }, deals: [{ dealId: '01900000-0000-7000-8000-0000000de001', name: 'Jane Doe · 12 Oak St', stageEnteredAt: '2026-10-20T00:00:00.000Z', dwellDays: 21, slow: true }] },
        { stage: 'active', slow: 0, norm: { medianDays: 4, sample: 3, enough: false }, deals: [{ dealId: '01900000-0000-7000-8000-0000000de002', name: 'Marco Silva', stageEnteredAt: '2026-11-08T00:00:00.000Z', dwellDays: 2, slow: false }] },
      ],
    },
  ],
  generatedAt: new Date().toISOString(),
};

/** Every displayed figure must sit in "x of y", "x in N days" or "(of N …)": no bare counts. */
function assertDenominated(text: string) {
  const stripped = text
    .replace(/\d+ of \d+/g, '')
    .replace(/\d+ in \d+ days?/g, '')
    .replace(/\(of \d+ [a-z ]+\)/g, '')
    .replace(/\d+ (calls?|texts, emails and chat replies|still waiting)/g, '')
    .replace(/Median \d+(\.\d+)? (sec|min|h|days?)( \d+ min)?/g, '');
  expect(stripped).not.toMatch(/\d/);
}

describe('Scoreboard', () => {
  it('R-ACC-4: every scoreboard number carries its denominator, for any values', () => {
    for (const n of [0, 1, 2, 7, 13, 250]) {
      const lines = scoreboardLines(board({ speedToLead: { medianSeconds: n === 0 ? null : n * 60, withinSla: n, total: n + 1, responded: n, pending: n % 3 }, touches: { count: n, calls: n, textsAndEmails: n, days: n + 1 }, appointmentsSet: { count: n, days: 30 }, appointmentsHeld: { count: n, of: n + 2 }, agreementsSigned: { count: n, days: 90 } }));
      for (const l of lines) assertDenominated(`${l.text} ${l.detail ?? ''}`);
    }
  });

  it('R-ACC-4: a Team Lead sees the team with denominators: "12 of 14 within the first-touch window", "34 in 7 days", "3 of 5 held"', async () => {
    const fake = new FakeFetch()
      .on('GET /team/scoreboard?range=7d', { status: 200, body: { range: range('7d'), members: [board(), board({ userId: ID.ben, name: 'Ben Agent', speedToLead: { medianSeconds: null, withinSla: 0, total: 0, responded: 0, pending: 0 } })] } })
      .on('GET /team/momentum', { status: 200, body: momentum });
    leadAdminApp(fake, '/team/scoreboard', 'team_lead');
    const table = await screen.findByRole('table');
    const ava = within(table).getByRole('row', { name: /Ava Agent/ });
    expect(ava.textContent).toContain('12 of 14 within the first-touch window');
    expect(ava.textContent).toContain('Median 4 min (of 13 first touches) · 1 still waiting');
    expect(ava.textContent).toContain('34 in 7 days');
    expect(ava.textContent).toContain('3 of 5 held');
    expect(ava.textContent).toContain('1 in 7 days');
    const ben = within(table).getByRole('row', { name: /Ben Agent/ });
    expect(ben.textContent).toContain('0 of 0 within the first-touch window');
    expect(ben.textContent).toContain('No first touches yet');
    expect(screen.getByText(/Messages the assistant sent never count here/)).toBeInTheDocument();
  });

  it('an agent sees only their own numbers (GET /scoreboard), and the period switch refetches', async () => {
    const fake = new FakeFetch()
      .on('GET /scoreboard?range=7d', { status: 200, body: { range: range('7d'), scoreboard: board({ userId: ID.me, name: 'Ava Agent' }) } })
      .on('GET /scoreboard?range=30d', { status: 200, body: { range: { ...range('30d'), days: 30 }, scoreboard: board({ userId: ID.me, name: 'Ava Agent', touches: { count: 120, calls: 70, textsAndEmails: 50, days: 30 } }) } })
      .on('GET /team/momentum', { status: 200, body: { ...momentum, agents: [] } });
    leadAdminApp(fake, '/team/scoreboard', 'agent');
    expect(await screen.findByRole('heading', { name: 'Your numbers' })).toBeInTheDocument();
    expect(await screen.findByText('34 in 7 days')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('radio', { name: '30 days' }));
    expect(await screen.findByText('120 in 30 days')).toBeInTheDocument();
    expect(fake.callsTo('GET /team/scoreboard?range=7d')).toHaveLength(0);
  });

  it('E310 (owner decision D8): both boards say which sends are touches: calls, texts, emails and chat replies people sent themselves, never the assistant', async () => {
    const team = new FakeFetch().on('GET /team/scoreboard?range=7d', { status: 200, body: { range: range('7d'), members: [board()] } }).on('GET /team/momentum', { status: 200, body: momentum });
    leadAdminApp(team, '/team/scoreboard', 'team_lead');
    expect(await screen.findByText('Touches count calls, texts, emails and chat replies people sent themselves. Messages the assistant sent never count here.')).toBeInTheDocument();
    expect(within(await screen.findByRole('table')).getByText('20 calls · 14 texts, emails and chat replies')).toBeInTheDocument();
  });

  it('E310 (owner decision D8): an agent\'s own board says the same about touches', async () => {
    const own = new FakeFetch().on('GET /scoreboard?range=7d', { status: 200, body: { range: range('7d'), scoreboard: board({ userId: ID.me, name: 'Ava Agent' }) } }).on('GET /team/momentum', { status: 200, body: { ...momentum, agents: [] } });
    leadAdminApp(own, '/team/scoreboard', 'agent');
    expect(await screen.findByText('Touches count calls, texts, emails and chat replies you sent yourself. Messages the assistant sent never count here.')).toBeInTheDocument();
  });

  it('R-ACC-5 display: momentum flags a slow deal against the team median, and says when there is not enough history to compare', async () => {
    const fake = new FakeFetch().on('GET /team/scoreboard?range=7d', { status: 200, body: { range: range('7d'), members: [board()] } }).on('GET /team/momentum', { status: 200, body: momentum });
    leadAdminApp(fake, '/team/scoreboard', 'owner');
    expect(await screen.findByText('1 of 3 open deals slower than usual')).toBeInTheDocument();
    expect(screen.getByText(/Team median 9 days \(of 12 deals\)/)).toBeInTheDocument();
    expect(screen.getByText(/Not enough team history to compare yet \(3 of 5 deals needed\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jane Doe · 12 Oak St' })).toHaveAttribute('href', '/deals/01900000-0000-7000-8000-0000000de001');
    expect(screen.getAllByText('Slower than usual')).toHaveLength(1);
    expect(screen.getByText(/more than 1.5× the team median, once the team has at least 5 deals/)).toBeInTheDocument();
  });
});
