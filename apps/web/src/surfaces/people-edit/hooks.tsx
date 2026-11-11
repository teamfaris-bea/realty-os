// Shared pieces of the people surfaces: one-tap mutations with this surface's error sentences, the
// Undo toast (reversible one-person edits get Undo instead of a confirm modal, PARITY_PLAN §5), chips,
// and the desktop breakpoint.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { announce } from '../../design/index.js';
import { ApiError, type HttpMethod, messageFor, useApi } from '../../shell/index.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { PEOPLE_ERROR_MESSAGES, personKeys } from './api.js';

const MESSAGES = { ...AGENT_ERROR_MESSAGES, ...PEOPLE_ERROR_MESSAGES };

export type ActionResult<R> = { ok: true; data: R } | { ok: false; code: string; message: string; details: Record<string, unknown> | null };

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
          return { ok: false, code: err.code, message, details: err.details };
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

interface ToastSpec {
  text: string;
  undo?: () => void;
}
const ToastCtx = createContext<(t: ToastSpec) => void>(() => undefined);

export function useToast(): (t: ToastSpec) => void {
  return useContext(ToastCtx);
}

/**
 * A toast seen in place and heard through the app's one polite live region. It is not aria-hidden when it
 * carries Undo, so the button is reachable; it stays 8 s (WCAG 2.2.1: long enough to act).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: ToastSpec) => {
    announce(t.undo ? `${t.text}. Undo is available.` : t.text);
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 8000);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div data-testid="people-toast" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+76px)] z-50 flex justify-center px-4 md:bottom-6">
        {toast ? (
          <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-ink px-4 py-2 text-[15px] font-medium text-surface shadow-lg">
            <span>{toast.text}</span>
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
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
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
