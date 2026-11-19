// R-TODAY-7 (web): one pass from a follow-up card on Today. The card's Call, Text and Log open the SAME sheets the
// person's page uses (the call sheet with its outcome chips, the text sheet, the Log sheet), each going on to the same
// stage step, without leaving Today. Every tap is counted: a click that is not through `tap` does not exist here.
//
//   a call the app placed:        Call → outcome → the one button                 = 3 taps
//   a call made outside the app:  Log → outcome → the one button                  = 3 taps (4 with another follow-up day)
//
// to a logged outcome, a confirmed stage and a next step (the follow-up the sheet preselects and names on its button).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StagePreview, StageResponse } from '../people-edit/stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from '../people-edit/testing.js';
import { FakeFetch, IDS, agentApp, card, decision, feed, fullContact, reachability } from './lib/testing.js';
import type { FeedCard } from './lib/types.js';

const EV = '01900000-0000-7000-8000-0000000e0002';
const OLD_TASK = '01900000-0000-7000-8000-0000000ta0d1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });
const VOICEMAIL = { stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] };

function followCard(over: Partial<FeedCard> = {}): FeedCard {
  return card({
    itemType: 'promise_due',
    contact: { id: IDS.jane, name: 'Dana Reyes' },
    task: { id: IDS.task, title: 'Send lender intro' },
    reasons: [{ code: 'PROMISE_DUE', label: 'You promised this; due in 3 h' }],
    primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane },
    alternatives: [{ kind: 'text', label: 'Text', contactId: IDS.jane }, { kind: 'complete_task', label: 'Done', taskId: IDS.task }],
    subjectType: 'task',
    subjectId: IDS.task,
    why: ['You promised this; due in 3 h'],
    stage: { key: 'new', label: 'New lead' },
    nextPromise: { taskId: IDS.task, text: 'Send lender intro', kind: 'promise', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), dueAllDay: false, overdue: false },
    ...over,
  });
}

function open(c: FeedCard = followCard()) {
  const fake = new FakeFetch()
    .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } })
    .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: reachability(IDS.jane) })
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ displayName: 'Dana Reyes', firstName: 'Dana', lastName: 'Reyes' }) } })
    .on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details: detailsFixture(IDS.jane, 'new') } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [], total: 0 } })
    .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } })
    .on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'left_voicemail', recordedAs: 'call', suggestedStage: VOICEMAIL } })
    .on(`POST /contacts/${IDS.jane}/stage`, (call) => ({ status: 200, body: { stage: stageFixture((call.body as { stage: string }).stage), previousStage: 'new', rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse }))
    .on(`PATCH /tasks/${OLD_TASK}`, { status: 200, body: { task: { id: OLD_TASK, kind: 'follow_up', title: 'Follow up with Dana', dueAt: null, status: 'done', contact: null } } });
  const notes = new Map<string, unknown>();
  fake.on(`POST /contacts/${IDS.jane}/activities`, (call) => {
    const b = call.body as { noteId: string };
    const replayed = notes.has(b.noteId);
    if (!replayed) notes.set(b.noteId, call.body);
    return { status: replayed ? 200 : 201, body: { note: { id: b.noteId }, taskId: null, suggestDoNotContact: false, suggestedStage: VOICEMAIL, replayed } };
  });
  for (const s of guideFixture()) fake.on(`GET /contacts/${IDS.jane}/stage/preview?to=${s.key}`, { status: 200, body: preview({ sameStage: s.key === 'new' }) });
  // the feed after something was logged: the card's Last line is the server's new answer
  fake.on('GET /feed', () => ({
    status: 200,
    body: feed([], [notes.size > 0 || fake.callsTo(`POST /calls/${IDS.call}/outcome`).length > 0 ? { ...c, lastTouch: { kind: 'call', at: new Date().toISOString(), byName: 'Ava Agent', byMe: true, direction: 'outbound', outcome: 'left a voicemail', snippet: null, reported: notes.size > 0 } } : c]),
  }));
  const tasks = fakeTaskStore(fake);
  const app = agentApp(fake);
  const u = userEvent.setup();
  const n = { taps: 0 };
  const tap = async (el: HTMLElement) => {
    await u.click(el);
    n.taps += 1;
  };
  return { fake, tasks, notes, app, u, n, tap };
}

