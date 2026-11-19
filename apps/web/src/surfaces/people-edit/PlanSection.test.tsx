// R-STG-6: the follow-up dialog (Add follow-up on the panel, Next on the phone bar) makes ONE task however often its
// button is tapped: the task's id is made once per dialog, POST /tasks answers the same task for it again, and a
// retry after a lost answer sends the same id.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { ToastProvider } from './hooks.js';
import { TaskDialog } from './PlanSection.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mount(fake: FakeFetch) {
  fake.on('GET /auth/session', { status: 200, body: sessionFixture() });
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (key: string) => (
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <TaskDialog key={key} contactId={C} name="Dana Reyes" onClose={onClose} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
  const view = render(ui('a'));
  return { onClose, u: userEvent.setup(), reopen: () => view.rerender(ui('b')) };
}
const ids = (fake: FakeFetch) => fake.callsTo('POST /tasks').map((c) => (c.body as { id: string }).id);

describe('the follow-up dialog makes one task (R-STG-6)', () => {
  it('the task carries an id made for this dialog; two taps in the same frame send one request', async () => {
    const fake = new FakeFetch().on('POST /tasks', (c) => ({ status: 201, body: { task: { id: (c.body as { id: string }).id }, replayed: false } }));
    const { onClose } = mount(fake);
    const add = screen.getByRole('button', { name: 'Add task' });
    add.click();
    add.click();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(fake.callsTo('POST /tasks')[0]!.body).toMatchObject({ id: expect.stringMatching(UUID), title: 'Follow up with Dana', kind: 'follow_up', contactId: C });
  });

  it('a retry after a lost answer sends the same id, so the server answers the task the first try made', async () => {
    const fake = new FakeFetch().on('POST /tasks', (c, n) => (n === 1 ? 'network-error' : { status: 200, body: { task: { id: (c.body as { id: string }).id }, replayed: true } }));
    const { onClose, u } = mount(fake);
    await u.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection, then try again.");
    expect(onClose).not.toHaveBeenCalled();
    await u.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(ids(fake)).toHaveLength(2);
    expect(ids(fake)[0]).toMatch(UUID);
    expect(ids(fake)[0]).toBe(ids(fake)[1]);
  });

  it('a dialog opened again is a new task: its id is its own', async () => {
    const fake = new FakeFetch().on('POST /tasks', (c) => ({ status: 201, body: { task: { id: (c.body as { id: string }).id }, replayed: false } }));
    const { u, reopen } = mount(fake);
    await u.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(fake.callsTo('POST /tasks')).toHaveLength(1));
    reopen();
    await u.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(fake.callsTo('POST /tasks')).toHaveLength(2));
    expect(ids(fake)[0]).not.toBe(ids(fake)[1]);
  });
});
