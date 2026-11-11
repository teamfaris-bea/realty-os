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
