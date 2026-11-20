// Shared pieces of the people surfaces: one-tap mutations with this surface's error sentences, the
// Undo toast (reversible one-person edits get Undo instead of a confirm modal, PARITY_PLAN §5), chips,
// and the desktop breakpoint.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { announce } from '../../design/index.js';
import { ApiError, type HttpMethod, messageFor, useApi } from '../../shell/index.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { PEOPLE_ERROR_MESSAGES, personKeys } from './api.js';

const MESSAGES = { ...AGENT_ERROR_MESSAGES, ...PEOPLE_ERROR_MESSAGES };

export type ActionResult<R> =
  | { ok: true; data: R }
  | {
      ok: false;
      code: string;
      message: string;
      details: Record<string, unknown> | null;
      /**
       * Nobody can say whether the server did it: the answer never arrived, or the server failed after it may have
       * committed (a network error, a 5xx). The screen then says "could not confirm", never "was not saved". False:
       * the server refused, and nothing was done.
       */
      uncertain: boolean;
    };

/**
 * One request per tap: a call for the same request (method, path and body) while that one is in flight reuses it, so
 * a double tap sends once. Any other request is its own: it waits for the ones before it, then goes out, and resolves
 * with its own answer. (One action is shared by several controls, e.g. every address's Remove and the toast's Undo;
 * handing a later, different call the first request's answer reported the wrong address removed and swallowed an
 * Undo.) Refreshes the person's queries after each request; `pending` while any is queued or in flight.
 */
export function usePersonAction<R = unknown>(contactId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Map<string, Promise<ActionResult<R>>>());
  const last = useRef<Promise<unknown>>(Promise.resolve());
  const open = useRef(0);
  const run = useCallback(
    (method: Exclude<HttpMethod, 'GET'>, path: string, body?: unknown): Promise<ActionResult<R>> => {
      const key = `${method} ${path} ${JSON.stringify(body ?? {})}`;
      const same = inFlight.current.get(key);
      if (same) return same;
      open.current += 1;
      setPending(true);
      setError(null);
      // runs after the requests before it (a microtask later when there are none), never rejects (a failure is a
      // result), so the next request always gets its turn
      const send = async (): Promise<ActionResult<R>> => {
        try {
          return { ok: true, data: await api.request<R>(method, path, body ?? {}) };
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
          const message = messageFor(err, MESSAGES);
          setError(message);
          return { ok: false, code: err.code, message, details: err.details, uncertain: err.code === 'NETWORK_ERROR' || err.status === 0 || err.status >= 500 };
        } finally {
          if (inFlight.current.get(key) === p) inFlight.current.delete(key);
          open.current -= 1;
          if (open.current === 0) setPending(false);
          for (const k of personKeys(contactId)) void qc.invalidateQueries({ queryKey: k });
        }
      };
      const p: Promise<ActionResult<R>> = last.current.then(send);
      inFlight.current.set(key, p);
      last.current = p;
      return p;
    },
    [api, qc, contactId],
  );
  return { run, pending, error, clearError: () => setError(null) };
}

export function peopleMessage(e: unknown): string {
  return e instanceof ApiError ? messageFor(e, MESSAGES) : messageFor(new ApiError('INTERNAL_ERROR', 0), MESSAGES);
}

// ---- Undo toast -------------------------------------------------------------------------------------

export interface ToastSpec {
  text: string;
  undo?: () => void;
  /**
   * What the Undo button says, when "Undo" alone would promise more than it does (L16): a toast that says several
   * results ("Call logged. Stage: Connected. Follow-up saved …") names the one its button takes back ("Undo stage change").
   */
  undoLabel?: string;
  /** one more thing the toast offers (R-STG-5: "Stop" for a plan an undo leaves running); `name` is its full spoken name */
  action?: { label: string; name?: string; run: () => void };
}
const ToastCtx = createContext<(t: ToastSpec) => void>(() => undefined);
/**
 * The page's ONE stack of toasts (E788): a place inside it for another toast of the page (the agent sheets' announce
 * toast), so two toasts shown at once sit one above the other, and both sit above every bottom bar. Null: no stack.
 */
const ToastSlotCtx = createContext<HTMLElement | null>(null);
export function useToastSlot(): HTMLElement | null {
  return useContext(ToastSlotCtx);
}

/**
 * Where the stack sits: above the tab bar, the home-indicator safe area and the bottom bars of the page as they
 * MEASURE (design/Sticky.tsx publishes their sum: the person's working bar, taller when it carries a reason line, and
 * the AI care bar above it), plus a gap. It used to assume a 76 px bar and sat on a taller one.
 */
export const TOAST_STACK_POS = 'bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--sticky-bottom-h,0px)+12px)] md:bottom-[calc(var(--sticky-bottom-h,0px)+24px)]';

/**
 * The room a showing toast takes above the bars it sits on: the stack's height plus its gap, published on <html>
 * while a toast is on screen and removed when the last one goes. design/tokens.css adds it to the scroll padding, so
 * a control the browser scrolls to (keyboard focus, find-in-page, an #anchor) stops above the toast, and the shell
 * (shell/Layout.tsx) adds it to the end of the page, so the last control can be scrolled clear of it (WCAG 2.2
 * 2.4.11 Focus Not Obscured). It is not part of --sticky-bottom-h: the stack's own position reads that sum.
 */
