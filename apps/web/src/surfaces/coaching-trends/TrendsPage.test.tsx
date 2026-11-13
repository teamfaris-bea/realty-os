// The coaching trends page in jsdom on the staff contract (module 55 for module 54; R-COACH-7, R-COACH-8, R-STAFF-3,
// R-STAFF-6, E679). StaffFake checks every request and every scripted answer against the API's own schemas.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { countsWords, windowWords } from './TrendsPage.js';
import { surface } from './index.js';
import type { OwnTrendsView, TeamTrendsView, TrendItemView } from './types.js';

type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

const U1 = '01900000-0000-7000-8000-0000000000b1';
const U2 = '01900000-0000-7000-8000-0000000000b2';
const WINDOWS = { before: { from: '2026-11-02', to: '2026-11-08' }, after: { from: '2026-11-09', to: '2026-11-15' } };
const OWN_SENTENCE = 'Your reviewed calls last week, against the week before.';
const TEAM_SENTENCE = 'Counts of reviewed calls per checklist item, last week against the week before. Weeks with only a few reviewed calls are not shown.';
const TL_NOT_ALLOWED = 'The Owner has not turned on Team Lead access to call reviews, so trends are private to each person.';

const financing = (): TrendItemView => ({
  key: 'asked_financing',
  label: 'Asked about financing',
  before: { calls: 8, scored: 6, met: 3 },
  after: { calls: 7, scored: 6, met: 5 },
  direction: 'improving',
  sentence: 'Improving: met in 3 of 6, then 5 of 6',
});
const timeline = (): TrendItemView => ({
  key: 'asked_timeline',
  label: 'Asked about their timeline',
  before: { calls: 8, scored: 2, met: null },
  after: { calls: 7, scored: 6, met: 4 },
  direction: 'not_enough_data',
  sentence: 'Not enough reviewed calls yet (6 last week)',
});

const own = (over: Partial<OwnTrendsView> = {}): { trends: OwnTrendsView } => ({
  trends: { state: 'ready', sentence: OWN_SENTENCE, windows: WINDOWS, items: [financing(), timeline()], ...over },
});
const team = (over: Partial<TeamTrendsView> = {}): { trends: TeamTrendsView } => ({
  trends: {
    state: 'ready',
    sentence: TEAM_SENTENCE,
    windows: WINDOWS,
    team: [financing()],
    members: [
      { userId: U1, name: 'Nia Brook', items: [financing()] },
      { userId: U2, name: 'Theo Marsh', items: [{ ...timeline(), after: { calls: 3, scored: 3, met: null } }] },
    ],
    ...over,
  },
});

function app(fake: StaffFake, role: Role = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path: '/coaching/trends', table: tableWith(surface) });
}

const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;
const pageText = () => screen.getByRole('main').textContent ?? '';

const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => v.id);
};

