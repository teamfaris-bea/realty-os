// The page's one stack of toasts is a fixed element of the page: while it shows a toast it is declared (data-sticky,
// which the phone layout check reads: e2e/a11y/checks.ts) and its room is published (--toast-stack-h, which
// design/tokens.css adds to the scroll padding and shell/Layout.tsx to the end of the page); empty, it is neither.
// Both toasts drawn in it count: the stage toast (useToast) and the agent sheets' announce toast, on every page that
// mounts either provider. The browser half is e2e/journeys/toast-clear.spec.ts and e2e/marketing/marketing.spec.ts.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { TOAST_STACK_VAR, ToastProvider, useToast } from './hooks.js';

const reserved = () => document.documentElement.style.getPropertyValue(TOAST_STACK_VAR);
const stack = () => screen.getByTestId('toast-stack');

/** jsdom lays nothing out: the stack is as tall as the toasts in it (60 px each), and has no height when empty. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const toasts = this.getAttribute('data-testid') === 'toast-stack' ? [...this.querySelectorAll('[data-testid="toast"], [data-testid="people-toast"]')].filter((t) => (t.textContent ?? '') !== '').length : 0;
    const h = toasts * 60;
    return { height: h, width: 390, top: 0, left: 0, right: 390, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function StageToastButton() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast({ text: 'Stage: Connected', undo: () => undefined })}>
      change stage
    </button>
  );
}
function AnnounceButton() {
  const sheets = useAgentSheets();
  return (
    <button type="button" onClick={() => sheets.announce('Approved: listing page for 313 Harbor View.')}>
      approve
    </button>
  );
}

describe('the toast stack is a declared fixed element while it shows a toast (b19 F3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    layOut();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('empty, the stack is not marked and reserves nothing', () => {
    render(
      <AgentSheetsProvider>
        <AnnounceButton />
        <StageToastButton />
      </AgentSheetsProvider>,
    );
    expect(stack()).not.toHaveAttribute('data-sticky');
    expect(reserved()).toBe('');
  });

  it('the announce toast (any page with the agent sheets: Today, the approvals inbox, People, tasks, the pond, a conversation, the admin label pages) marks the stack and reserves its height plus the gap, in the same commit; both go with the toast', () => {
    render(
      <AgentSheetsProvider>
        <AnnounceButton />
      </AgentSheetsProvider>,
    );
    act(() => screen.getByRole('button', { name: 'approve' }).click());
    // no timer, no observer and no second render has run: the mark is on the page with the toast
    expect(screen.getByTestId('toast')).toHaveTextContent('Approved: listing page for 313 Harbor View.');
    expect(stack()).toContainElement(screen.getByTestId('toast'));
    expect(stack()).toHaveAttribute('data-sticky');
    expect(reserved()).toBe('84px');
    // the announce toast itself stays hidden from assistive technology (it is heard through the live region)
    expect(screen.getByTestId('toast')).toHaveAttribute('aria-hidden', 'true');
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByTestId('toast')).toBeEmptyDOMElement();
    expect(stack()).not.toHaveAttribute('data-sticky');
    expect(reserved()).toBe('');
  });

  it('the stage toast (the person\'s page) marks the same stack; with both toasts at once the reserved room is the height of both; it follows each toast as it goes', () => {
    render(
      <AgentSheetsProvider>
        <AnnounceButton />
        <StageToastButton />
      </AgentSheetsProvider>,
    );
    act(() => screen.getByRole('button', { name: 'change stage' }).click());
    expect(stack()).toHaveAttribute('data-sticky');
    expect(reserved()).toBe('84px');
    act(() => void vi.advanceTimersByTime(4000));
    act(() => screen.getByRole('button', { name: 'approve' }).click());
    expect(screen.getAllByTestId('toast-stack')).toHaveLength(1);
    expect(reserved()).toBe('144px');
    // 8 s after the stage toast showed it goes; the announce toast (5 s) is still there
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.getByTestId('people-toast')).toBeEmptyDOMElement();
    expect(stack()).toHaveAttribute('data-sticky');
    expect(reserved()).toBe('84px');
    act(() => void vi.advanceTimersByTime(1000));
    expect(stack()).not.toHaveAttribute('data-sticky');
    expect(reserved()).toBe('');
  });

  it('a page with only the people toast provider is marked the same way, and leaving the page while a toast shows leaves nothing reserved', () => {
    const { unmount } = render(
      <ToastProvider>
        <StageToastButton />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'change stage' }).click());
    expect(stack()).toHaveAttribute('data-sticky');
    expect(reserved()).toBe('84px');
    unmount();
    expect(reserved()).toBe('');
  });

  it('the stack sits above the measured bottom bars at every width (on desktop above a sticky bar too, not on it)', () => {
    render(
      <ToastProvider>
        <StageToastButton />
      </ToastProvider>,
    );
    expect(stack().className).toContain('bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--sticky-bottom-h,0px)+12px)]');
    expect(stack().className).toContain('md:bottom-[calc(var(--sticky-bottom-h,0px)+24px)]');
  });
});
