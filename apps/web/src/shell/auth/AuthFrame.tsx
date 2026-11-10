// The frame and small helpers shared by the sign-in screens: a single centered column (full width
// on a phone, a card on desktop), one h1, an error Notice, and an action runner that turns ApiError
// codes into sentences.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Notice } from '../../design/index.js';
import { ApiError } from '../api.js';
import { messageFor } from '../errorMessages.js';
import { safeNext } from '../authApi.js';

export function AuthFrame({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Realty OS`;
  }, [title]);
  return (
    <div className="pt-safe pb-safe flex min-h-dvh flex-col bg-canvas md:items-center md:justify-center md:py-10">
      <main id="main" className="mx-auto w-full max-w-[440px] px-5 py-8 md:rounded-3xl md:border md:border-line md:bg-surface md:px-8 md:py-9">
        <p className="mb-6 text-[15px] font-semibold tracking-tight text-accent">Realty OS</p>
        <h1 ref={h1} tabIndex={-1} className="text-[28px] font-bold leading-tight text-ink outline-none">
          {title}
        </h1>
        {intro ? <div className="mt-2 text-[16px] text-ink-muted">{intro}</div> : null}
        <div className="mt-6">{children}</div>
        {footer ? <div className="mt-6 flex flex-col gap-2 text-[15px]">{footer}</div> : null}
      </main>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? <Notice tone="error">{message}</Notice> : null;
}

/** Runs one auth call at a time; failures become a sentence in `error`. */
export function useAuthAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    setCode(null);
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
      setError(messageFor(err));
      setCode(err.code);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, code, run, setError };
}

export function useNextParam(): string {
  const [params] = useSearchParams();
  return safeNext(params.get('next'));
}

/**
 * Reads `#token=...` and removes it from the address bar and history at once. The token is kept in
 * sessionStorage under `storageKey` (this tab only) so a reload, a detour through sign-in, or React
 * StrictMode's double initializer still finds it; callers remove it once it has been used.
 */
export function useHashToken(storageKey: string): string | null {
  const [token] = useState<string | null>(() => {
    const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    const fromHash = m?.[1] ? decodeURIComponent(m[1]) : null;
    if (fromHash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      safeSession(() => window.sessionStorage.setItem(storageKey, fromHash));
      return fromHash;
    }
    return safeSession(() => window.sessionStorage.getItem(storageKey)) ?? null;
  });
  return token;
}

export function safeSession<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
