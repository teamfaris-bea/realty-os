// Dialog: the one modal primitive (WCAG 2.1.2 no keyboard trap except by design, 2.4.3 focus order,
// 2.4.11 focus not obscured, ARIA APG dialog pattern).
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button, Dialog } from './index.js';

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div data-testid="page">
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <a href="#x">Behind</a>
      {open ? (
        <Dialog title="Confirm it's you" description="This needs your password." onClose={() => setOpen(false)}>
          <label>
            Password <input type="password" />
          </label>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button>Confirm</Button>
        </Dialog>
      ) : null}
    </div>
  );
}

describe('Dialog', () => {
  it('is a labelled, described modal dialog and moves focus to its first control', async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open it' }));
    const d = screen.getByRole('dialog', { name: "Confirm it's you" });
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleDescription('This needs your password.');
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('closes on Escape wherever focus is, and gives focus back to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('makes the page behind inert while open, and pulls stray focus back in', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    expect(container).toHaveAttribute('inert');
    act(() => screen.getByRole('link', { name: 'Behind', hidden: true }).focus());
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(container).not.toHaveAttribute('inert');
  });

  it('closes when the backdrop is tapped', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByTestId('dialog-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// b19: on a phone the on-screen keyboard covers the bottom of the layout viewport, where a bottom sheet's footer is.
// The dialog's frame follows window.visualViewport (the part of the page actually visible), so the footer and its
// primary button stay above the keyboard. jsdom has no visualViewport: the tests stand one in.
describe('E793: Dialog and the on-screen keyboard (window.visualViewport)', () => {
  type Listener = () => void;
  function fakeViewport(init: { height: number; offsetTop: number; scale?: number }) {
    const listeners = new Map<string, Set<Listener>>();
    const vv = {
      height: init.height,
      offsetTop: init.offsetTop,
      scale: init.scale ?? 1,
      addEventListener: (type: string, fn: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    return {
      vv,
      set(next: Partial<{ height: number; offsetTop: number; scale: number }>, type: 'resize' | 'scroll' = 'resize') {
        Object.assign(vv, next);
        act(() => listeners.get(type)?.forEach((fn) => fn()));
      },
      count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
      remove: () => Reflect.deleteProperty(window, 'visualViewport'),
    };
  }
  const sheet = (footer = true) => (
    <Dialog title="Stage for Dana" onClose={() => undefined} footer={footer ? <Button>Change to Connected</Button> : undefined}>
      <label>
        Note <textarea />
      </label>
    </Dialog>
  );
  const frame = () => screen.getByTestId('dialog-frame');

  it('the frame is exactly the visible viewport, so the footer sits above the keyboard; it follows the keyboard opening and closing', () => {
    const v = fakeViewport({ height: 664, offsetTop: 0 });
    try {
      render(sheet());
      expect(frame().style.height).toBe('664px');
      expect(frame().style.top).toBe('0px');
      // the keyboard opens: 336 px less to see, and iOS has scrolled the page 20 px under the sheet
      v.set({ height: 328, offsetTop: 20 });
      expect(frame().style.height).toBe('328px');
      expect(frame().style.top).toBe('20px');
      // the footer is inside the frame, after the scrolling body: it is the last thing above the keyboard
      const panel = screen.getByRole('dialog');
      expect(frame()).toContainElement(panel);
      expect(panel.lastElementChild).toContainElement(screen.getByRole('button', { name: 'Change to Connected' }));
      expect(panel.className).toContain('max-h-[90%]');
      // a scroll of the visual viewport alone (the keyboard's accessory bar) moves the frame too
      v.set({ offsetTop: 0 }, 'scroll');
      expect(frame().style.top).toBe('0px');
      v.set({ height: 664 });
      expect(frame().style.height).toBe('664px');
    } finally {
      v.remove();
    }
  });

  it('keeps the home-indicator safe-area padding on the sheet, and the backdrop still covers the whole page', () => {
    const v = fakeViewport({ height: 328, offsetTop: 20 });
    try {
      render(sheet());
      expect(screen.getByRole('dialog').className).toContain('pb-safe');
      const backdrop = screen.getByTestId('dialog-backdrop');
      expect(backdrop.className).toContain('inset-0');
      expect(backdrop.style.height).toBe('');
      expect(frame()).not.toContainElement(backdrop);
    } finally {
      v.remove();
    }
  });

  it('a pinch-zoomed page is left alone: the sheet is not squeezed into the zoomed-in view', () => {
    const v = fakeViewport({ height: 300, offsetTop: 100, scale: 2 });
    try {
      render(sheet());
      expect(frame().style.height).toBe('');
      expect(frame().style.top).toBe('');
      v.set({ scale: 1, height: 500, offsetTop: 0 });
      expect(frame().style.height).toBe('500px');
    } finally {
      v.remove();
    }
  });

  it('without visualViewport (an old browser, jsdom) the frame is the whole viewport by CSS; listeners are removed when the dialog closes', () => {
    const plain = render(sheet(false));
    expect(frame().style.height).toBe('');
    expect(frame().className).toContain('h-full');
    plain.unmount();
    const v = fakeViewport({ height: 600, offsetTop: 0 });
    try {
      const view = render(sheet());
      expect(v.count()).toBeGreaterThan(0);
      view.unmount();
      expect(v.count()).toBe(0);
    } finally {
      v.remove();
    }
  });
});
