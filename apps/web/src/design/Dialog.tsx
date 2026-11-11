// The modal primitive (ARIA APG dialog pattern). A bottom sheet on a phone (thumb reach, iOS-like,
// inside the home-indicator safe area), a centered dialog on desktop.
// - role="dialog" + aria-modal, labelled by its title and described by `description`;
// - focus moves to the first control on open (or `initialFocus`) and back to the opener on close;
// - Escape closes it wherever focus is (a document listener, not only inside the panel);
// - Tab and Shift+Tab cycle inside it, and focus that strays outside is pulled back;
// - the rest of the page is `inert` while it is open, so screen readers and taps cannot reach it;
// - tapping the backdrop closes it, unless `dismissible` is false.
// It renders into a portal on <body>, so the inert page and the dialog are siblings.
import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** false: the backdrop does not close it (Escape and the controls still do) */
  dismissible?: boolean;
  /** what gets focus on open (default: the first control) */
  initialFocus?: RefObject<HTMLElement | null>;
  /** desktop only: 'side' is a full-height panel on the right (a filter builder beside the results); a phone always gets the bottom sheet */
  placement?: 'center' | 'side';
}

export function Dialog({ title, description, onClose, children, footer, dismissible = true, initialFocus, placement = 'center' }: DialogProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement | null>(null);
  if (host.current === null && typeof document !== 'undefined') host.current = document.createElement('div');
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = host.current!;
    document.body.appendChild(el);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // everything else on the page becomes inert (only what this dialog set is undone on close)
    const madeInert = [...document.body.children].filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.hasAttribute('inert'));
    for (const c of madeInert) c.setAttribute('inert', '');
    const items = () => (panel.current ? [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);
    (initialFocus?.current ?? items()[0] ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        panel.current?.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const inside = panel.current?.contains(document.activeElement) ?? false;
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (panel.current && e.target instanceof Node && !el.contains(e.target)) (items()[0] ?? panel.current).focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      for (const c of madeInert) c.removeAttribute('inert');
      el.remove();
      if (opener && document.contains(opener)) opener.focus();
    };
    // opened once per mount; initialFocus is read at open time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!host.current) return null;
  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-end justify-center ${placement === 'side' ? 'md:items-stretch md:justify-end' : 'md:items-center md:p-6'}`}>
      <div data-testid="dialog-backdrop" className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={() => (dismissible ? close.current() : undefined)} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={description ? `${id}-d` : undefined}
        tabIndex={-1}
        className={`pb-safe relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-surface shadow-xl outline-none ${placement === 'side' ? 'md:h-full md:max-h-none md:max-w-md md:rounded-none md:border-l md:border-line' : 'md:max-w-lg md:rounded-2xl'}`}
      >
        <div className="px-5 pt-5">
          <h2 id={`${id}-t`} className="text-[20px] font-semibold text-ink">
            {title}
          </h2>
          {description ? (
            <p id={`${id}-d`} className="mt-1 text-[15px] text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
        {footer ? <div className="border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
    </div>,
    host.current,
  );
}
