// b19 Today fix 1 (H1, M2, M3; R-TODAY-11): a task is never closed or created without the agent seeing it named BEFORE
// the tap, in the sheet's PINNED footer beside the one button; the rule for replacing a task is core's
// (decideTaskReplacement); the old task is closed LAST; a partial save says exactly what was saved and what was not,
// and a retry finishes the rest without doubling anything. jsdom against a scripted API (the phone geometry of the
// footer is J11's to prove: jsdom lays nothing out).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StagePreview, StageResponse } from '../people-edit/stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from '../people-edit/testing.js';
import { FakeFetch, IDS, agentApp, card, decision, err, feed, fullContact, reachability } from './lib/testing.js';
import type { FeedCard } from './lib/types.js';

const EV = '01900000-0000-7000-8000-0000000e0002';
const OLD = '01900000-0000-7000-8000-0000000ta0d1';
const HOUR = 3_600_000;
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });
const VOICEMAIL = { stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A task card about a "Follow up with Dana" task: overdue by an hour unless `dueIn` says otherwise. */
function taskCard(o: { kind?: string; dueIn?: number; title?: string } = {}): FeedCard {
  const dueIn = o.dueIn ?? -HOUR;
  const title = o.title ?? 'Follow up with Dana';
  return card({
    itemType: 'task_due',
    contact: { id: IDS.jane, name: 'Dana Reyes' },
    task: { id: OLD, title },
    reasons: [{ code: 'TASK_OVERDUE', label: 'Overdue by 1 h' }],
    primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane },
    alternatives: [{ kind: 'text', label: 'Text', contactId: IDS.jane }, { kind: 'complete_task', label: 'Done', taskId: OLD }],
    subjectType: 'task',
    subjectId: OLD,
    why: ['Overdue by 1 h'],
    stage: { key: 'new', label: 'New lead' },
    nextPromise: { taskId: OLD, text: title, kind: o.kind ?? 'follow_up', dueAt: iso(dueIn), dueAllDay: false, deadlineAt: iso(dueIn), overdue: dueIn <= 0 },
  });
}

interface Script {
  /** the n-th POST /contacts/:id/stage: what it answers (default: the change) */
  stage?: (n: number) => 'ok' | 'network-error' | { status: number; body?: unknown };
  /** the n-th PATCH of the OLD task */
  close?: (n: number) => 'ok' | 'network-error' | { status: number; body?: unknown };
  /** the n-th POST /tasks is refused */
  refuseTask?: (n: number) => boolean;
}

function open(c: FeedCard, script: Script = {}) {
  const fake = new FakeFetch()
    .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } })
    .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: reachability(IDS.jane) })
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ displayName: 'Dana Reyes', firstName: 'Dana', lastName: 'Reyes' }) } })
    .on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details: detailsFixture(IDS.jane, 'new') } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [], total: 0 } })
    .on('GET /feed', { status: 200, body: feed([], [c]) })
    .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } })
    .on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'left_voicemail', recordedAs: 'call', suggestedStage: VOICEMAIL } })
    .on(`POST /contacts/${IDS.jane}/stage`, (call, n) => {
      const how = script.stage?.(n) ?? 'ok';
      if (how !== 'ok') return how;
      return { status: 200, body: { stage: stageFixture((call.body as { stage: string }).stage), previousStage: 'new', rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse };
    })
    .on(`PATCH /tasks/${OLD}`, (_c, n) => {
      const how = script.close?.(n) ?? 'ok';
      if (how !== 'ok') return how;
      return { status: 200, body: { task: { id: OLD, kind: 'follow_up', title: 'Follow up with Dana', dueAt: null, status: 'done', contact: null } } };
    });
  const notes = new Map<string, unknown>();
  fake.on(`POST /contacts/${IDS.jane}/activities`, (call) => {
    const b = call.body as { noteId: string };
    const replayed = notes.has(b.noteId);
    if (!replayed) notes.set(b.noteId, call.body);
    return { status: replayed ? 200 : 201, body: { note: { id: b.noteId }, taskId: null, suggestDoNotContact: false, suggestedStage: VOICEMAIL, replayed } };
  });
  for (const s of guideFixture()) fake.on(`GET /contacts/${IDS.jane}/stage/preview?to=${s.key}`, { status: 200, body: preview({ sameStage: s.key === 'new' }) });
  const tasks = fakeTaskStore(fake);
  if (script.refuseTask) {
    // (wraps the store: a refused POST stores nothing)
    const store = (fake as unknown as { handlers: Map<string, (call: unknown, n: number) => unknown> }).handlers.get('POST /tasks')!;
    let n = 0;
    fake.on('POST /tasks', (call, k) => {
      n += 1;
      return script.refuseTask!(n) ? err(422, 'VALIDATION_FAILED') : (store(call, k) as never);
    });
  }
  agentApp(fake);
  const u = userEvent.setup();
  return { fake, tasks, notes, u };
}

