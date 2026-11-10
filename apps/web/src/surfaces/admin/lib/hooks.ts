// Hooks shared by the lead-admin surfaces.
//
// useAction(method): one tap = one request, for endpoints whose strict bodies carry no command id
// (PATCH /settings, POST /invites, PUT /routing-rules/:id/members, ...). A second tap while one is in
// flight returns the in-flight promise; failures come back as `{ ok: false, message }` with a human
// sentence; REAUTH_REQUIRED (R-PERM-13) opens the shell's password prompt once and re-sends the same
// request; the listed queries are refetched when it settles. Endpoints that take a command id
// (exceptions, ownership) use the shell's useCommand.
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type HttpMethod, messageFor, useApi, useRequestReauth } from '../../../shell/index.js';
import { ADMIN_MESSAGES } from './messages.js';

export type ActionResult<R> = { ok: true; data: R } | { ok: false; code: string; message: string; status: number; details: Record<string, unknown> | null };

export interface Action<B, R> {
  run(path: string, body?: B): Promise<ActionResult<R>>;
  pending: boolean;
  error: Extract<ActionResult<R>, { ok: false }> | null;
  reset(): void;
}

export function failureOf(e: unknown): { ok: false; code: string; message: string; status: number; details: Record<string, unknown> | null } {
  const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
  return { ok: false, code: err.code, status: err.status, details: err.details, message: messageFor(err, ADMIN_MESSAGES) };
}

export function useAction<B = unknown, R = unknown>(method: Exclude<HttpMethod, 'GET'>, o: { invalidate?: QueryKey[] } = {}): Action<B, R> {
  const api = useApi();
  const qc = useQueryClient();
  const requestReauth = useRequestReauth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Extract<ActionResult<R>, { ok: false }> | null>(null);
  const inFlight = useRef<Promise<ActionResult<R>> | null>(null);
  const invalidate = useRef(o.invalidate ?? []);
  invalidate.current = o.invalidate ?? [];
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (path: string, body?: B): Promise<ActionResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const p = (async (): Promise<ActionResult<R>> => {
        setPending(true);
        setError(null);
        let reauthed = false;
        try {
          for (;;) {
            try {
              const data = await api.request<R>(method, path, method === 'DELETE' ? undefined : (body ?? {}));
              return { ok: true as const, data };
            } catch (e) {
              if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && !reauthed) {
                reauthed = true;
                if (await requestReauth()) continue;
              }
              const failure = failureOf(e);
              if (mounted.current) setError(failure);
              return failure;
            }
          }
        } finally {
          inFlight.current = null;
          if (mounted.current) setPending(false);
          for (const key of invalidate.current) void qc.invalidateQueries({ queryKey: key });
        }
      })();
      inFlight.current = p;
      return p;
    },
    [api, method, qc, requestReauth],
  );
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}

/** A polite status line for "Saved." style announcements that clears itself. */
export function useAnnounce(ms = 4000): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const announce = useCallback(
    (t: string) => {
      setText(t);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setText(null), ms);
    },
    [ms],
  );
  return [text, announce];
}
