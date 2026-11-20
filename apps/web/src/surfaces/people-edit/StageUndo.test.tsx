// R-STG-5: the Undo of a stage change. The toast's Undo names the stage event it undoes (undoOf), so the server
// never starts a plan for it. A plan the change started keeps running: the toast says so plainly, offers Stop only
// when the server says this viewer may stop it, and never suggests that a message was recalled.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { reachability } from '../feed/lib/testing.js';
import { StagePill } from './StagePill.js';
import { ToastProvider } from './hooks.js';
import { type StageResponse, automationWords, undoneText } from './stageFlow.js';
import { detailsFixture, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const E = '01900000-0000-7000-8000-0000000e0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const EV2 = '01900000-0000-7000-8000-0000000e0003';
const PREVIEW = { allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged' };
const labelOf = (k: string) => guideFixture().find((s) => s.key === k)!.label;

function mount(o: { undo: StageResponse | 'refused'; stop?: 'ok' | 'refused' }) {
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C) } });
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: PREVIEW });
  fake.on(`POST /contacts/${C}/stage`, (call) => {
    const b = call.body as { stage: string; undoOf?: string };
    if (b.undoOf) return o.undo === 'refused' ? err(409, 'STAGE_UNDO_INVALID') : { status: 200, body: o.undo };
    return { status: 200, body: { stage: stageFixture('active'), previousStage: 'attempting', rowVersion: 2, eventId: EV, automation: { started: 'Buyer plan' }, automationSentence: 'Buyer plan started.', stillRunning: null } satisfies StageResponse };
  });
  if (o.stop) fake.on(`POST /enrollments/${E}/stop`, o.stop === 'ok' ? { status: 200, body: { enrollment: { id: E, state: 'stopped' }, changed: true } } : err(404, 'NOT_FOUND'));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <StagePill contactId={C} name="Dana Reyes" details={detailsFixture(C, 'attempting')} onCall={vi.fn()} onText={vi.fn()} onReplyChat={vi.fn()} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, u: userEvent.setup() };
}

async function changeThenUndo(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole('button', { name: 'Stage: Trying to reach. Change stage' }));
  const active = within(screen.getByRole('dialog')).getByRole('button', { name: 'Active client' });
  await waitFor(() => expect(active).toBeEnabled());
  await u.click(active);
  const toast = screen.getByTestId('people-toast');
  expect(await within(toast).findByText('Stage: Active client. Buyer plan started')).toBeInTheDocument();
  await u.click(within(toast).getByRole('button', { name: 'Undo' }));
  return toast;
}

const undone = (over: Partial<StageResponse> = {}): StageResponse => ({ stage: stageFixture('attempting'), previousStage: 'active', rowVersion: 3, eventId: EV2, automation: null, stillRunning: { enrollmentId: E, plan: 'Buyer plan', canStop: true }, ...over });

