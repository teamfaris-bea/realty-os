// The daily fix page and the Owner's coaching settings in jsdom on a scripted API (modules 40 and 41;
// R-COACH-2..6, R-INT-6, E106). The same pages run against the real API in e2e/coaching.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as adminCoaching } from '../admin/coaching/index.js';
import { surface } from './index.js';
import type { CoachingSettingsView, TeamView, TodayView } from './types.js';

const REC = '01900000-0000-7000-8000-00000000c0a1';
const CALL1 = '01900000-0000-7000-8000-00000000ca11';
const CALL2 = '01900000-0000-7000-8000-00000000ca12';

function app(fake: FakeFetch, path: string, role: 'agent' | 'owner' | 'team_lead' | 'admin' = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant], reauthenticatedAt: new Date().toISOString() } });
  return renderApp({ fake, path, table: tableWith(surface, adminCoaching) });
}

const ready = (over: Partial<TodayView> = {}): { coaching: TodayView } => ({
  coaching: {
    state: 'ready',
    date: '2026-11-11',
    cardId: '01900000-0000-7000-8000-0000000cad01',
    noFix: null,
    fix: {
      date: '2026-11-11',
      itemKey: 'asked_financing',
      label: 'Asked about financing',
      tip: 'Ask "Have you had a chance to talk with a lender yet?"',
      why: 'Asked about financing: missed in 3 of the last 4 calls',
      quotes: [
        { callId: CALL1, recordingId: REC, startMs: 70_000, endMs: 74_500, snippet: 'Thanks so much, talk soon.', callLabel: 'Call with Lena, Nov 10' },
        { callId: CALL2, recordingId: REC, startMs: 5_000, endMs: 9_500, snippet: null, callLabel: 'Call with Omar, Nov 9' },
      ],
    },
    ...over,
  },
});

const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => v.id);
};