const theCard = () => screen.findByRole('article', { name: 'Dana Reyes' });
const toastText = () => screen.getByTestId('people-toast').textContent ?? '';

describe('one pass from a follow-up card on Today', () => {
  it('a call the app placed: Call → "Left voicemail" → the one button = 3 taps to a logged outcome, a confirmed stage and a next step, without leaving Today; the result is said once', async () => {
    const { fake, tasks, n, tap } = open();
    await tap(within(await theCard()).getByRole('button', { name: 'Call' })); // 1
    const call = await screen.findByRole('dialog', { name: 'Call Dana Reyes' });
    await tap(await within(call).findByRole('button', { name: 'Left voicemail' })); // 2
    const step = await screen.findByRole('dialog', { name: 'Stage for Dana Reyes' });
    expect(within(step).getByTestId('stage-step-saved')).toHaveTextContent('Voicemail logged');
    expect(await within(step).findByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    // the next step is preselected and said before the tap: Tomorrow, and the button is named for it
    expect(within(step).getByRole('button', { name: 'Tomorrow' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(step).getByTestId('follow-up-line')).toHaveTextContent(/^Will add a task for you: “Follow up with Dana”, due .+ 9:00 AM\.$/);
    const confirm = within(step).getByRole('button', { name: 'Change to Trying to reach + follow-up' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await tap(confirm); // 3
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n.taps).toBe(3);
    expect(fake.callsTo(`POST /calls/${IDS.call}/outcome`).map((c) => c.body)).toEqual([{ outcome: 'left_voicemail' }]);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`).map((c) => c.body)).toEqual([{ stage: 'attempting' }]);
    expect(tasks.open()).toHaveLength(1);
    expect(tasks.open()[0]).toMatchObject({ kind: 'follow_up', title: 'Follow up with Dana' });
    // said once, in one toast: what was logged, the stage, the follow-up
    await waitFor(() => expect(toastText()).toMatch(/^Voicemail logged\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM/));
    expect(screen.getByTestId('toast')).toBeEmptyDOMElement();
    // still on Today, and the card says the new last touch
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('follow-up-lines')).toHaveTextContent(/Call today .+, left a voicemail/));
  });

  it('a call made outside the app: Log → "Left voicemail" → the one button = 3 taps; it is saved as the agent’s own report (a note), never as a call the system placed', async () => {
    const { fake, tasks, notes, n, tap } = open();
    await tap(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' })); // 1
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' })); // 2
    expect(await within(sheet).findByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    expect(within(sheet).getByRole('button', { name: 'Tomorrow' })).toHaveAttribute('aria-pressed', 'true');
    const save = within(sheet).getByRole('button', { name: 'Save and change to Trying to reach + follow-up' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save); // 3
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n.taps).toBe(3);
    expect(notes.size).toBe(1);
    expect([...notes.values()][0]).toMatchObject({ kind: 'call', direction: 'outbound', outcome: 'left_voicemail', noteId: expect.stringMatching(UUID) });
    // no call was placed by the system
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/calls`)).toHaveLength(0);
    expect(tasks.open()).toHaveLength(1);
    await waitFor(() => expect(toastText()).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM/));
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    // the card updates in place, and says it as the agent's own report
    await waitFor(() => expect(screen.getByTestId('follow-up-lines')).toHaveTextContent(/Logged by you: called from your phone, left a voicemail/));
  });

  it('choosing another follow-up day is one more tap: 4, and the task is the day chosen', async () => {
    const { tasks, n, tap } = open();
    await tap(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' })); // 1
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' })); // 2
    await within(sheet).findByRole('radio', { name: 'Trying to reach Suggested' });
    await tap(within(sheet).getByRole('button', { name: '3 days' })); // 3
    const save = within(sheet).getByRole('button', { name: 'Save and change to Trying to reach + follow-up' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save); // 4
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n.taps).toBe(4);
    const due = new Date(tasks.open()[0]!.dueAt!);
    const want = new Date();
    want.setDate(want.getDate() + 3);
    expect([due.getDate(), due.getHours()]).toEqual([want.getDate(), 9]);
  });

  it('the preselected follow-up is only a preselection: "None" removes it, and then no task is made', async () => {
    const { tasks, tap } = open();
    await tap(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' }));
    await within(sheet).findByRole('radio', { name: 'Trying to reach Suggested' });
    await tap(within(sheet).getByRole('button', { name: 'None' }));
    const save = within(sheet).getByRole('button', { name: 'Save and change to Trying to reach' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(tasks.open()).toHaveLength(0);
  });

  it('Text opens the text sheet on Today (the same compose box), never the conversation page', async () => {
    const { tap } = open(followCard({ primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane }, alternatives: [{ kind: 'call', label: 'Call', contactId: IDS.jane }] }));
    await tap(within(await theCard()).getByRole('button', { name: 'Text' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Dana Reyes' });
    expect(await within(sheet).findByRole('textbox', { name: 'Text message' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Open the full conversation' })).toHaveAttribute('href', `/contacts/${IDS.jane}/thread`);
  });

  it('a due "Follow up with …" task the card is about is marked done by the same button when a new follow-up is set, and the sheet says so before the tap; a promise is never marked done for you', async () => {
    const followUpCard = followCard({
      itemType: 'task_due',
      task: { id: OLD_TASK, title: 'Follow up with Dana' },
      subjectId: OLD_TASK,
      alternatives: [{ kind: 'complete_task', label: 'Done', taskId: OLD_TASK }],
      nextPromise: { taskId: OLD_TASK, text: 'Follow up with Dana', kind: 'follow_up', dueAt: new Date(Date.now() - 3_600_000).toISOString(), dueAllDay: false, overdue: true },
    });
    const { fake, tap } = open(followUpCard);
    await tap(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' }));
    await within(sheet).findByRole('radio', { name: 'Trying to reach Suggested' });
    expect(within(sheet).getByTestId('follow-up-replaces')).toHaveTextContent('The new follow-up replaces “Follow up with Dana”, which is marked done.');
    const save = within(sheet).getByRole('button', { name: 'Save and change to Trying to reach + follow-up' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`PATCH /tasks/${OLD_TASK}`).map((c) => c.body)).toEqual([{ status: 'done' }]);
    // (the toast also carries its Undo button, so the sentence is matched up to its end, not the element's)
    await waitFor(() => expect(toastText()).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM\. Marked done: “Follow up with Dana”(Undo)?$/));
  });

  it('… and a promise the card is about is left open', async () => {
    const { fake, tap } = open();
    await tap(within(await theCard()).getByRole('button', { name: 'Log a call or conversation with Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await tap(within(sheet).getByRole('button', { name: 'Left voicemail' }));
    await within(sheet).findByRole('radio', { name: 'Trying to reach Suggested' });
    expect(within(sheet).queryByTestId('follow-up-replaces')).toBeNull();
    const save = within(sheet).getByRole('button', { name: 'Save and change to Trying to reach + follow-up' });
    await waitFor(() => expect(save).toBeEnabled());
    await tap(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('a card that is not a follow-up card keeps its actions as they were: no Log button, and Text goes to the conversation', async () => {
    const plain = card({ contact: { id: IDS.jane, name: 'Dana Reyes' }, primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane } });
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [plain]) }).on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } });
    agentApp(fake);
    const c = await theCard();
    expect(within(c).queryByRole('button', { name: /^Log a call or conversation/ })).toBeNull();
  });
});
