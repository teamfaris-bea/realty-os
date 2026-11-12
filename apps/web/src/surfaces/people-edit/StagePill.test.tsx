// The stage picker's lock (R-PAR-14): the stages a routed lead nobody reached yet cannot take are locked up front, with
// what reaches them. Since owner decision D8 (2026-11-12) a reply in the website chat is first contact (R-OWN-14), so
// it opens the stages too: the sheet says so, and offers Reply in the chat while the chat is open (a chat lead often
// has no phone or email at all, review D8-3). jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { type WebChatFixture, reachability } from '../feed/lib/testing.js';
import type { Details } from './api.js';
import { StagePill } from './StagePill.js';
import { ToastProvider } from './hooks.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const details = (): Details => ({
  contactId: C,
  rowVersion: 1,
  doNotContact: false,
  stage: { stage: 'new', label: 'New', locked: ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'], lockedReason: 'STAGE_NEEDS_CONTACT' },
  stageLabels: {},
  addresses: [],
  collaborators: [],
  relationships: [],
  removedPoints: [],
  canEdit: true,
  canManageCollaborators: false,
});

function mount(chat: WebChatFixture) {
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C, {}, chat) } });
  const on = { call: vi.fn(), text: vi.fn(), replyChat: vi.fn() };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <StagePill contactId={C} name="Cleo Chat" details={details()} onCall={on.call} onText={on.text} onReplyChat={on.replyChat} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { u: userEvent.setup(), on, fake };
}

describe('StagePill: the lock says what reaches the lead (R-PAR-14, owner decision D8)', () => {
  it('E310: a chat lead whose chat is open is offered Reply in the chat first, and the sheet says a chat reply opens the stages', async () => {
    const { u, on } = mount('open');
    await u.click(screen.getByRole('button', { name: 'Stage: New. Change stage' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(/the locked stages open once you reach them: a call, text, email or reply in their website chat/)).toBeInTheDocument();
    const reply = await within(sheet).findByRole('button', { name: 'Reply in chat' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent?.trim()).slice(0, 3)).toEqual(['Reply in chat', 'Call', 'Text']);
    await u.click(reply);
    expect(on.replyChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['none', 'ended', 'off'] as const)('E312: no Reply in chat when the chat is %s (no chat, the visitor left, the widget turned off: a reply there is refused, and is no touch)', async (chat) => {
    const { u, fake } = mount(chat);
    await u.click(screen.getByRole('button', { name: 'Stage: New. Change stage' }));
    const sheet = screen.getByRole('dialog');
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${C}/reachability`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(sheet).queryByRole('button', { name: 'Reply in chat' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Call' })).toBeInTheDocument();
    expect(within(sheet).getByText(/a call, text, email or reply in their website chat/)).toBeInTheDocument();
  });
});