describe('the coaching trends page: Mine', () => {
  it('R-STAFF-3 R-COACH-7: each item has its label, the direction in words with the server\'s sentence, and both windows in words with "met X of Y scored calls (Z calls)"; axe finds nothing', async () => {
    app(new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }));
    expect(await screen.findByText(OWN_SENTENCE)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Your checklist items' });
    const item = within(list).getByRole('listitem', { name: 'Asked about financing' });
    expect(within(item).getByText('Improving.')).toBeInTheDocument();
    expect(within(item).getByText(/Improving: met in 3 of 6, then 5 of 6/)).toBeInTheDocument();
    expect(within(item).getByText('Earlier, November 2 to November 8:')).toBeInTheDocument();
    expect(within(item).getByText('met 3 of 6 scored calls (8 calls)')).toBeInTheDocument();
    expect(within(item).getByText('Recent, November 9 to November 15:')).toBeInTheDocument();
    expect(within(item).getByText('met 5 of 6 scored calls (7 calls)')).toBeInTheDocument();
    expect(await axeClean()).toEqual([]);
  });

  it('E679 R-STAFF-3: a withheld met says "Not shown: too few scored calls", never 0, and keeps its call count', async () => {
    app(new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }));
    const item = await screen.findByRole('listitem', { name: 'Asked about their timeline' });
    expect(within(item).getByText('Not shown: too few scored calls (8 calls)')).toBeInTheDocument();
    expect(within(item).getByText('Not enough reviewed calls to compare.')).toBeInTheDocument();
    expect(item.textContent).not.toMatch(/met 0\b|\b0 of\b/);
    expect(countsWords({ calls: 1, scored: 1, met: null })).toBe('Not shown: too few scored calls (1 call)');
    expect(countsWords({ calls: 5, scored: 5, met: 0 })).toBe('met 0 of 5 scored calls (5 calls)');
  });

  it('R-STAFF-3: no "%", raw code or ISO date in the rendered text; every met count carries its scored and call denominators', async () => {
    app(new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }));
    await screen.findByText(OWN_SENTENCE);
    const text = pageText();
    expect(text).not.toContain('%');
    expect(text).not.toMatch(RAW);
    expect(text).not.toMatch(/\d{4}-\d\d-\d\d/);
    expect(text).not.toMatch(/asked_financing|not_enough_data|improving\b/);
    expect(text).not.toMatch(/score\b|grade|rank|percent|rate\b/i);
    for (const m of text.matchAll(/met (\d+)/g)) expect(text).toMatch(new RegExp(`met ${m[1]} of \\d+ scored calls? \\(\\d+ calls?\\)`));
  });

  it('R-COACH-7: the weeks select asks for 1-4 weeks through ?weeks=', async () => {
    const fake = new StaffFake()
      .on('GET /coaching/trends?weeks=1', { status: 200, body: own() })
      .on('GET /coaching/trends?weeks=3', { status: 200, body: own({ sentence: 'Your reviewed calls in the last 3 weeks, against the 3 weeks before.' }) });
    app(fake);
    await screen.findByText(OWN_SENTENCE);
    const select = screen.getByRole('combobox', { name: 'Compare' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Last week, against the week before',
      'Last 2 weeks, against the 2 before',
      'Last 3 weeks, against the 3 before',
      'Last 4 weeks, against the 4 before',
    ]);
    await userEvent.setup().selectOptions(select, '3');
    expect(await screen.findByText('Your reviewed calls in the last 3 weeks, against the 3 weeks before.')).toBeInTheDocument();
    expect(fake.callsTo('GET /coaching/trends?weeks=3').length).toBeGreaterThan(0);
  });

  it('E679 R-STAFF-3: call reviews not cleared, or scoring off: the state sentence only, no counts', async () => {
    for (const [state, sentence] of [
      ['not_cleared', 'Call reviews are off until counsel reviews them.'],
      ['scoring_off', 'Call scoring is off.'],
    ] as const) {
      const v = app(new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own({ state, sentence, items: [] }) }));
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(pageText()).not.toMatch(/met \d|Not shown|%/);
      v.view.unmount();
    }
  });

  it('a failed load is said in words, never the code', async () => {
    app(new StaffFake().on('GET /coaching/trends?weeks=1', staffError('NOT_FOUND')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(RAW);
  });
});

