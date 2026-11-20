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
import { detailsFixture, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const details = (): Details => detailsFixture(C, 'new', { stage: stageFixture('new', { locked: ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'], lockedReason: 'STAGE_NEEDS_CONTACT' }) });

function mount(chat: WebChatFixture, d: Details = details()) {
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
            <StagePill contactId={C} name="Cleo Chat" details={d} onCall={on.call} onText={on.text} onReplyChat={on.replyChat} />
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
    await u.click(screen.getByRole('button', { name: 'Stage: New lead. Change stage' }));
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
    await u.click(screen.getByRole('button', { name: 'Stage: New lead. Change stage' }));
    const sheet = screen.getByRole('dialog');
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${C}/reachability`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(sheet).queryByRole('button', { name: 'Reply in chat' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Call' })).toBeInTheDocument();
    expect(within(sheet).getByText(/a call, text, email or reply in their website chat/)).toBeInTheDocument();
  });
});

describe('E796: StagePill: the picker teaches what each stage means (R-STG-1)', () => {
  it('each of the eight stages shows its label, its one-line definition and its "does not mean" line', async () => {
    const { u } = mount('none', detailsFixture(C, 'attempting'));
    await u.click(screen.getByRole('button', { name: 'Stage: Trying to reach. Change stage' }));
    const rows = within(within(screen.getByRole('dialog')).getByRole('list', { name: 'Stages' })).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    guideFixture().forEach((s, i) => {
      const row = within(rows[i]!);
      expect(row.getByText(s.label)).toBeInTheDocument();
      expect(row.getByText(s.definition)).toBeInTheDocument();
      expect(row.getByText(s.notThis)).toBeInTheDocument();
    });
    // the button is named by its label (and its state), and described by what the stage means
    const current = within(rows[1]!).getByRole('button');
    expect(current).toHaveAccessibleName('Trying to reach Current');
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveAccessibleDescription(/We tried to reach them but have not had a two-way conversation yet\. A voicemail or an unanswered text is not a conversation\./);
    expect(within(rows[2]!).getByRole('button')).toHaveAccessibleName('Connected');
  });

  it('a 24-character label is shown whole: it wraps, and nothing in the pill or the picker truncates it', async () => {
    const long = 'Signed buyer agreement!!';
    expect(long).toHaveLength(24);
    const { u } = mount('none', detailsFixture(C, 'active', {}, { active: long }));
    const pill = screen.getByRole('button', { name: `Stage: ${long}. Change stage` });
    expect(pill).toHaveTextContent(long);
    expect(pill.className).toContain('[overflow-wrap:anywhere]');
    await u.click(pill);
    const sheet = screen.getByRole('dialog');
    const label = within(sheet).getByText(long);
    expect(label.className).toContain('[overflow-wrap:anywhere]');
    for (const el of [pill, ...sheet.querySelectorAll<HTMLElement>('[aria-label="Stages"] *')]) expect(el.className).not.toMatch(/truncate|whitespace-nowrap|line-clamp|text-ellipsis|overflow-hidden/);
  });

  it('a locked stage keeps the "Reach them first" explanation: disabled, marked Locked and described by it', async () => {
    const { u } = mount('none');
    await u.click(screen.getByRole('button', { name: 'Stage: New lead. Change stage' }));
    const sheet = screen.getByRole('dialog');
    const lost = within(sheet).getByRole('button', { name: 'Not moving forward Locked' });
    expect(lost).toBeDisabled();
    expect(lost).toHaveAccessibleDescription(/Reach them first\./);
    // what the stage means is still readable on a locked row
    expect(within(sheet).getByText('Does not mean do not contact. Record that separately if they asked.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Trying to reach' })).toBeEnabled();
  });
});