describe('the daily fix page', () => {
  it('R-COACH-4: one tip, why, and two moments; a moment plays in one tap from that point of the call; no score anywhere; axe finds nothing', async () => {
    const fake = new FakeFetch().on('GET /coaching/today', { status: 200, body: ready() }).on(`POST /recordings/${REC}/stream-token`, { status: 200, body: { token: 't', expiresAt: '2026-11-11T16:00:00Z', url: `/api/recordings/${REC}/stream?token=t` } });
    app(fake, '/coaching');
    const tip = await screen.findByRole('heading', { level: 2, name: 'Ask "Have you had a chance to talk with a lender yet?"' });
    const article = tip.closest('article') as HTMLElement;
    expect(within(article).getByText('Asked about financing: missed in 3 of the last 4 calls')).toBeInTheDocument();
    const moments = within(article).getByRole('list', { name: 'Moments from the calls' });
    expect(within(moments).getAllByRole('listitem')).toHaveLength(2);
    expect(within(moments).getByText('“Thanks so much, talk soon.”')).toBeInTheDocument();
    expect(within(moments).getByText(/Words not shown/)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/score|grade|rank|%|\b\d+\s*\/\s*\d+\b/i);
    expect(await axeClean()).toEqual([]);
    await userEvent.setup().click(within(moments).getAllByRole('button', { name: 'Play this moment' })[0]!);
    await waitFor(() => expect(fake.callsTo(`POST /recordings/${REC}/stream-token`)).toHaveLength(1));
    const audio = (await screen.findByLabelText('Moment 1 of the call')) as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe(`/api/recordings/${REC}/stream?token=t#t=70,74.5`);
    expect(fake.callsTo(`POST /recordings/${REC}/stream-token`)[0]!.body).toEqual({ purpose: 'play' });
  });

  it('R-COACH-4: "Not now" sets today\'s tip aside in one tap and says when the next one comes', async () => {
    const fake = new FakeFetch()
      .on('GET /coaching/today', { status: 200, body: ready() })
      .on('POST /coaching/today/dismiss', { status: 200, body: ready({ fix: null, cardId: null, noFix: { reason: 'dismissed_today', text: 'You set today’s tip aside. A new one comes tomorrow.' } }) });
    app(fake, '/coaching');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('You set today’s tip aside. A new one comes tomorrow.')).toBeInTheDocument();
    expect(fake.callsTo('POST /coaching/today/dismiss')).toHaveLength(1);
  });

  it('E106: with two reviewed calls the page says "Not enough calls yet"', async () => {
    app(new FakeFetch().on('GET /coaching/today', { status: 200, body: ready({ fix: null, cardId: null, noFix: { reason: 'not_enough_calls', text: 'Not enough calls yet' } }) }), '/coaching');
    expect(await screen.findByText('Not enough calls yet')).toBeInTheDocument();
    expect(screen.getByText(/at least 3 of your recorded calls/)).toBeInTheDocument();
  });

  it('R-INT-6: while counsel has not reviewed call reviews the page says so, and shows no tip', async () => {
    app(new FakeFetch().on('GET /coaching/today', { status: 200, body: ready({ state: 'not_cleared', fix: null, cardId: null }) }), '/coaching');
    expect(await screen.findByRole('heading', { name: 'Call reviews are not on yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play this moment' })).toBeNull();
  });

  it('R-COACH-3: an agent never asks for the team; a Team Lead without the Owner\'s setting is told the tips are private', async () => {
    const agentFake = new FakeFetch().on('GET /coaching/today', { status: 200, body: ready() });
    const v = app(agentFake, '/coaching');
    await screen.findByRole('button', { name: 'Not now' });
    expect(agentFake.callsTo('GET /coaching/team')).toHaveLength(0);
    v.view.unmount();
    const team: { team: TeamView } = { team: { state: 'ready', visible: false, sentence: 'The Owner has not turned on Team Lead access to call reviews, so your team’s tips are private to each person.', members: [] } };
    app(new FakeFetch().on('GET /coaching/today', { status: 200, body: ready() }).on('GET /coaching/team', { status: 200, body: team }), '/coaching', 'team_lead');
    expect(await screen.findByText(/tips are private to each person/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Tips by person' })).toBeNull();
  });
});

const settings = (over: Partial<CoachingSettingsView> = {}): { settings: CoachingSettingsView } => ({
  settings: {
    pack: { cleared: false, version: '2026.11.0', reviewedAt: null, sentence: 'Not reviewed by counsel. Call reviews stay off until counsel reviews them (employee monitoring and call-recording law).' },
    scoringEnabled: false,
    tlSeesCallScores: false,
    rubric: [
      { key: 'asked_timeline', label: 'Asked about timeline', good: 'Asked when the lead hopes to move.', enabled: true },
      { key: 'recapped_call', label: 'Recapped the call', good: 'Summarised what was agreed.', enabled: true },
    ],
    scoringSentence: 'Call scoring cannot be turned on until counsel reviews it.',
    ...over,
  },
});

describe('the Owner\'s coaching settings', () => {
  it('R-INT-6: "Not reviewed by counsel" is said first and turning reviews on is not offered; axe finds nothing', async () => {
    app(new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }), '/admin/coaching', 'owner');
    expect(await screen.findByText('Not reviewed by counsel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn call reviews on' })).toBeDisabled();
    expect(await axeClean()).toEqual([]);
  });

  it('D-COACH R-COACH-3: Team Lead access is off by default and one tap turns it on (the whole setting is sent)', async () => {
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: settings({ pack: { cleared: true, version: '2026.11.0', reviewedAt: '2026-11-11T00:00:00Z', sentence: 'Counsel has reviewed call reviews.' }, scoringEnabled: true }) })
      .on('PUT /admin/coaching', (c) => ({ status: 200, body: settings({ ...(c.body as object), pack: { cleared: true, version: '2026.11.0', reviewedAt: '2026-11-11T00:00:00Z', sentence: 'Counsel has reviewed call reviews.' }, scoringEnabled: true, tlSeesCallScores: true }) }));
    app(fake, '/admin/coaching', 'owner');
    expect(await screen.findByRole('heading', { name: 'Team Leads do not see their team’s reviews' })).toBeInTheDocument();
    expect(screen.queryByText('Not reviewed by counsel')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Let Team Leads see them' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ scoringEnabled: true, tlSeesCallScores: true, disabledKeys: [] });
    expect(await screen.findByRole('heading', { name: 'Team Leads see their team’s reviews' })).toBeInTheDocument();
  });

  it('a checklist item can be turned off and saved; the last one cannot', async () => {
    const saved = settings();
    saved.settings.rubric[0]!.enabled = false;
    const fake = new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }).on('PUT /admin/coaching', { status: 200, body: saved });
    app(fake, '/admin/coaching', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('checkbox', { name: 'Asked about timeline' }));
    await u.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')[0]?.body).toEqual({ scoringEnabled: false, tlSeesCallScores: false, disabledKeys: ['asked_timeline'] }));
    await u.click(screen.getByRole('checkbox', { name: 'Recapped the call' }));
    expect(screen.getByText('Keep at least one item.')).toBeInTheDocument();
  });
});
