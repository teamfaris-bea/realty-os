// One request at a time for the module 41 admin pages (Integrations, Website chat). REAUTH_REQUIRED
// (integration.manage is 🔒) opens the shell's password prompt and re-sends the same request once; a failure
// comes back as a sentence, never a raw code. Responses are returned to the caller only: nothing is put in
// the query or mutation cache here, so a one-time secret (a widget key) lives only where the page keeps it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type HttpMethod, messageFor, useApi, useWithReauth } from '../../../shell/index.js';

export type Outcome<R> = { ok: true; data: R } | { ok: false; code: string; message: string };

export function useRequest(messages: Readonly<Record<string, string>>) {
  const api = useApi();
  const withReauth = useWithReauth();
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <R,>(what: string, method: Exclude<HttpMethod, 'GET'>, path: string, body: unknown = {}): Promise<Outcome<R>> => {
      if (busy.current) return { ok: false, code: 'BUSY', message: 'Wait for the last change to finish, then try again.' };
      busy.current = true;
      setPending(what);
      try {
        return { ok: true, data: await withReauth(() => api.request<R>(method, path, body)) };
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
        return { ok: false, code: err.code, message: messageFor(err, messages) };
      } finally {
        busy.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [api, withReauth, messages],
  );
  return { run, pending };
}

/**
 * After a dialog closes on a button that is then disabled or removed, focus would fall to <body>; put it on the
 * page heading instead (the shell's h1 takes focus), so keyboard and screen-reader users keep their place.
 */
export function keepFocus(): void {
  setTimeout(() => {
    const a = document.activeElement;
    if (!a || a === document.body) document.querySelector<HTMLElement>('h1[tabindex="-1"]')?.focus();
  }, 0);
}
