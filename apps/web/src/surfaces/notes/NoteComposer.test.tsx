// The note composer's save under the people action (usePersonAction): the action now collapses only identical
// requests (so two different taps are two requests), so a draft keeps one note id until it is saved. ⌘↵ pressed
// twice while the save is in flight is one request, and a retry of the same draft after a lost answer sends the
// same note id (the server replays that note instead of writing a second one). jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { ToastProvider } from '../people-edit/hooks.js';
import { NoteComposer } from './NoteComposer.js';

const C = '01900000-0000-7000-8000-0000000c0009';
const NOTES = `POST /contacts/${C}/notes`;
const saved = (body: string) => ({ status: 201, body: { note: { id: '01900000-0000-7000-8000-00000000e001', contactId: C, body, pinned: false, source: 'user', author: null, createdAt: '2026-11-11T10:00:00Z', editedAt: null, loggedActivity: null }, mentions: [] } });

function mount(fake: FakeFetch) {
  fake.on('GET /auth/session', { status: 200, body: sessionFixture() });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <NoteComposer contactId={C} contactName="Jane Doe" canShare={false} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('NoteComposer save', () => {
  it('⌘↵ pressed twice while the save is in flight sends the note once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const fake = new FakeFetch().on(NOTES, async (c) => (await gate, saved((c.body as { body: string }).body)));
    const u = mount(fake);
    await u.type(screen.getByLabelText('Note about Jane Doe'), 'Met at the open house');
    await u.keyboard('{Meta>}{Enter}{/Meta}');
    await u.keyboard('{Meta>}{Enter}{/Meta}');
    release();
    expect(await screen.findByText('Note saved')).toBeInTheDocument();
    expect(fake.callsTo(NOTES)).toHaveLength(1);
  });

  it('a retry of the same draft after a lost answer sends the same note id; a new draft gets a new one', async () => {
    const fake = new FakeFetch().on(NOTES, (c, n) => (n === 1 ? 'network-error' : saved((c.body as { body: string }).body)));
    const u = mount(fake);
    const box = screen.getByLabelText('Note about Jane Doe');
    await u.type(box, 'Call back Tuesday');
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(fake.callsTo(NOTES)).toHaveLength(1));
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Note saved')).toBeInTheDocument();
    const [first, retry] = fake.callsTo(NOTES).map((c) => c.body as { body: string; noteId: string });
    expect(retry).toEqual(first);
    await u.type(box, 'Another note');
    await u.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(fake.callsTo(NOTES)).toHaveLength(3));
    expect((fake.callsTo(NOTES)[2]!.body as { noteId: string }).noteId).not.toBe(first!.noteId);
  });
});
