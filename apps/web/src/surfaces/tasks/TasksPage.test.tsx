// Tasks in jsdom: grouping by due time, Done in one tap, promise tasks with their evidence, and a
// promise whose date the assistant could not pin shown with "Check this" and no due date (R-AST-5:
// a needs-review claim never becomes a due date on its own), plus appointments awaiting an outcome.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, iso } from '../feed/lib/testing.js';
import type { AppointmentView, TaskView } from '../feed/lib/types.js';
import { groupOf } from './TasksPage.js';

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: IDS.task,
    kind: 'todo',
    title: 'Send the disclosures',
    notes: null,
    dueAt: iso(3_600_000),
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

function tasksFake(tasks: TaskView[], appts: AppointmentView[] = []) {
  return new FakeFetch().on('GET /tasks?status=open&limit=200', { status: 200, body: { tasks } }).on('GET /appointments?awaitingOutcome=true', { status: 200, body: { appointments: appts } });
}

describe('Tasks', () => {
  it('groups by due time: overdue, today, later, no date', () => {
    const now = new Date(2026, 10, 10, 9, 0).getTime();
    expect(groupOf({ dueAt: new Date(2026, 10, 10, 8, 0).toISOString() }, now)).toBe('overdue');
    expect(groupOf({ dueAt: new Date(2026, 10, 10, 23, 30).toISOString() }, now)).toBe('today');
    expect(groupOf({ dueAt: new Date(2026, 10, 11, 0, 5).toISOString() }, now)).toBe('later');
    expect(groupOf({ dueAt: null }, now)).toBe('undated');
  });

  it('Done is one tap and refetches the list', async () => {
    const fake = tasksFake([task()]).on(`PATCH /tasks/${IDS.task}`, { status: 200, body: { task: task({ status: 'done' }) } });
    agentApp(fake, '/tasks');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Done: Send the disclosures')).toBeInTheDocument();
    expect(fake.callsTo(`PATCH /tasks/${IDS.task}`)[0]!.body).toEqual({ status: 'done' });
    await waitFor(() => expect(fake.callsTo('GET /tasks?status=open&limit=200').length).toBeGreaterThanOrEqual(2));
  });

  it('a promise the assistant found shows where it was promised; one with an unpinned date says "Check this" and has no due date', async () => {
    const ev = { sourceType: 'call', sourceId: IDS.call, locator: { kind: 'transcript_offset', startMs: 61_000, endMs: 64_000 }, snippet: "I'll send you the comps", verified: true, sourceAvailable: true, label: '' };
    const promise = task({ id: '01900000-0000-7000-8000-0000000ta002', kind: 'promise', title: 'Send Jane the comps', dueAt: null, needsReview: true, createdByKind: 'assistant', source: { actionId: IDS.draft, claimText: 'Promised to send comps', evidence: [ev] } });
    agentApp(tasksFake([promise]), '/tasks');
    const row = (await screen.findByText('Send Jane the comps')).closest('section')!;
    expect(row.textContent).toContain('No date · Jane Doe');
    expect(row.textContent).not.toMatch(/Due |Was due/);
    expect(within(row).getByText('Check this')).toBeInTheDocument();
    expect(within(row).getByText('Found by the assistant: Promised to send comps')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /“I'll send you the comps” at 1:01 in the call/ })).toHaveAttribute('href', `/contacts/${IDS.jane}/thread#${IDS.call}`);
    expect(within(row).getByRole('button', { name: 'Set a date' })).toBeInTheDocument();
  });

  it('an appointment awaiting its outcome is logged in two taps from Tasks (open, then the outcome chip)', async () => {
    const appt: AppointmentView = { id: IDS.appt, kind: 'buyer_consult', startsAt: iso(-10_800_000), endsAt: iso(-7_200_000), location: null, status: 'scheduled', outcome: null, outcomeNote: null, outcomeLoggedAt: null, userId: IDS.me, contact: { id: IDS.jane, name: 'Jane Doe' }, dealId: null, awaitingOutcome: true, createdByKind: 'user' };
    const fake = tasksFake([], [appt]).on(`POST /appointments/${IDS.appt}/outcome`, { status: 200, body: { appointment: { ...appt, awaitingOutcome: false } } });
    agentApp(fake, '/tasks');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Log outcome' }));
    await u.click(await screen.findByRole('button', { name: 'Follow up' }));
    expect(await screen.findByText('Outcome saved.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /appointments/${IDS.appt}/outcome`)[0]!.body).toEqual({ result: 'follow_up' });
  });

  it('adds a task', async () => {
    const fake = tasksFake([]).on('POST /tasks', { status: 201, body: { task: task() } });
    agentApp(fake, '/tasks');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New task' }));
    await u.type(screen.getByLabelText('New task'), 'Call the lender');
    await u.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fake.callsTo('POST /tasks')).toHaveLength(1));
    expect(fake.callsTo('POST /tasks')[0]!.body).toEqual({ title: 'Call the lender' });
  });
});