describe('the coaching trends page: Team and roles', () => {
  it('R-STAFF-6: an agent or ISA sees no Team tab and never asks for /coaching/trends/team', async () => {
    for (const role of ['agent', 'isa'] as const) {
      const fake = new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }).on('GET /coaching/trends/team?weeks=1', { status: 200, body: team() });
      const v = app(fake, role);
      await screen.findByText(OWN_SENTENCE);
      expect(screen.queryByRole('button', { name: 'Team' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Whose trends' })).toBeNull();
      expect(fake.calls.filter((c) => c.path.startsWith('/coaching/trends/team'))).toEqual([]);
      v.view.unmount();
    }
  });

  it('R-STAFF-6: a TC opening the page by URL sees "Not available" and nothing is requested', async () => {
    const fake = new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() });
    app(fake, 'tc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path.startsWith('/coaching/trends'))).toEqual([]);
  });

  it('R-STAFF-3 R-COACH-8: the Owner\'s Team tab shows the team and each person by name with their counts, the 200 note, and no percentage; axe finds nothing', async () => {
    const sentence = `Showing the first 200 members. ${TEAM_SENTENCE}`;
    const fake = new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }).on('GET /coaching/trends/team?weeks=1', { status: 200, body: team({ sentence }) });
    app(fake, 'owner');
    await screen.findByText(OWN_SENTENCE);
    expect(fake.calls.filter((c) => c.path.startsWith('/coaching/trends/team'))).toEqual([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('list', { name: 'The team’s checklist items' })).getByText('met 3 of 6 scored calls (8 calls)')).toBeInTheDocument();
    const people = screen.getByRole('list', { name: 'Trends by person' });
    expect(within(people).getByRole('heading', { level: 3, name: 'Nia Brook' })).toBeInTheDocument();
    const theo = within(people).getByRole('list', { name: 'Theo Marsh’s checklist items' });
    expect(within(theo).getByText('Not shown: too few scored calls (3 calls)')).toBeInTheDocument();
    const text = pageText();
    expect(text).not.toContain('%');
    expect(text).not.toMatch(RAW);
    expect(text).not.toMatch(/\d{4}-\d\d-\d\d/);
    expect(await axeClean()).toEqual([]);
    // back to Mine, and the weeks select drives the team request too
    await user.click(screen.getByRole('button', { name: 'Mine' }));
    expect(await screen.findByText(OWN_SENTENCE)).toBeInTheDocument();
  });

  it('E679 R-COACH-8: a Team Lead without the Owner\'s switch sees the state sentence (tl_not_allowed), and no names or counts', async () => {
    const fake = new StaffFake()
      .on('GET /coaching/trends?weeks=1', { status: 200, body: own() })
      .on('GET /coaching/trends/team?weeks=1', { status: 200, body: team({ state: 'tl_not_allowed', sentence: TL_NOT_ALLOWED, team: [], members: [] }) });
    app(fake, 'team_lead');
    await screen.findByText(OWN_SENTENCE);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Team' }));
    expect(await screen.findByText(TL_NOT_ALLOWED)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Trends by person' })).toBeNull();
    expect(pageText()).not.toMatch(/met \d|%/);
  });

  it('E679 R-COACH-8: the definer refusing the call (COACHING_TRENDS_SCOPE) is said in words like the state sentence, never the code', async () => {
    const fake = new StaffFake().on('GET /coaching/trends?weeks=1', { status: 200, body: own() }).on('GET /coaching/trends/team?weeks=1', staffError('COACHING_TRENDS_SCOPE'));
    app(fake, 'team_lead');
    await screen.findByText(OWN_SENTENCE);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Team' }));
    expect(await screen.findByText(/These trends are private to each person/)).toBeInTheDocument();
    expect(pageText()).not.toMatch(RAW);
    expect(pageText()).not.toContain('COACHING_TRENDS_SCOPE');
  });

  it('R-COACH-8: nobody on the team takes call reviews: the server\'s sentence and no lists', async () => {
    const fake = new StaffFake()
      .on('GET /coaching/trends?weeks=1', { status: 200, body: own() })
      .on('GET /coaching/trends/team?weeks=2', { status: 200, body: team({ sentence: 'Nobody on the team takes call reviews yet.', team: [], members: [] }) });
    app(fake, 'admin');
    await screen.findByText(OWN_SENTENCE);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compare' }), '2');
    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect(await screen.findByText('Nobody on the team takes call reviews yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Trends by person' })).toBeNull();
    await waitFor(() => expect(fake.callsTo('GET /coaching/trends/team?weeks=2').length).toBeGreaterThan(0));
  });
});

describe('the trends view types', () => {
  it('R-STAFF-3: no confidence, score, points, rate or percentage key in the view types', () => {
    const t = team().trends;
    expect(Object.keys(own().trends).sort()).toEqual(['items', 'sentence', 'state', 'windows']);
    expect(Object.keys(t).sort()).toEqual(['members', 'sentence', 'state', 'team', 'windows']);
    expect(Object.keys(t.members[0]!).sort()).toEqual(['items', 'name', 'userId']);
    expect(Object.keys(financing()).sort()).toEqual(['after', 'before', 'direction', 'key', 'label', 'sentence']);
    expect(Object.keys(financing().before).sort()).toEqual(['calls', 'met', 'scored']);
    for (const k of JSON.stringify(t).match(/"[A-Za-z]+":/g) ?? []) expect(k).not.toMatch(/confidence|probab|score"|points|percent|rate|rank|grade/i);
  });

  it('windows are said in words, never as the stored date', () => {
    expect(windowWords({ from: '2026-11-02', to: '2026-11-08' })).toBe('November 2 to November 8');
    expect(windowWords({ from: '2026-12-28', to: '2027-01-03' })).toBe('December 28, 2026 to January 3, 2027');
    expect(windowWords({ from: 'x', to: '2026-11-08' })).toBe('dates not known');
  });
});
