// Re-authentication prompt (R-PERM-13: sensitive actions need a password proof within 15 minutes).
// A call that fails with REAUTH_REQUIRED asks for the password (and the authenticator code when MFA
// is on) in a modal dialog, then the SAME call is retried once: useCommand keeps its commandId.
import { type FormEvent, type KeyboardEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button, Notice, TextField } from '../design/index.js';
import { ApiError } from './api.js';
import { useSession, useShell } from './context.js';
import { messageFor } from './errorMessages.js';

type RequestReauth = () => Promise<boolean>;

const ReauthContext = createContext<RequestReauth>(() => Promise.resolve(false));

export function useRequestReauth(): RequestReauth {
  return useContext(ReauthContext);
}

/** Runs `fn`; on REAUTH_REQUIRED prompts once and re-runs it. Other errors propagate. */
export function useWithReauth(): <T>(fn: () => Promise<T>) => Promise<T> {
  const request = useRequestReauth();
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && (await request())) return fn();
        throw e;
      }
    },
    [request],
  );
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const waiters = useRef<((ok: boolean) => void)[]>([]);
  const request = useCallback(() => {
    setOpen(true);
    // several calls failing at once share one prompt
    return new Promise<boolean>((resolve) => waiters.current.push(resolve));
  }, []);
  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    const w = waiters.current;
    waiters.current = [];
    for (const fn of w) fn(ok);
  }, []);
  return (
    <ReauthContext.Provider value={request}>
      {children}
      {open ? <ReauthDialog onDone={finish} /> : null}
    </ReauthContext.Provider>
  );
}

function ReauthDialog({ onDone }: { onDone(ok: boolean): void }) {
  const { auth } = useShell();
  const { session, setSession } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<Element | null>(null);
  const needsCode = session?.mfa.enabled === true;

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    dialogRef.current?.querySelector('input')?.focus();
    return () => {
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onDone(false);
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await auth.reauth(password, needsCode ? code.trim() : undefined);
      setSession(res.session);
      onDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? messageFor(err) : messageFor('INTERNAL_ERROR'));
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center" onKeyDown={onKeyDown}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="reauth-title" aria-describedby="reauth-desc" className="pb-safe w-full max-w-md rounded-t-2xl bg-surface p-5 md:rounded-2xl">
        <h2 id="reauth-title" className="text-[20px] font-semibold text-ink">
          Confirm it's you
        </h2>
        <p id="reauth-desc" className="mt-1 text-[15px] text-ink-muted">
          This action needs your password again. It stays confirmed for 15 minutes.
        </p>
        <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {needsCode ? (
            <TextField
              label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex gap-3">
            <Button variant="secondary" block onClick={() => onDone(false)}>
              Cancel
            </Button>
            <Button type="submit" block pending={pending} pendingLabel="Checking">
              Confirm
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