describe('R-STG-5 undo of a stage change', () => {
  it('Undo sends undoOf with the change\'s event id; the toast then says the plan is still running and that undo does not stop it, with Stop', async () => {
    const { fake, u } = mount({ undo: undone(), stop: 'ok' });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Stage back to Trying to reach. Buyer plan is still running; undo does not stop it.')).toBeInTheDocument();
    const posts = fake.callsTo(`POST /contacts/${C}/stage`);
    expect(posts.map((c) => c.body)).toEqual([{ stage: 'active' }, { stage: 'attempting', undoOf: EV }]);
    expect(toast.textContent).not.toMatch(/recall|unsent|taken back|cancel/i);
    await u.click(within(toast).getByRole('button', { name: 'Stop Buyer plan' }));
    await waitFor(() => expect(fake.callsTo(`POST /enrollments/${E}/stop`)).toHaveLength(1));
    expect(await within(toast).findByText('Stopped Buyer plan.')).toBeInTheDocument();
  });

  it('L1 (E779): an undo cannot be undone, so the undo\'s own toast offers no Undo, with or without a plan left running', async () => {
    const { fake, u } = mount({ undo: undone({ stillRunning: null }) });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Stage back to Trying to reach.')).toBeInTheDocument();
    expect(within(toast).queryByRole('button', { name: 'Undo' })).toBeNull();
    // exactly one request carried undoOf, and it named the change, never the undo's own event
    expect(fake.callsTo(`POST /contacts/${C}/stage`).filter((c) => (c.body as { undoOf?: string }).undoOf !== undefined).map((c) => c.body)).toEqual([{ stage: 'attempting', undoOf: EV }]);
  });

  it('L1 (E779): with a plan left running the undo\'s toast offers Stop and still no Undo', async () => {
    const { u } = mount({ undo: undone(), stop: 'ok' });
    const toast = await changeThenUndo(u);
    await within(toast).findByRole('button', { name: 'Stop Buyer plan' });
    expect(within(toast).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('L3 (E782): a PAUSED plan is not said to be running: "is still paused; undo does not resume or stop it", with Stop when the server allows it', async () => {
    const { u } = mount({ undo: undone({ stillRunning: { enrollmentId: E, plan: 'Buyer plan', state: 'paused', canStop: true } }), stop: 'ok' });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Stage back to Trying to reach. Buyer plan is still paused; undo does not resume or stop it.')).toBeInTheDocument();
    expect(toast.textContent).not.toMatch(/still running/);
    expect(within(toast).getByRole('button', { name: 'Stop Buyer plan' })).toBeInTheDocument();
    expect(undoneText(undone({ stillRunning: { enrollmentId: E, plan: 'Buyer plan', state: 'active', canStop: true } }), labelOf)).toBe('Stage back to Trying to reach. Buyer plan is still running; undo does not stop it.');
  });

  it('no Stop on the toast for a viewer the server would refuse; the sentence is the same', async () => {
    const { u } = mount({ undo: undone({ stillRunning: { enrollmentId: E, plan: 'Buyer plan', canStop: false } }) });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Stage back to Trying to reach. Buyer plan is still running; undo does not stop it.')).toBeInTheDocument();
    expect(within(toast).queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('L10 (E786): Stop on the undo\'s toast for a plan that had already ended says so, never "Stopped <plan>."', async () => {
    const { fake, u } = mount({ undo: undone() });
    fake.on(`POST /enrollments/${E}/stop`, { status: 200, body: { enrollment: { id: E, state: 'stopped' }, changed: false } });
    const toast = await changeThenUndo(u);
    await u.click(await within(toast).findByRole('button', { name: 'Stop Buyer plan' }));
    expect(await within(toast).findByText('Buyer plan had already been stopped. Nothing was changed.')).toBeInTheDocument();
    expect(toast.textContent).not.toMatch(/Stopped Buyer plan/);
  });

  it('a refused Stop says the server\'s reason and never that the plan stopped', async () => {
    const { u } = mount({ undo: undone(), stop: 'refused' });
    const toast = await changeThenUndo(u);
    await u.click(await within(toast).findByRole('button', { name: 'Stop Buyer plan' }));
    expect(await within(toast).findByText("Buyer plan was not stopped. This isn't available. It may have moved, or you may not have access to it.")).toBeInTheDocument();
    expect(toast.textContent).not.toMatch(/Stopped Buyer plan/);
  });

  it('an undo into a stage that has a plan of its own starts nothing, and says so', async () => {
    // L5: the words are the server's sentence for the skip reason `undo`
    const { u } = mount({ undo: undone({ stillRunning: null, automation: { skipped: 'undo', plan: 'Reach-out plan' }, automationSentence: 'Reach-out plan did not start: this change was an undo, and an undo never starts a plan.' }) });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Stage back to Trying to reach. Reach-out plan did not start: this change was an undo, and an undo never starts a plan.')).toBeInTheDocument();
  });

  it('an undo the server refuses (the stage changed again) says nothing was undone', async () => {
    const { u } = mount({ undo: 'refused' });
    const toast = await changeThenUndo(u);
    expect(await within(toast).findByText('Not undone: the stage has changed again since, so there is nothing to take back.')).toBeInTheDocument();
    expect(toast.textContent).not.toMatch(/Stage back to/);
  });

  it('the words: an undo is never said to recall a message, and the skip reason `undo` reads as words', () => {
    // L5: the skip reason `undo` is worded by the server; the web adds no reason of its own
    expect(automationWords({ automation: { skipped: 'undo', plan: 'P' }, automationSentence: 'P did not start: this change was an undo, and an undo never starts a plan.' })).toBe('P did not start: this change was an undo, and an undo never starts a plan.');
    expect(automationWords({ automation: { skipped: 'undo', plan: 'P' } })).toBe('P did not start');
    expect(undoneText(undone(), labelOf)).toBe('Stage back to Trying to reach. Buyer plan is still running; undo does not stop it.');
    expect(undoneText(undone({ stillRunning: null }), labelOf)).toBe('Stage back to Trying to reach.');
    // a plan still running is said first, even when the stage undone into has a plan of its own
    expect(undoneText(undone({ automation: { skipped: 'undo', plan: 'Other' } }), labelOf)).toBe('Stage back to Trying to reach. Buyer plan is still running; undo does not stop it.');
    for (const r of [undone(), undone({ stillRunning: null }), undone({ stillRunning: null, automation: { skipped: 'undo', plan: 'Other' } })]) expect(undoneText(r, labelOf)).not.toMatch(/recall|unsent|taken back|cancel|message/i);
  });
});
