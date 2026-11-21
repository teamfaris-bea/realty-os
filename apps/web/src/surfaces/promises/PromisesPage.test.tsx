// Promises in jsdom: overdue first, one tap marks done, reschedule and log-a-call hit the existing routes.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { IDS, iso } from '../feed/lib/testing.js';
import type { TaskView } from '../feed/lib/types.js';
import { surface as promisesSurface } from './index.js';

function task(over: Partial<TaskView>): TaskView {
  return {
    id: IDS.task,
    kind: 'promise',
    title: 'Send the comps',
    notes: null,
    dueAt: iso(-3_600_000),
    dueAllDay: false,
    dueTz: null,
    status: 'open',
    completedAt: null,
    assigneeUserId: IDS.me,
    contact: { id: IDS.jane, name: 'Jane Doe' },
    dealId: null,
    listingId: null,
    createdByKind: 'user',
    needsReview: false,
    source: null,
    createdAt: iso(-86_400_000),
    ...over,
  };
}

const LIST = 'GET /tasks?status=open&kind=promise&limit=200&scope=mine';

function mount(tasks: TaskView[]) {
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on(LIST, { status: 200, body: { tasks } })
    .on(`PATCH /tasks/${IDS.task}`, { status: 200, body: { task: task({ status: 'done' }) } })
    .on(`POST /contacts/${IDS.jane}/activities`, { status: 201, body: { note: { id: 'n' } } });
  renderApp({ fake, path: '/promises', table: tableWith(promisesSurface) });
  return fake;
}

describe('Promises', () => {
  it('lists an overdue promise first, marks it done in one tap, and can reschedule or log the call', async () => {
    const overdue = task({});
    const later = task({ id: '01900000-0000-7000-8000-0000000ta002', title: 'Call about the listing', dueAt: iso(2 * 86_400_000) });
    const fake = mount([later, overdue]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Promises' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Overdue' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe('Overdue');
    expect(headings.indexOf('Overdue')).toBeLessThan(headings.indexOf('Upcoming'));
    const row = screen.getByText('Send the comps').closest('section')!;
    expect(within(row).getByText(/Overdue/)).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(within(row).getByRole('button', { name: 'Done' }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Done: Send the comps');
    expect(fake.callsTo(`PATCH /tasks/${IDS.task}`)[0]!.body).toEqual({ status: 'done' });
    await u.click(within(row).getByRole('button', { name: 'Log a call' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/activities`)).toHaveLength(1));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/activities`)[0]!.body).toMatchObject({ kind: 'call', outcome: 'connected' });
  });
});