export const TOAST_STACK_VAR = '--toast-stack-h';
/** The gap kept between the top of the stack and what scrolls under it (the stack sits 12 px above the bars on a phone, 24 px on desktop). */
const TOAST_STACK_GAP = 24;

/**
 * Declares the stack to the page while it shows a toast, and only then: a fixed box that stays on screen is a bar
 * (e2e/a11y/checks.ts fails one that is not marked data-sticky, and checks every focused control against a marked
 * one), and an empty stack has no height and is no bar. Called in the commit that puts a toast in or takes it out
 * (a layout effect of whoever draws the toast: this provider's own, and the agent sheets' announce toast), so the
 * mark and the reserved room are never a frame behind what is on screen; a ResizeObserver follows a toast whose
 * text wraps differently after a resize.
 */
function syncToastStack(el: HTMLElement | null): void {
  const root = document.documentElement;
  const h = el && el.isConnected ? Math.ceil(el.getBoundingClientRect().height) : 0;
  if (el) el.toggleAttribute('data-sticky', h > 0);
  if (h > 0) root.style.setProperty(TOAST_STACK_VAR, `${h + TOAST_STACK_GAP}px`);
  else root.style.removeProperty(TOAST_STACK_VAR);
}
/** Re-measures the page's toast stack now; a toast drawn into the stack's slot calls it when it appears, changes or goes. */
const ToastStackSyncCtx = createContext<() => void>(() => undefined);
export function useToastStackSync(): () => void {
  return useContext(ToastStackSyncCtx);
}
/** True inside a ToastProvider: one nested inside another shares its toast instead of drawing a second one. */
const InToastCtx = createContext(false);

export function useToast(): (t: ToastSpec) => void {
  return useContext(ToastCtx);
}

/**
 * A toast seen in place and heard through the app's one polite live region. It is not aria-hidden when it
 * carries Undo, so the button is reachable; it stays 8 s (WCAG 2.2.1: long enough to act).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  // a page that already has the toast (the agent sheets' provider wraps the person page's sections) keeps ONE toast
  return useContext(InToastCtx) ? <>{children}</> : <OwnToast>{children}</OwnToast>;
}

function OwnToast({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stack = useRef<HTMLDivElement | null>(null);
  const sync = useCallback(() => syncToastStack(stack.current), []);
  // this provider's own toast came, changed or went: the mark and the reserved room follow in the same commit
  useLayoutEffect(sync, [sync, toast]);
  useEffect(() => {
    const el = stack.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (el) ro?.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', sync);
      syncToastStack(null); // the page is going: nothing stays reserved
    };
  }, [sync]);
  const show = useCallback((t: ToastSpec) => {
    const offers = [t.undo ? (t.undoLabel ?? 'Undo') : null, t.action ? t.action.label : null].filter(Boolean);
    announce(offers.length === 0 ? t.text : `${t.text.replace(/\.$/, '')}. ${offers.join(' and ')} ${offers.length === 1 ? 'is' : 'are'} available.`);
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 8000);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <ToastCtx.Provider value={show}>
      <InToastCtx.Provider value={true}>
        <ToastStackSyncCtx.Provider value={sync}>
          <ToastSlotCtx.Provider value={slot}>{children}</ToastSlotCtx.Provider>
        </ToastStackSyncCtx.Provider>
      </InToastCtx.Provider>
      {/* no gap of its own: empty, the stack has no height and is no bar; showing a toast it is marked data-sticky (syncToastStack) */}
      <div ref={stack} data-testid="toast-stack" className={`pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center px-4 ${TOAST_STACK_POS}`}>
        <div ref={setSlot} className="flex w-full flex-col items-center" />
      <div data-testid="people-toast" className="flex w-full justify-center">
        {toast ? (
          <div className="pointer-events-auto flex max-w-md flex-wrap items-center justify-end gap-x-3 rounded-xl bg-ink px-4 py-2 text-[15px] font-medium text-surface shadow-lg">
            <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">{toast.text}</span>
            {toast.undo ? (
              <button
                type="button"
                className="min-h-tap min-w-tap shrink-0 whitespace-nowrap rounded-lg px-2 font-semibold text-surface underline"
                onClick={() => {
                  const u = toast.undo;
                  setToast(null);
                  u?.();
                }}
              >
                {toast.undoLabel ?? 'Undo'}
              </button>
            ) : null}
            {toast.action ? (
              <button
                type="button"
                aria-label={toast.action.name}
                className="min-h-tap min-w-tap shrink-0 whitespace-nowrap rounded-lg px-2 font-semibold text-surface underline"
                onClick={() => {
                  const a = toast.action;
                  setToast(null);
                  a?.run();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>
    </ToastCtx.Provider>
  );
}

// ---- small controls ----------------------------------------------------------------------------------

export function Chip({ selected, onClick, children, disabled, describedBy }: { selected: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; describedBy?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
      className={`min-h-tap rounded-full border px-4 text-[15px] font-medium ${selected ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink'} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

const DESKTOP = '(min-width: 768px)';
export function useIsDesktop(): boolean {
  const subscribe = useCallback((fn: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
    const m = window.matchMedia(DESKTOP);
    m.addEventListener?.('change', fn);
    return () => m.removeEventListener?.('change', fn);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DESKTOP).matches : false),
    () => false,
  );
}

export const selectClass = 'min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink';
export const textareaClass = 'min-h-[96px] w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink placeholder:text-ink-muted';

export function useStable<T>(v: T): T {
  return useMemo(() => v, [v]);
}
