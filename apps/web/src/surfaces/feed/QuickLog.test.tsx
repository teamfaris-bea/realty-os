// R-TODAY-9 (web): "Log a call or conversation" from any screen. One small entry beside the header's "+", on every
// page, phone and desktop: pick a person (most recent people first, or search), then the same Log sheet as on the
// person's page and on Today, with its stage step. Every tap is counted.
//
//   the entry → a person → an outcome → the one button = 4 taps from any page WHEN the person is one of the caller's
//   own recent people (M11, R-TODAY-18); otherwise 4 taps and typing their name (typing is not a tap, and is said)
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { StagePreview, StageResponse } from '../people-edit/stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from '../people-edit/testing.js';
import { FakeFetch, IDS, agentApp, feed } from './lib/testing.js';

const EV = '01900000-0000-7000-8000-0000000e0002';
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });
const person = (id: string, displayName: string, stage = 'connected') => ({ id, displayName, stage, intent: null, contactType: 'lead', owner: null, sourceName: null, lastActivityAt: new Date().toISOString(), createdAt: new Date().toISOString(), nextTaskDueAt: null, tags: [] });
const RECENT = [person(IDS.jane, 'Dana Reyes'), person(IDS.pat, 'Pat Lindqvist', 'new')];

function open(path = '/', role: Parameters<typeof agentApp>[2] = 'agent', o: { people?: 'error' | 'empty'; hold?: Promise<void> } = {}) {
  const fake = new FakeFetch()
    .on('GET /feed', { status: 200, body: feed() })
    .on('GET /activities/recent-people', o.people === 'error' ? { status: 500, body: { error: { code: 'INTERNAL_ERROR', requestId: 'r' } } } : { status: 200, body: { people: o.people === 'empty' ? [] : RECENT.map((p) => ({ id: p.id, name: p.displayName })) } })
    // (M11: the People page's own list, ordered by the system's activity and the whole team's for a Team Lead, is NOT what the picker reads)
    .on('GET /people?sort=last_activity_desc', { status: 200, body: { people: [person(IDS.offer, 'Somebody Else')], nextCursor: null, sort: 'last_activity_desc', list: null, scope: 'people_you_can_see', audienceProtected: false } })
    .on('GET /search?q=pat', { status: 200, body: { contacts: [{ id: IDS.pat, name: 'Pat Lindqvist', view: 'full', ownershipState: 'owned', matchedOn: 'name' }, { id: IDS.offer, name: 'Pat L.', view: 'card', ownershipState: 'in_pond', matchedOn: 'name' }], listings: [], deals: [], notes: [], messages: [], incomplete: [] } })
    .on('GET /search?q=zz', { status: 200, body: { contacts: [], listings: [], deals: [], notes: [], messages: [], incomplete: [] } });
  for (const id of [IDS.jane, IDS.pat]) {
    fake.on(`GET /contacts/${id}/details`, { status: 200, body: { details: detailsFixture(id, 'new') } });
    for (const s of guideFixture()) fake.on(`GET /contacts/${id}/stage/preview?to=${s.key}`, { status: 200, body: preview({ sameStage: s.key === 'new' }) });
    fake.on(`POST /contacts/${id}/stage`, (call) => ({ status: 200, body: { stage: stageFixture((call.body as { stage: string }).stage), previousStage: 'new', rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse }));
  }
  const notes = new Map<string, unknown>();
  fake.on(`POST /contacts/${IDS.pat}/activities`, async (call) => {
    if (o.hold) await o.hold;
    const b = call.body as { noteId: string };
    const replayed = notes.has(b.noteId);
    if (!replayed) notes.set(b.noteId, call.body);
    return { status: replayed ? 200 : 201, body: { note: { id: b.noteId }, taskId: null, suggestDoNotContact: false, suggestedStage: null, replayed } };
  });
  const tasks = fakeTaskStore(fake);
  agentApp(fake, path, role);
  const u = userEvent.setup();
  const n = { taps: 0 };
  const tap = async (el: HTMLElement) => {
    await u.click(el);
    n.taps += 1;
  };
  return { fake, notes, tasks, u, n, tap };
}

const entry = () => screen.findByRole('button', { name: 'Log a call or conversation' });
const picker = () => screen.findByRole('dialog', { name: 'Log a call or conversation' });

describe('R-TODAY-9: "Log a call or conversation" from any screen', () => {
  it.each([
    ['Today', '/', 'Home'],
    ['Search', '/search', 'Search'],
    ['Tasks', '/tasks', 'Tasks'],
  ])('the entry is in the header of %s, beside "+", and "+" still opens Add person in one tap', async (_n, path, title) => {
    open(path);
    await screen.findByRole('heading', { level: 1, name: title });
    const e = await entry();
    const plus = screen.getByRole('link', { name: 'Add person' });
    expect(plus).toHaveAttribute('href', '/people/new');
    // one header, the entry directly before the "+"
    expect(e.closest('header')).toBe(plus.closest('header'));
    expect(e.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // a full tap target, and its name contains the word it shows
    expect(e.className).toMatch(/min-h-tap/);
    expect(e.className).toMatch(/min-w-tap/);
    expect(e).toHaveTextContent(/^Log/);
  });

  it('E855: a Transaction Coordinator, who cannot log an activity, is not offered it', async () => {
    open('/', 'tc');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.queryByRole('button', { name: 'Log a call or conversation' })).toBeNull();
  });

  it('4 taps when the person is recent (the entry → the person → an outcome → the one button); otherwise 4 taps and typing. On a page that is not Today; saved as a logged call with a client id; the result is said once', async () => {
    const { notes, tasks, fake, n, tap, u } = open('/search');
    await tap(await entry()); // 1
    const p = await picker();
    // most recent people first, in the server's order, before anything is typed
    const rows = await within(p).findAllByRole('button', { name: /^Log for / });
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Log for Dana Reyes', 'Log for Pat Lindqvist']);
    expect(within(p).getByText('Recent people')).toBeInTheDocument();
    await tap(rows[1]!); // 2
    const sheet = await screen.findByRole('dialog', { name: 'Log for Pat Lindqvist' });
    // an outside call is the sheet's first choice: "I called from my phone", now
    expect(within(sheet).getByRole('button', { name: 'Call', pressed: true })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'I called from my phone', pressed: true })).toBeInTheDocument();
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' })); // 3
    const save = await within(sheet).findByRole('button', { name: 'Save and change to Trying to reach' });
    // (b19 Today fix 1, R-TODAY-11: the task the button adds is named under it before the tap)
    expect(within(within(sheet).getByTestId('dialog-footer')).getByTestId('tap-effects')).toHaveTextContent(/^Adds: Follow up with Pat, tomorrow 9:00 AM\.$/);
    await waitFor(() => expect(save).toBeEnabled());
    const readsBefore = fake.callsTo('GET /activities/recent-people').length;
    await tap(save); // 4
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n.taps).toBe(4);
    expect([...notes.values()]).toEqual([expect.objectContaining({ kind: 'call', direction: 'outbound', outcome: 'left_voicemail', noteId: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
    expect(fake.callsTo(`POST /contacts/${IDS.pat}/calls`)).toHaveLength(0);
    expect(tasks.open()).toHaveLength(1);
    // ONE toast stack on the page (the entry shares the page's), and the result is in it once
    expect(screen.getAllByTestId('people-toast')).toHaveLength(1);
    expect(screen.getByTestId('people-toast').textContent).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM/);
    // still on the page the agent was on
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
    // the lists behind the sheet are read again once it closes (the People page showed the old stage under a toast
    // that said the new one): the people list the picker and the People page read
    await u.click(await entry());
    await within(await picker()).findAllByRole('button', { name: /^Log for / });
    await waitFor(() => expect(fake.callsTo('GET /activities/recent-people').length).toBeGreaterThan(readsBefore));
  });

  it('E855: typing a name searches (from 2 letters); a person the viewer sees only as a card is not offered', async () => {
    const { u } = open('/tasks');
    await u.click(await entry());
    const p = await picker();
    await u.type(within(p).getByRole('searchbox', { name: 'Who was it with?' }), 'pat');
    await within(p).findByText('People found');
    await waitFor(() => expect(within(p).queryByRole('button', { name: 'Log for Dana Reyes' })).toBeNull());
    const rows = await within(p).findAllByRole('button', { name: /^Log for / });
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Log for Pat Lindqvist']);
    expect(within(p).queryByText('Pat L.')).toBeNull();
  });

  it('R-TODAY-8: loading, nobody yet, nobody matching and an error are each said in plain words', async () => {
    const { u } = open('/', 'agent', { people: 'empty' });
    await u.click(await entry());
    const p = await picker();
    expect(await within(p).findByText('Nobody recent yet: people you log for, note or call show here. Type a name, phone or email to find anyone else.')).toBeInTheDocument();
    await u.type(within(p).getByRole('searchbox', { name: 'Who was it with?' }), 'zz');
    expect(await within(p).findByText('Nobody you can see matches “zz”.')).toBeInTheDocument();
  });
  it('… an error offers Try again', async () => {
    const { u } = open('/', 'agent', { people: 'error' });
    await u.click(await entry());
    const p = await picker();
    expect(await within(p).findByText("Can't load your people")).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('E851: a double tap on the one button makes one record: one request, one client id', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { notes, fake, u } = open('/', 'agent', { hold });
    await u.click(await entry());
    await u.click(await within(await picker()).findByRole('button', { name: 'Log for Pat Lindqvist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Pat Lindqvist' });
    await u.click(within(sheet).getByRole('button', { name: 'No answer' }));
    const save = await within(sheet).findByRole('button', { name: /^Save and / });
    await waitFor(() => expect(save).toBeEnabled());
    await u.dblClick(save);
    await u.click(save);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`POST /contacts/${IDS.pat}/activities`)).toHaveLength(1);
    expect(notes.size).toBe(1);
  });

  it('Escape closes the picker and focus returns to the entry; the picker has no accessibility violations', async () => {
    const { u } = open('/');
    const e = await entry();
    await u.click(e);
    const p = await picker();
    await within(p).findAllByRole('button', { name: /^Log for / });
    const r = await axe.run(document.body, { rules: { region: { enabled: false }, 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
    for (const b of within(p).getAllByRole('button', { name: /^Log for / })) expect(b.className).toMatch(/min-h-tap/);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(e).toHaveFocus();
  });

  it('R-TODAY-10 E857: with the on-screen keyboard up (a shorter visual viewport) the sheet opened from the entry ends where the keyboard begins, its one button inside it', async () => {
    type Listener = () => void;
    const listeners = new Map<string, Set<Listener>>();
    const vv = { height: 664, offsetTop: 0, scale: 1, addEventListener: (t: string, fn: Listener) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn), removeEventListener: (t: string, fn: Listener) => void listeners.get(t)?.delete(fn) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    try {
      const { u } = open('/');
      await u.click(await entry());
      await u.click(await within(await picker()).findByRole('button', { name: 'Log for Pat Lindqvist' }));
      const sheet = await screen.findByRole('dialog', { name: 'Log for Pat Lindqvist' });
      const frame = screen.getByTestId('dialog-frame');
      expect(frame.style.height).toBe('664px');
      // the keyboard opens over the note field: 336 px less to see
      Object.assign(vv, { height: 328, offsetTop: 12 });
      act(() => listeners.get('resize')?.forEach((fn) => fn()));
      expect(frame.style.height).toBe('328px');
      expect(frame.style.top).toBe('12px');
      expect(frame).toContainElement(sheet);
      expect(sheet.lastElementChild).toContainElement(within(sheet).getByTestId('log-save'));
    } finally {
      Reflect.deleteProperty(window, 'visualViewport');
    }
  });
});

describe('M11 (R-TODAY-18): "Recent people" is the caller’s own recent activity', () => {
  it('the picker reads the caller’s own recent people, never the People page’s list (the system’s activity; the whole team’s for a Team Lead)', async () => {
    const { u, fake } = open('/', 'team_lead');
    await u.click(await entry());
    const p = await picker();
    const rows = await within(p).findAllByRole('button', { name: /^Log for / });
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Log for Dana Reyes', 'Log for Pat Lindqvist']);
    expect(within(p).queryByText('Somebody Else')).toBeNull();
    expect(fake.callsTo('GET /activities/recent-people').length).toBeGreaterThan(0);
    expect(fake.callsTo('GET /people?sort=last_activity_desc')).toHaveLength(0);
    // what the list is, said where it is
    expect(within(p).getByText('People you logged for, noted or called most recently.')).toBeInTheDocument();
  });

  it('E893: someone who is not recent is found by typing: the entry, typing, the person, an outcome, the one button = 4 taps and typing', async () => {
    const { u, n, tap } = open('/', 'agent', { people: 'empty' });
    await tap(await entry()); // 1
    const p = await picker();
    await within(p).findByText(/^Nobody recent yet/);
    await u.type(within(p).getByRole('searchbox', { name: 'Who was it with?' }), 'pat');
    await tap(await within(p).findByRole('button', { name: 'Log for Pat Lindqvist' })); // 2
    const sheet = await screen.findByRole('dialog', { name: 'Log for Pat Lindqvist' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' })); // 3
    const save = await within(sheet).findByRole('button', { name: 'Save and change to Trying to reach' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save); // 4
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n.taps).toBe(4);
  });
});
