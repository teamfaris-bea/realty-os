// The daily fix page and the Owner's coaching settings in jsdom on a scripted API (modules 40 and 41;
// R-COACH-2..6, R-INT-6, E106). The same pages run against the real API in e2e/coaching.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
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
    await waitFor(() => expect(audio).toHaveFocus());
  });

  it('R-COACH-4: "Not now" sets today\'s tip aside in one tap and says when the next one comes', async () => {
    const fake = new FakeFetch()
      .on('GET /coaching/today', { status: 200, body: ready() })
      .on('POST /coaching/today/dismiss', { status: 200, body: ready({ fix: null, cardId: null, noFix: { reason: 'dismissed_today', text: 'You set today’s tip aside. A new one comes tomorrow.' } }) });
    app(fake, '/coaching');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('You set today’s tip aside. A new one comes tomorrow.')).toBeInTheDocument();
    // focus moves to what replaced the card, not to <body>
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain('You set today’s tip aside');
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

  it('b7 ui/F8 (E283): reviews off reads the same to every role and blames no one (an Admin may have turned them off)', async () => {
    for (const role of ['agent', 'owner'] as const) {
      const v = app(new FakeFetch().on('GET /coaching/today', { status: 200, body: ready({ state: 'scoring_off', fix: null, cardId: null }) }), '/coaching', role);
      expect(await screen.findByRole('heading', { name: 'Call reviews are off' })).toBeInTheDocument();
      expect(screen.getByText('Call reviews are off for your team, so there is no tip today. Only the Owner can turn them on.')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/has not turned on/);
      v.view.unmount();
    }
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

describe('the team view', () => {
  it('R-COACH-3: each person\'s tip is labelled with their name and said about them, not in the agent\'s own words', async () => {
    const t = ready().coaching.fix!;
    const team: { team: TeamView } = { team: { state: 'ready', visible: true, sentence: 'From each person’s recent reviewed calls.', members: [{ userId: '01900000-0000-7000-8000-0000000000b1', name: 'Bea Agent', fix: { itemKey: t.itemKey, label: t.label, tip: t.tip, why: t.why, quotes: t.quotes }, noFix: null }] } };
    app(new FakeFetch().on('GET /coaching/today', { status: 200, body: ready() }).on('GET /coaching/team', { status: 200, body: team }), '/coaching', 'team_lead');
    const person = await screen.findByRole('listitem', { name: 'Bea Agent' });
    expect(within(person).getByText('Most missed lately')).toBeInTheDocument();
    expect(within(person).queryByText('Try this on your next call')).toBeNull();
    expect(within(person).getByRole('list', { name: 'Moments from Bea Agent’s calls' })).toBeInTheDocument();
    expect(await axeClean()).toEqual([]);
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
const CLEARED: CoachingSettingsView['pack'] = { cleared: true, version: '2026.11.0', reviewedAt: '2026-11-11T00:00:00Z', sentence: 'Counsel has reviewed call reviews.' };

describe('the Owner\'s coaching settings', () => {
  it('R-INT-6: "Not reviewed by counsel" is said first and turning reviews on is not offered; axe finds nothing', async () => {
    app(new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }), '/admin/coaching', 'owner');
    expect(await screen.findByText('Not reviewed by counsel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn call reviews on' })).toBeDisabled();
    expect(await axeClean()).toEqual([]);
  });

  it('D-COACH R-COACH-3: Team Lead access is off by default and one tap turns it on (only that setting is sent)', async () => {
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: settings({ pack: { cleared: true, version: '2026.11.0', reviewedAt: '2026-11-11T00:00:00Z', sentence: 'Counsel has reviewed call reviews.' }, scoringEnabled: true }) })
      .on('PUT /admin/coaching', (c) => ({ status: 200, body: settings({ ...(c.body as object), pack: { cleared: true, version: '2026.11.0', reviewedAt: '2026-11-11T00:00:00Z', sentence: 'Counsel has reviewed call reviews.' }, scoringEnabled: true, tlSeesCallScores: true }) }));
    app(fake, '/admin/coaching', 'owner');
    expect(await screen.findByRole('heading', { name: 'Team Leads do not see their team’s reviews' })).toBeInTheDocument();
    expect(screen.queryByText('Not reviewed by counsel')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Let Team Leads see them' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ tlSeesCallScores: true });
    expect(await screen.findByRole('heading', { name: 'Team Leads see their team’s reviews' })).toBeInTheDocument();
  });

  it('E283: each of the Owner\'s buttons sends only its own setting, so a page loaded before an Admin turned call reviews off saves the checklist without turning them back on, and then shows them off', async () => {
    // the page loaded while call reviews were on; since then an Admin turned them off (the API answers with the row as it is)
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: settings({ pack: CLEARED, scoringEnabled: true, scoringSentence: 'Calls a person handled are reviewed.' }) })
      .on('PUT /admin/coaching', (c) => {
        const now = settings({ pack: CLEARED, scoringEnabled: false, scoringSentence: 'Call scoring is off. No call is reviewed and no tips are shown.' });
        if ((c.body as { disabledKeys?: string[] }).disabledKeys?.includes('asked_timeline')) now.settings.rubric[0]!.enabled = false;
        return { status: 200, body: now };
      });
    app(fake, '/admin/coaching', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Call reviews are on' })).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: 'Asked about timeline' }));
    await u.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ disabledKeys: ['asked_timeline'] });
    expect(await screen.findByRole('heading', { name: 'Call reviews are off' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Asked about timeline' })).not.toBeChecked();
    // the switch sends only itself too
    await u.click(screen.getByRole('button', { name: 'Turn call reviews on' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(2));
    expect(fake.callsTo('PUT /admin/coaching')[1]!.body).toEqual({ scoringEnabled: true });
  });

  it('a switch keeps unsaved checklist edits, and says its result next to the switch', async () => {
    const fake = new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }).on('PUT /admin/coaching', { status: 200, body: settings({ tlSeesCallScores: true }) });
    app(fake, '/admin/coaching', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('checkbox', { name: 'Asked about timeline' }));
    await u.click(screen.getByRole('button', { name: 'Let Team Leads see them' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    // the switch sends only itself (never the unsaved checklist), and the unsaved edit survives
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ tlSeesCallScores: true });
    expect(await screen.findByRole('checkbox', { name: 'Asked about timeline' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save checklist' })).toBeEnabled();
    const tlCard = screen.getByRole('heading', { name: 'Team Leads see their team’s reviews' }).closest('section') as HTMLElement;
    expect(within(tlCard).getByText('Team Leads now see their team’s reviews.')).toBeInTheDocument();
  });

  it('E283: nothing changes for the Owner: every switch and the checklist stay live, and no "Only the Owner" sentence appears', async () => {
    app(new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings({ pack: CLEARED, scoringEnabled: true, scoringSentence: 'Calls a person handled are reviewed.' }) }), '/admin/coaching', 'owner');
    const off = await screen.findByRole('button', { name: 'Turn call reviews off' });
    expect(off).toBeEnabled();
    expect(off).not.toHaveAccessibleDescription();
    expect(screen.getByRole('button', { name: 'Let Team Leads see them' })).toBeEnabled();
    const items = screen.getByRole('group', { name: 'Checklist items' });
    expect(items).not.toHaveAccessibleDescription();
    for (const box of within(items).getAllByRole('checkbox')) expect(box).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save checklist' })).toBeInTheDocument();
    expect(screen.queryByText(/Only the Owner/)).toBeNull();
  });

  it('a checklist item can be turned off and saved; the last one cannot', async () => {
    const saved = settings();
    saved.settings.rubric[0]!.enabled = false;
    const fake = new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }).on('PUT /admin/coaching', { status: 200, body: saved });
    app(fake, '/admin/coaching', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('checkbox', { name: 'Asked about timeline' }));
    await u.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')[0]?.body).toEqual({ disabledKeys: ['asked_timeline'] }));
    await u.click(screen.getByRole('checkbox', { name: 'Recapped the call' }));
    expect(screen.getByText('Keep at least one item.')).toBeInTheDocument();
  });
});

describe('an Admin\'s coaching settings (E283: only the Owner turns call reviews on; an Admin can turn them off)', () => {
  const on = (over: Partial<CoachingSettingsView> = {}) => {
    const v = settings({ pack: CLEARED, scoringEnabled: true, tlSeesCallScores: true, scoringSentence: 'Calls a person handled are reviewed against the checklist.', ...over });
    v.settings.rubric[1]!.enabled = false;
    return v;
  };

  const OFF_SENTENCE = 'Call scoring is off. No call is reviewed and no tips are shown.';

  it('E283 R-COACH-1: an Admin opens the coaching settings; while call reviews are on, one tap turns them off and says so (only the switch is sent), and then no "on" button is offered; axe finds nothing', async () => {
    const start = on();
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: start })
      .on('PUT /admin/coaching', () => ({ status: 200, body: { settings: { ...start.settings, scoringEnabled: false, scoringSentence: OFF_SENTENCE } } }));
    app(fake, '/admin/coaching', 'admin');
    expect(await screen.findByRole('heading', { name: 'Call reviews are on' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Coaching settings' })).toBeInTheDocument();
    const off = screen.getByRole('button', { name: 'Turn call reviews off' });
    expect(off).toBeEnabled();
    expect(off).toHaveAccessibleDescription('Only the Owner can turn them on again.');
    expect(await axeClean()).toEqual([]);
    await userEvent.setup().click(off);
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ scoringEnabled: false });
    const heading = await screen.findByRole('heading', { name: 'Call reviews are off' });
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getByText('Call reviews are off. Today’s tips are gone.')).toBeInTheDocument();
    // now off: turning them on again is the Owner's, so the card offers no button, only the sentence
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByText('Only the Owner can turn call reviews on.')).toBeVisible();
    expect(await axeClean()).toEqual([]);
  });

  it('E283: once an Admin turned call reviews off, focus lands on the card heading (the switch is gone) only when it says "off" and the result is shown, so a screen reader reads the new state', async () => {
    const start = on();
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: start })
      .on('PUT /admin/coaching', () => ({ status: 200, body: { settings: { ...start.settings, scoringEnabled: false, scoringSentence: OFF_SENTENCE } } }));
    app(fake, '/admin/coaching', 'admin');
    const heading = await screen.findByRole('heading', { name: 'Call reviews are on' });
    // what is on the page at the moment focus lands, as a screen reader would announce it
    const landed: { heading: string | null; result: boolean }[] = [];
    heading.addEventListener('focus', () => landed.push({ heading: heading.textContent, result: screen.queryByText('Call reviews are off. Today’s tips are gone.') !== null }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn call reviews off' }));
    await waitFor(() => expect(heading).toHaveFocus());
    expect(landed).toEqual([{ heading: 'Call reviews are off', result: true }]);
  });

  it('E283 R-COACH-1: while call reviews are off, an Admin is told "Only the Owner can turn call reviews on." and offered no button that cannot work for them', async () => {
    const fake = new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings({ pack: CLEARED, scoringSentence: OFF_SENTENCE }) });
    app(fake, '/admin/coaching', 'admin');
    const card = (await screen.findByRole('heading', { name: 'Call reviews are off' })).closest('section') as HTMLElement;
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByText('Only the Owner can turn call reviews on.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Turn call reviews on' })).toBeNull();
    expect(await axeClean()).toEqual([]);
  });

  it('E283 R-INT-6: while counsel has not reviewed call reviews and they are off, an Admin is told both reasons, with no button', async () => {
    app(new FakeFetch().on('GET /admin/coaching', { status: 200, body: settings() }), '/admin/coaching', 'admin');
    expect(await screen.findByText('Not reviewed by counsel')).toBeInTheDocument();
    const card = screen.getByRole('heading', { name: 'Call reviews are off' }).closest('section') as HTMLElement;
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByText('Only the Owner can turn call reviews on.')).toBeVisible();
    expect(within(card).getByText('Waiting for counsel review.')).toBeVisible();
  });

  it('E283: paused call reviews (the switch on, counsel\'s review lapsed): an Admin reads that the switch is the Owner\'s and still turns call reviews off in one tap', async () => {
    const paused = settings({ scoringEnabled: true, scoringSentence: 'Paused: the Owner’s switch is on, but no call is reviewed and no tip is shown until counsel reviews call reviews.' });
    const fake = new FakeFetch().on('GET /admin/coaching', { status: 200, body: paused }).on('PUT /admin/coaching', { status: 200, body: settings() });
    app(fake, '/admin/coaching', 'admin');
    const card = (await screen.findByRole('heading', { name: 'Call reviews are paused' })).closest('section') as HTMLElement;
    expect(within(card).getByText('Paused: the Owner’s switch is on, but no call is reviewed and no tip is shown until counsel reviews call reviews.')).toBeInTheDocument();
    const off = within(card).getByRole('button', { name: 'Turn call reviews off' });
    expect(off).toHaveAccessibleDescription('Only the Owner can turn them on again.');
    await userEvent.setup().click(off);
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ scoringEnabled: false });
    expect(await screen.findByRole('heading', { name: 'Call reviews are off' })).toBeInTheDocument();
  });

  it('E283 R-COACH-3 D-COACH: Team Lead visibility and the checklist are read-only for an Admin, each with a sentence saying only the Owner changes it; axe finds nothing', async () => {
    app(new FakeFetch().on('GET /admin/coaching', { status: 200, body: on({ tlSeesCallScores: false }) }), '/admin/coaching', 'admin');
    const tlCard = (await screen.findByRole('heading', { name: 'Team Leads do not see their team’s reviews' })).closest('section') as HTMLElement;
    expect(within(tlCard).queryByRole('button')).toBeNull();
    expect(within(tlCard).getByText('Only the Owner can change whether Team Leads see call reviews.')).toBeInTheDocument();
    const items = screen.getByRole('group', { name: 'Checklist items' });
    expect(items).toHaveAccessibleDescription('Only the Owner can change what calls are checked for.');
    const boxes = within(items).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeDisabled();
    expect(within(items).getByRole('checkbox', { name: 'Asked about timeline' })).toBeChecked();
    expect(within(items).getByRole('checkbox', { name: 'Asked about timeline' })).toHaveAccessibleDescription('Asked when the lead hopes to move.');
    expect(within(items).getByRole('checkbox', { name: 'Recapped the call' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save checklist' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Team Leads/ })).toBeNull();
    expect(await axeClean()).toEqual([]);
  });

  it('E283: an Admin\'s "off" from a page loaded before the Owner let Team Leads see reviews goes through (only the switch is sent), and the page then shows the settings as they are now', async () => {
    const fake = new FakeFetch()
      .on('GET /admin/coaching', { status: 200, body: on({ tlSeesCallScores: false }) })
      // since the page loaded, the Owner let Team Leads see reviews: the API answers with the settings as they are now
      .on('PUT /admin/coaching', { status: 200, body: on({ scoringEnabled: false, tlSeesCallScores: true, scoringSentence: OFF_SENTENCE }) });
    app(fake, '/admin/coaching', 'admin');
    expect(await screen.findByRole('heading', { name: 'Team Leads do not see their team’s reviews' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn call reviews off' }));
    await waitFor(() => expect(fake.callsTo('PUT /admin/coaching')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/coaching')[0]!.body).toEqual({ scoringEnabled: false });
    expect(await screen.findByRole('heading', { name: 'Call reviews are off' })).toBeInTheDocument();
    expect(screen.getByText('Call reviews are off. Today’s tips are gone.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Team Leads see their team’s reviews' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('E283: if the API refuses an Admin\'s request anyway, the page says what an Admin can do and loads the settings again', async () => {
    let refused = false;
    const fake = new FakeFetch()
      .on('GET /admin/coaching', () => ({ status: 200, body: refused ? on({ scoringEnabled: false, scoringSentence: OFF_SENTENCE }) : on() }))
      .on('PUT /admin/coaching', () => {
        refused = true;
        return err(403, 'OWNER_REQUIRED');
      });
    app(fake, '/admin/coaching', 'admin');
    const off = await screen.findByRole('button', { name: 'Turn call reviews off' });
    const loads = fake.callsTo('GET /admin/coaching').length;
    await userEvent.setup().click(off);
    expect(await screen.findByText('Only the Owner can do that. An Admin can only turn call reviews off.')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo('GET /admin/coaching').length).toBeGreaterThan(loads));
    expect(await screen.findByRole('heading', { name: 'Call reviews are off' })).toBeInTheDocument();
  });
});
