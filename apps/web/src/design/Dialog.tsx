// The modal primitive (ARIA APG dialog pattern). A bottom sheet on a phone (thumb reach, iOS-like,
// inside the home-indicator safe area), a centered dialog on desktop.
// - role="dialog" + aria-modal, labelled by its title and described by `description`;
// - focus moves to the first control on open (or `initialFocus`) and back to the opener on close;
// - Escape closes it wherever focus is (a document listener, not only inside the panel);
// - Tab and Shift+Tab cycle inside it, and focus that strays outside is pulled back;
// - the rest of the page is `inert` while it is open, so screen readers and taps cannot reach it;
// - tapping the backdrop closes it, unless `dismissible` is false.
// It renders into a portal on <body>, so the inert page and the dialog are siblings.
//
// The on-screen keyboard (b19). A phone's keyboard covers the bottom of the layout viewport, which is where a bottom
// sheet's footer and its primary button are. The dialog's frame therefore follows window.visualViewport (the part of
// the page actually visible): its top and height are the visual viewport's, so the sheet ends where the keyboard
// begins and the footer stays in reach while a field has focus. The backdrop still covers the whole page, the sheet
// keeps its home-indicator safe-area padding, and its body scrolls inside what is left. A pinch-zoomed page is left
// alone (the frame is the whole viewport again), and so is a browser without visualViewport.
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
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
  /**
   * A visible "Close" in the header's corner (b19 fix pass M4), for a sheet whose footer holds only its primary
   * button: the way out stays on screen (a phone has no Escape key) without a second row under the primary button.
   * Focus then opens on the dialog itself (its title is read), not on Close. Such a sheet may be a little taller on a
   * phone (94% of the visible viewport, not 90%) and its header is tighter, so its body shows more at open.
   */
  closeButton?: boolean;
  /** desktop only: 'side' is a full-height panel on the right (a filter builder beside the results); a phone always gets the bottom sheet */
  placement?: 'center' | 'side';
}

/** The visible part of the page while it differs from the layout viewport (the keyboard is up); null otherwise or when zoomed. */
function useVisibleViewport(): { top: number; height: number } | null {
  const read = (): { top: number; height: number } | null => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport;
    // zoomed in: the visual viewport is a magnifier, not a keyboard; a sheet squeezed into it would be unusable
    if (!vv || Math.abs(vv.scale - 1) > 0.01) return null;
    return { top: Math.round(vv.offsetTop), height: Math.round(vv.height) };
  };
  const [box, setBox] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () =>
      setBox((prev) => {
        const next = read();
        return prev?.top === next?.top && prev?.height === next?.height ? prev : next;
      });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

export function Dialog({ title, description, onClose, children, footer, dismissible = true, initialFocus, placement = 'center', closeButton = false }: DialogProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement | null>(null);
  if (host.current === null && typeof document !== 'undefined') host.current = document.createElement('div');
  const close = useRef(onClose);
  close.current = onClose;
  const visible = useVisibleViewport();

  useEffect(() => {
    const el = host.current!;
    document.body.appendChild(el);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // everything else on the page becomes inert (only what this dialog set is undone on close)
    const madeInert = [...document.body.children].filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.hasAttribute('inert'));
    for (const c of madeInert) c.setAttribute('inert', '');
    const items = () => (panel.current ? [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);
    // a control inside that asked for focus itself (a compose box's autoFocus ran first) keeps it under closeButton
    const claimed = closeButton && panel.current !== null && panel.current.contains(document.activeElement) && document.activeElement !== panel.current;
    if (!claimed) (initialFocus?.current ?? (closeButton ? panel.current : items()[0]) ?? panel.current)?.focus();

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
    <div className="fixed inset-0 z-50">
      <div data-testid="dialog-backdrop" className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={() => (dismissible ? close.current() : undefined)} />
      {/* the frame: the visible viewport (above the on-screen keyboard), or the whole viewport by CSS */}
      <div
        data-testid="dialog-frame"
        className={`pointer-events-none absolute inset-x-0 top-0 flex h-full items-end justify-center ${placement === 'side' ? 'md:items-stretch md:justify-end' : 'md:items-center md:p-6'}`}
        style={visible ? { top: `${visible.top}px`, height: `${visible.height}px` } : undefined}
      >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={description ? `${id}-d` : undefined}
        tabIndex={-1}
        className={`pb-safe pointer-events-auto relative flex ${closeButton ? 'max-h-[94%]' : 'max-h-[90%]'} w-full flex-col rounded-t-2xl bg-surface shadow-xl outline-none ${placement === 'side' ? 'md:h-full md:max-h-none md:max-w-md md:rounded-none md:border-l md:border-line' : 'md:max-w-lg md:rounded-2xl'}`}
      >
        <div className={`px-5 ${closeButton ? 'pt-2' : 'pt-5'}`}>
          {closeButton ? (
            <div className="flex items-start justify-between gap-3">
              <h2 id={`${id}-t`} className="min-w-0 pt-2 text-[20px] font-semibold text-ink [overflow-wrap:anywhere]">
                {title}
              </h2>
              <button type="button" onClick={() => close.current()} className="-mr-2 -mt-1 inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-xl px-2 text-[16px] font-semibold text-accent active:bg-accent-soft">
                Close
              </button>
            </div>
          ) : (
            <h2 id={`${id}-t`} className="text-[20px] font-semibold text-ink">
              {title}
            </h2>
          )}
          {description ? (
            <p id={`${id}-d`} className="mt-1 text-[15px] text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        <div data-testid="dialog-body" className={`min-h-0 flex-1 overflow-y-auto px-5 ${closeButton ? 'pb-4 pt-1' : 'pb-5 pt-4'}`}>
          {children}
        </div>
        {/* pinned: the body scrolls above it, so what it holds is on screen whenever the sheet is (R-TODAY-11) */}
        {footer ? <div data-testid="dialog-footer" className="border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
      </div>
    </div>,
    host.current,
  );
}
