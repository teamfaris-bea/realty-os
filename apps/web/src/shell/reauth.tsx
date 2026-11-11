// Re-authentication prompt (R-PERM-13: sensitive actions need a password proof within 15 minutes).
// A call that fails with REAUTH_REQUIRED asks for the password (and the authenticator code when MFA
// is on) in a modal dialog, then the SAME call is retried once: useCommand keeps its commandId.
import { type FormEvent, type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../design/index.js';
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
  const needsCode = session?.mfa.enabled === true;

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

  // Dialog: Escape anywhere and the backdrop cancel; focus is trapped and restored; the page is inert
  return (
    <Dialog title="Confirm it's you" description="This action needs your password again. It stays confirmed for 15 minutes." onClose={() => onDone(false)}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
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
    </Dialog>
  );
}
