// M1 (b19 fix pass; E773, E774): the follow-up the screen names is the one the server stored. The sheet's task is
// posted with one id, and the server never rewrites a stored task on a replay, so the words on the screen come from
// the task ROUTES' ANSWERS, never from the chips:
//   - once a task is saved the sheet says "Follow-up saved for <the server's date>" and the chips are locked;
//   - "Change" really changes it (PATCH /tasks/:id), "None" really removes it (status canceled), and a follow-up
//     chosen after that is a new task with a new id;
//   - a retry after a lost answer whose chip changed in between ends with the stored task at the date on the screen;
//   - the toast is built from the task the server answered.
// jsdom against a scripted API whose task store behaves as POST /tasks and PATCH /tasks/:id do.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, type Reply, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { formatDateTime } from '../feed/lib/format.js';
import { ToastProvider } from './hooks.js';
import { StageStep, morningIn } from './StageStep.js';
import type { StagePreview, StageResponse } from './stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });

function mount(o: { stage?: (n: number) => Reply | null; lose?: (n: number) => boolean; failPatch?: () => boolean } = {}) {
  const details = detailsFixture(C, 'new');
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/details`, { status: 200, body: { details } });
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: preview({ sameStage: s.key === 'new' }) });
  fake.on(`POST /contacts/${C}/stage`, (call, n) => {
    const scripted = o.stage?.(n);
    if (scripted) return scripted;
    const to = (call.body as { stage: string }).stage;
    return { status: 200, body: { stage: stageFixture(to), previousStage: 'new', rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse };
  });
  const tasks = fakeTaskStore(fake, { ...(o.lose ? { lose: o.lose } : {}), ...(o.failPatch ? { failPatch: o.failPatch } : {}) });
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <StageStep contactId={C} contactName="Dana Reyes" saved="Voicemail logged" suggested={{ stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] }} onClose={onClose} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, tasks, onClose, u: userEvent.setup() };
}

const sheet = () => screen.findByRole('dialog', { name: 'Stage for Dana Reyes' });
const ready = async () => {
  const s = await sheet();
  await within(s).findByRole('radiogroup', { name: 'Stage' });
  return s;
};
const line = () => screen.getByTestId('follow-up-line');
const toast = () => screen.getByTestId('people-toast');
const confirmButton = (s: HTMLElement) => within(s).getByTestId('stage-step-confirm');
const at = (d: Date) => formatDateTime(d.toISOString());
/** every date and time the screen shows, as formatDateTime writes them ("Fri, Nov 20, 9:00 AM") */
const datesOnScreen = () => [...document.body.textContent!.matchAll(/[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/g)].map((m) => m[0]);

describe('M1: the follow-up the screen names is the one the server stored', () => {
  it('the task is saved, the stage change then fails: the sheet says "Follow-up saved for <the server\'s date>", the chips are locked, and it never says "No follow-up task." while one is stored', async () => {
    const { tasks, onClose, u } = mount({ stage: (n) => (n === 1 ? 'network-error' : null) });
    const s = await ready();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(confirmButton(s)).toBeEnabled());
    await u.click(confirmButton(s));
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server.");
    expect(onClose).not.toHaveBeenCalled();
    expect(tasks.open()).toHaveLength(1);
    const stored = tasks.open()[0]!;
    expect(line()).toHaveTextContent(`Follow-up saved for ${formatDateTime(stored.dueAt!)}.`);
    // the stored task cannot be contradicted by a chip: every chip is locked until "Change"
    for (const chip of ['None', 'Tomorrow', '3 days', '1 week', 'Pick a date']) expect(within(s).getByRole('button', { name: chip })).toBeDisabled();
    await u.click(within(s).getByRole('button', { name: 'None' }));
    expect(line()).not.toHaveTextContent('No follow-up task.');
    expect(tasks.open()).toHaveLength(1);
    // the button no longer promises a follow-up it would not make again
    expect(confirmButton(s)).toHaveTextContent(/^Change to Trying to reach$/);
    await u.click(confirmButton(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await within(toast()).findByText(`Stage: Trying to reach. Follow-up saved for ${formatDateTime(stored.dueAt!)}`)).toBeInTheDocument();
    expect(tasks.open()).toEqual([stored]);
  });

  it('"Change" really changes the stored task: 1 week is a PATCH of that task, and the sheet and the toast say the date the server answered', async () => {
    const { fake, tasks, onClose, u } = mount({ stage: (n) => (n === 1 ? 'network-error' : null) });
    const s = await ready();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(confirmButton(s)).toBeEnabled());
    await u.click(confirmButton(s));
    await within(s).findByRole('alert');
    const id = tasks.open()[0]!.id;
    await u.click(within(s).getByRole('button', { name: 'Change follow-up' }));
    await u.click(within(s).getByRole('button', { name: '1 week' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /tasks/${id}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /tasks/${id}`)[0]!.body).toEqual({ dueAt: morningIn(7).toISOString() });
    await waitFor(() => expect(line()).toHaveTextContent(`Follow-up saved for ${at(morningIn(7))}.`));
    // every date on the screen is the stored task's
    expect(new Set(datesOnScreen())).toEqual(new Set([formatDateTime(tasks.open()[0]!.dueAt!)]));
    await u.click(confirmButton(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await within(toast()).findByText(`Stage: Trying to reach. Follow-up saved for ${at(morningIn(7))}`)).toBeInTheDocument();
    // one task, never a second one, at the date the screen said
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(tasks.open().map((t) => t.dueAt)).toEqual([morningIn(7).toISOString()]);
  });

  it('"Change" then "None" really removes it (the task is canceled by its route); a follow-up chosen after that is a NEW task with a new id', async () => {
    const { fake, tasks, onClose, u } = mount({ stage: (n) => (n === 1 ? 'network-error' : null) });
    const s = await ready();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(confirmButton(s)).toBeEnabled());
    await u.click(confirmButton(s));
    await within(s).findByRole('alert');
    const first = tasks.open()[0]!.id;
    await u.click(within(s).getByRole('button', { name: 'Change follow-up' }));
    await u.click(within(s).getByRole('button', { name: 'None' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /tasks/${first}`).map((c) => c.body)).toEqual([{ status: 'canceled' }]));
    await waitFor(() => expect(line()).toHaveTextContent('Follow-up removed. No follow-up task.'));
    expect(tasks.open()).toHaveLength(0);
    await u.click(within(s).getByRole('button', { name: '3 days' }));
    await u.click(confirmButton(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const ids = fake.callsTo('POST /tasks').map((c) => (c.body as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(tasks.open().map((t) => [t.id, t.dueAt])).toEqual([[ids[1], morningIn(3).toISOString()]]);
    expect(await within(toast()).findByText(`Stage: Trying to reach. Follow-up saved for ${at(morningIn(3))}`)).toBeInTheDocument();
  });

  it('a lost answer, then another chip, then a retry: the server replays the FIRST task, so the sheet changes it for real, and the toast says the date that is stored', async () => {
    // the first POST is stored (tomorrow) but its answer never arrives
    const { fake, tasks, onClose, u } = mount({ lose: (n) => n === 1 });
    const s = await ready();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(confirmButton(s)).toBeEnabled());
    await u.click(confirmButton(s));
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server.");
    // nothing was confirmed to the sheet, so nothing is claimed and the chips are still free
    expect(line()).not.toHaveTextContent(/Follow-up saved/);
    await u.click(within(s).getByRole('button', { name: '1 week' }));
    await u.click(confirmButton(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const said = /Follow-up saved for (.+)$/.exec((await within(toast()).findByText(/Follow-up saved for /)).textContent ?? '')![1]!;
    expect(tasks.open()).toHaveLength(1);
    expect(said).toBe(formatDateTime(tasks.open()[0]!.dueAt!));
    expect(said).toBe(at(morningIn(7)));
    expect(fake.callsTo('POST /tasks').map((c) => (c.body as { id: string }).id)).toHaveLength(2);
  });

  it('when that change is refused too, the sheet says the date that IS stored, stays open and does not change the stage', async () => {
    const { fake, tasks, onClose, u } = mount({ lose: (n) => n === 1, failPatch: () => true });
    const s = await ready();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(confirmButton(s)).toBeEnabled());
    await u.click(confirmButton(s));
    await within(s).findByRole('alert');
    await u.click(within(s).getByRole('button', { name: '1 week' }));
    await u.click(confirmButton(s));
    await waitFor(() => expect(line()).toHaveTextContent(`Follow-up saved for ${at(morningIn(1))}.`));
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.callsTo(`POST /contacts/${C}/stage`)).toHaveLength(0);
    expect(tasks.open().map((t) => t.dueAt)).toEqual([morningIn(1).toISOString()]);
    expect(datesOnScreen()).not.toContain(at(morningIn(7)));
  });

  it('with "Keep", the toast of the follow-up alone is the server\'s date too', async () => {
    const { tasks, onClose, u } = mount();
    const s = await ready();
    await u.click(within(s).getByRole('radio', { name: 'Keep New lead' }));
    await u.click(within(s).getByRole('button', { name: '3 days' }));
    await u.click(confirmButton(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await within(toast()).findByText(`Follow-up saved for ${formatDateTime(tasks.open()[0]!.dueAt!)}`)).toBeInTheDocument();
  });
});
