// The phone's working bar on the person's page: Call · Text · Log · Next · Note, five thumb targets fixed above the
// tab bar and the home-indicator safe area. Call and Text read the same reachability summary as the header's buttons
// and are disabled with the exact reason when blocked. The bar steps out of the way while a text field has focus
// (the on-screen keyboard is up), without leaving the page: its buttons stay in the document, so a sheet that closes
// can hand focus back to the button that opened it. jsdom; the 44 px sizes are measured in the e2e specs.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { IDS, dncReason, fullContact, reachability, stopReason } from '../feed/lib/testing.js';
import { PERSON_BAR_VAR, PhoneBar, type PhoneBarProps, usePhoneBarRef } from './PhoneBar.js';

/** As the person page does: the parent owns the bar's measuring ref. */
function Host(p: Omit<PhoneBarProps, 'barRef'>) {
  const barRef = usePhoneBarRef();
  return <PhoneBar {...p} barRef={barRef} />;
}

const C = IDS.jane;

function mount(o: { reach?: ReturnType<typeof reachability>; contact?: ReturnType<typeof fullContact> } = {}) {
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: o.reach ?? reachability(C) } });
  const on = { call: vi.fn(), text: vi.fn(), log: vi.fn(), next: vi.fn(), note: vi.fn() };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <input aria-label="A text field" />
          <input type="checkbox" aria-label="A checkbox" />
          <textarea aria-label="A text area" />
          <Host contact={o.contact ?? fullContact()} onCall={on.call} onText={on.text} onLog={on.log} onNext={on.next} onNote={on.note} />
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, on, u: userEvent.setup(), view };
}
const bar = () => screen.getByTestId('person-phone-bar');

describe('E794: the phone working bar', () => {
  it('five targets in thumb order: Call, Text, Log, Next, Note; each at least the 44 px tap size; each does its one thing', async () => {
    const { on, u } = mount();
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Call', 'Text', 'Log', 'Next', 'Note']);
    for (const b of buttons) expect(b.className).toMatch(/\bmin-h-tap\b/);
    // Call and Text are named with the person: the page's header has the same two actions
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Call Jane Doe', 'Text Jane Doe', 'Log', 'Next follow-up', 'Note']);
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    for (const b of buttons) await u.click(b);
    for (const f of Object.values(on)) expect(f).toHaveBeenCalledTimes(1);
  });

  it('sits above the tab bar and the safe area, is marked as a sticky bar, and publishes its height for the AI care bar stacked above it', () => {
    const { view } = mount();
    expect(bar().className).toContain('bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))]');
    expect(bar().className).toContain('fixed');
    expect(bar()).toHaveAttribute('data-sticky');
    expect(document.documentElement.style.getPropertyValue(PERSON_BAR_VAR)).not.toBe('');
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(PERSON_BAR_VAR)).toBe('');
  });

  it('a person who texted STOP: Text is disabled with the exact reason; Call stays enabled (a text STOP does not block calls)', async () => {
    mount({ reach: reachability(C, { sms: [stopReason()] }) });
    const text = within(bar()).getByRole('button', { name: 'Text Jane Doe' });
    await waitFor(() => expect(text).toBeDisabled());
    expect(text).toHaveAccessibleDescription(/^Text is off: Texted STOP on /);
    expect(within(bar()).getByRole('button', { name: 'Call Jane Doe' })).toBeEnabled();
    // one summary request, the one the header's buttons share
  });

  it('a person who asked not to be called: Call is disabled with who recorded it; Text stays enabled', async () => {
    mount({ reach: reachability(C, { voice: [dncReason()] }) });
    const call = within(bar()).getByRole('button', { name: 'Call Jane Doe' });
    await waitFor(() => expect(call).toBeDisabled());
    expect(call).toHaveAccessibleDescription(/^Call is off: /);
    expect(within(bar()).getByRole('button', { name: 'Text Jane Doe' })).toBeEnabled();
  });

  it('no phone on file: Call and Text are disabled and say so; Log, Next and Note still work', async () => {
    const { on, u } = mount({ contact: fullContact({ phones: [] }) });
    for (const name of ['Call Jane Doe', 'Text Jane Doe']) {
      const b = within(bar()).getByRole('button', { name });
      expect(b).toBeDisabled();
      expect(b).toHaveAccessibleDescription('No phone number on file.');
    }
    await u.click(within(bar()).getByRole('button', { name: 'Next follow-up' }));
    expect(on.next).toHaveBeenCalledTimes(1);
  });

  it('a record merged into another offers no Call or Text (the API refuses both)', () => {
    mount({ contact: fullContact({ merged: true, mergedIntoContactId: IDS.pat }) });
    for (const name of ['Call Jane Doe', 'Text Jane Doe']) expect(within(bar()).getByRole('button', { name })).toBeDisabled();
    expect(within(bar()).getByRole('button', { name: 'Call Jane Doe' })).toHaveAccessibleDescription('This record was merged into another.');
  });

  it('steps out of the way while a text field has focus and comes back after; a checkbox or a button does not hide it; its buttons never leave the document', async () => {
    mount();
    const shown = () => bar().getAttribute('data-typing') !== 'true';
    expect(shown()).toBe(true);
    act(() => screen.getByLabelText('A text field').focus());
    await waitFor(() => expect(shown()).toBe(false));
    expect(bar().className).toMatch(/pointer-events-none/);
    expect(bar().className).toMatch(/opacity-0/);
    expect(within(bar()).getAllByRole('button')).toHaveLength(5);
    act(() => screen.getByLabelText('A checkbox').focus());
    await waitFor(() => expect(shown()).toBe(true));
    act(() => screen.getByLabelText('A text area').focus());
    await waitFor(() => expect(shown()).toBe(false));
    // focus handed back to a bar button (as a closing sheet does) shows the bar again
    act(() => within(bar()).getByRole('button', { name: 'Note' }).focus());
    await waitFor(() => expect(shown()).toBe(true));
    expect(bar().className).not.toMatch(/pointer-events-none|opacity-0/);
  });
});
