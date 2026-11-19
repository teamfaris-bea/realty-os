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

function mount(chat: WebChatFixture, person = details()) {
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
            <StagePill contactId={C} name="Cleo Chat" details={person} onCall={on.call} onText={on.text} onReplyChat={on.replyChat} />
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


describe('StagePill: stage guidance without changing stage actions', () => {
  const descriptions = [
    ['New', 'Start here for a new lead.'],
    ['Attempting', 'Use while trying to start a conversation.'],
    ['Connected', 'Use after a two-way conversation, not just a sent message or logged activity.'],
    ['Nurture', 'Use for a longer-term opportunity.'],
    ['Active', 'Use while actively working toward a purchase or sale.'],
    ['Under contract', 'Use while a purchase or sale is under contract.'],
    ['Closed', 'Use for a completed purchase or sale.'],
    ['Lost', 'Use for an opportunity no longer being pursued.'],
  ];

  it('explains all eight choices and keeps their lock reasons accessible', async () => {
    const { u, fake } = mount('none');
    await u.click(screen.getByRole('button', { name: 'Stage: New. Change stage' }));
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getByText('A stage does not verify human contact, appointment outcomes or consent.')).toBeVisible();
    for (const [label, description] of descriptions) {
      const option = sheet.getByRole('button', { name: new RegExp(`^${label}( Current| Locked)?$`) });
      expect(option).toHaveAccessibleDescription(expect.stringContaining(description!));
      if (!['New', 'Attempting'].includes(label!)) {
        expect(option).toBeDisabled();
        expect(option).toHaveAccessibleDescription(expect.stringContaining('Reach them first.'));
        await u.click(option);
      }
    }
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it.each(['cancel', 'escape', 'backdrop'])('viewing and closing with %s never writes', async (close) => {
    const { u, fake } = mount('none');
    const opener = screen.getByRole('button', { name: 'Stage: New. Change stage' });
    await u.click(opener);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    if (close === 'cancel') await u.click(screen.getByRole('button', { name: 'Cancel' }));
    else if (close === 'escape') await u.keyboard('{Escape}');
    else await u.click(screen.getByTestId('dialog-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('retains custom labels, posts only the canonical selection and preserves Undo', async () => {
    const person = details();
    person.stage.locked = [];
    person.stage.lockedReason = null;
    person.stageLabels = { active: 'Working together' };
    const { u, fake } = mount('none', person);
    fake.on(`POST /contacts/${C}/stage`, (call) => ({ status: 200, body: {
      stage: { stage: (call.body as { stage: string }).stage, label: 'Working together' },
      previousStage: 'new', automation: { started: 'Buyer plan' },
    } }));
    await u.click(screen.getByRole('button', { name: 'Stage: New. Change stage' }));
    const option = screen.getByRole('button', { name: 'Working together' });
    expect(option).toHaveAccessibleDescription('Use while actively working toward a purchase or sale.');
    await u.click(option);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`POST /contacts/${C}/stage`).map((c) => c.body)).toEqual([{ stage: 'active' }]);
    expect(screen.getByText('Stage: Working together. Started Buyer plan')).toBeVisible();
    await u.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Stage back to New. Buyer plan is still running');
    expect(fake.callsTo(`POST /contacts/${C}/stage`).map((c) => c.body)).toEqual([{ stage: 'active' }, { stage: 'new' }]);
  });

  it('keeps the picker unavailable without edit permission', async () => {
    const { u, fake } = mount('none', { ...details(), canEdit: false });
    const opener = screen.getByRole('button', { name: 'Stage: New. Change stage' });
    expect(opener).toBeDisabled();
    await u.click(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