const theCard = () => screen.findByRole('article', { name: 'Dana Reyes' });
const footer = (sheet: HTMLElement) => within(sheet).getByTestId('dialog-footer');
const effects = (sheet: HTMLElement) => within(footer(sheet)).getByTestId('tap-effects');
const toastText = () => screen.getByTestId('people-toast').textContent ?? '';
/** the order the writes went out in */
const writes = (fake: FakeFetch) => fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(IDS.jane, ':id').replace(OLD, ':old')}`);

async function logFromCard(u: ReturnType<typeof userEvent.setup>, outcome: 'Talked' | 'Left voicemail') {
  await u.click(within(await theCard()).getByRole('button', { name: 'Log for Dana Reyes' }));
  const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
  await u.click(within(sheet).getByRole('button', { name: outcome }));
  await within(sheet).findByRole('radio', { name: /Suggested$/ });
  const save = within(sheet).getByTestId('log-save');
  await waitFor(() => expect(save).toBeEnabled());
  return { sheet, save };
}

describe('H1 (R-TODAY-11): what the tap will add and close is named in the pinned footer, beside the one button, before the tap', () => {
  it('Log → "Talked": the button is short, and under it, inside the footer: "Adds: … Marks done: Follow up with Dana (was due …)"', async () => {
    const { u, fake } = open(taskCard());
    const { sheet, save } = await logFromCard(u, 'Talked');
    expect(save).toHaveTextContent(/^Save and change to Connected$/);
    expect(footer(sheet)).toContainElement(save);
    expect(effects(sheet)).toHaveTextContent(/^Adds: Follow up with Dana, .+ 9:00 AM\. Marks done: Follow up with Dana \(was due (today \d{1,2}:\d{2} [AP]M|yesterday)\)\.$/);
    // the button is described by it, so a screen reader hears it with the button
    expect(save.getAttribute('aria-describedby')?.split(' ')).toContain(effects(sheet).id);
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // the old task is closed LAST: after the log, the new follow-up and the stage
    expect(writes(fake)).toEqual(['POST /contacts/:id/activities', 'POST /tasks', 'POST /contacts/:id/stage', 'PATCH /tasks/:old']);
    expect(fake.callsTo(`PATCH /tasks/${OLD}`).map((c) => c.body)).toEqual([{ status: 'done' }]);
    await waitFor(() => expect(toastText()).toMatch(/^Call logged \(talked\)\. Stage: Connected\. Follow-up saved for .+ 9:00 AM\. Marked done: “Follow up with Dana”/));
  });

  it('Log → "Left voicemail" names it the same way', async () => {
    const { u } = open(taskCard());
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    expect(save).toHaveTextContent(/^Save and change to Trying to reach$/);
    expect(effects(sheet)).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\. Marks done: Follow up with Dana \(was due (today \d{1,2}:\d{2} [AP]M|yesterday)\)\.$/);
  });

  it('Call → outcome: the stage step’s footer names it too', async () => {
    const { u, fake } = open(taskCard());
    await u.click(within(await theCard()).getByRole('button', { name: 'Call' }));
    const call = await screen.findByRole('dialog', { name: 'Call Dana Reyes' });
    await u.click(await within(call).findByRole('button', { name: 'Left voicemail' }));
    const step = await screen.findByRole('dialog', { name: 'Stage for Dana Reyes' });
    await within(step).findByRole('radio', { name: 'Trying to reach Suggested' });
    const confirm = within(step).getByTestId('stage-step-confirm');
    expect(confirm).toHaveTextContent(/^Change to Trying to reach$/);
    expect(footer(step)).toContainElement(confirm);
    expect(effects(step)).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\. Marks done: Follow up with Dana \(was due (today \d{1,2}:\d{2} [AP]M|yesterday)\)\.$/);
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(fake).slice(-3)).toEqual(['POST /tasks', 'POST /contacts/:id/stage', 'PATCH /tasks/:old']);
  });

  it('"None": nothing is added, so nothing is marked done, and the footer says neither', async () => {
    const { u, fake } = open(taskCard());
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    await u.click(within(sheet).getByRole('button', { name: 'None' }));
    expect(within(footer(sheet)).queryByTestId('tap-effects')).toBeNull();
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toEqual([]);
    expect(fake.callsTo('POST /tasks')).toEqual([]);
  });
});

describe('M3 (R-TODAY-11): a task that is not due is never closed; the sheet says the person will have two follow-ups', () => {
  it('a follow-up due tomorrow: left open, and said before the tap', async () => {
    const { u, fake, tasks } = open(taskCard({ dueIn: 18 * HOUR }));
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    expect(effects(sheet)).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\. Dana will have two follow-ups: “Follow up with Dana” \(due .+\) stays open\.$/);
    expect(effects(sheet)).not.toHaveTextContent(/Marks done/);
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toEqual([]);
    expect(tasks.open()).toHaveLength(1);
    expect(toastText()).not.toMatch(/Marked done/);
  });

  it('a callback that is not due is left open the same way; one that is overdue is replaced', async () => {
    const a = open(taskCard({ kind: 'callback', dueIn: 2 * HOUR, title: 'Call Dana back' }));
    const first = await logFromCard(a.u, 'Left voicemail');
    expect(effects(first.sheet)).toHaveTextContent(/Dana will have two follow-ups: “Call Dana back” \(due .+\) stays open\.$/);
    await a.u.click(first.save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(a.fake.callsTo(`PATCH /tasks/${OLD}`)).toEqual([]);
  });

  it('a promise the card is about stays open, and the footer says so', async () => {
    const { u, fake } = open(taskCard({ kind: 'promise', title: 'Send lender intro' }));
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    expect(effects(sheet)).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\. Stays open: Send lender intro\.$/);
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });
});

describe('M2 (R-TODAY-11): a partial save says exactly what was saved and what was not, and a retry finishes the rest once', () => {
  it('the log saved and the follow-up was refused: the stage is not tried, the old task stays open; the retry makes one of each', async () => {
    const { u, fake, tasks, notes } = open(taskCard(), { refuseTask: (n) => n === 1 });
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    await u.click(save);
    const alert = await within(footer(sheet)).findByRole('alert');
    expect(alert).toHaveTextContent(/^Saved: call logged \(left voicemail\)\. Not saved: the follow-up and the stage \(still New lead\)\. “Follow up with Dana” is still open\. /);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)).toEqual([]);
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toEqual([]);
    // what the next tap will do is still named
    expect(effects(sheet)).toHaveTextContent(/Marks done: Follow up with Dana/);
    await u.click(within(sheet).getByTestId('log-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(notes.size).toBe(1);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/activities`)).toHaveLength(1);
    expect(tasks.open()).toHaveLength(1);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)).toHaveLength(1);
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toHaveLength(1);
  });

  it('the log and the follow-up saved and the stage answer was lost (a 500): "not confirmed", the old task is NOT closed, and nothing says "it wasn’t saved"', async () => {
    const { u, fake, tasks } = open(taskCard(), { stage: (n) => (n === 1 ? { status: 500, body: { error: { code: 'INTERNAL_ERROR', requestId: 'r' } } } : 'ok') });
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    await u.click(save);
    const alert = await within(footer(sheet)).findByRole('alert');
    expect(alert).toHaveTextContent(/^Saved: call logged \(left voicemail\) and the follow-up for .+ 9:00 AM\. Not confirmed: the stage change\. “Follow up with Dana” is still open\. Something went wrong on our side\. Try again in a moment\.$/);
    expect(alert).not.toHaveTextContent(/wasn.t saved/);
    // M2: the old task is still open, because it is closed last
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toEqual([]);
    await u.click(within(sheet).getByTestId('log-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/activities`)).toHaveLength(1);
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(tasks.open()).toHaveLength(1);
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toHaveLength(1);
    await waitFor(() => expect(toastText()).toMatch(/Marked done: “Follow up with Dana”/));
  });

  it('everything saved and the close failed: said so, the stage is not sent again, and the retry only closes', async () => {
    const { u, fake, tasks } = open(taskCard(), { close: (n) => (n === 1 ? 'network-error' : 'ok') });
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    await u.click(save);
    const alert = await within(footer(sheet)).findByRole('alert');
    expect(alert).toHaveTextContent(/^Saved: call logged \(left voicemail\), the follow-up for .+ 9:00 AM and the stage \(Trying to reach\)\. Not confirmed: “Follow up with Dana” marked done\. Can't reach the server\. Check your connection, then try again\.$/);
    const again = within(sheet).getByTestId('log-save');
    expect(again).toHaveTextContent(/^Try again$/);
    expect(effects(sheet)).toHaveTextContent(/^Marks done: Follow up with Dana \(was due (today \d{1,2}:\d{2} [AP]M|yesterday)\)\.$/);
    await u.click(again);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/activities`)).toHaveLength(1);
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)).toHaveLength(1);
    expect(fake.callsTo(`PATCH /tasks/${OLD}`)).toHaveLength(2);
    expect(tasks.open()).toHaveLength(1);
    await waitFor(() => expect(toastText()).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM\. Marked done: “Follow up with Dana”/));
  });

  it('closing the sheet after such a partial save still says what WAS saved, with the stage’s Undo, and claims nothing else', async () => {
    const { u, fake } = open(taskCard(), { close: () => 'network-error' });
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    await u.click(save);
    await within(footer(sheet)).findByRole('alert');
    await u.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(toastText()).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+ 9:00 AM\. Still open: “Follow up with Dana”/));
    expect(toastText()).not.toMatch(/Marked done/);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)).toHaveLength(1);
  });
});

describe('M7 (R-TODAY-15) in the sheet: a row that leads with a promise and names another due task', () => {
  it('the footer names every due task of the row that stays open; nothing is marked done', async () => {
    const PROMISE = '01900000-0000-7000-8000-0000000ta0p1';
    const base = taskCard({ kind: 'promise', title: 'Send lender intro' });
    const row = { ...base, id: IDS.jane, itemType: 'promise_due', task: { id: PROMISE, title: 'Send lender intro' }, subjectId: PROMISE, nextPromise: { ...base.nextPromise!, taskId: PROMISE }, taskIds: [PROMISE, OLD], alsoDue: [{ taskId: OLD, title: 'Follow up with Dana' }], alsoDueMore: 0 };
    const { u, fake } = open(taskCard());
    fake.on('GET /feed', { status: 200, body: { ...feed(), followUpToday: { people: [row], total: 1, totalIsMinimum: false, checked: 1, complete: true } } });
    const { sheet, save } = await logFromCard(u, 'Left voicemail');
    expect(effects(sheet)).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\. Stays open: Send lender intro, Follow up with Dana\.$/);
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });
});
