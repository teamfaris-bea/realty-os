// Hooks shared by the agent surfaces.
//
// useNow(ms): one ticking clock per interval for live countdowns. It ticks only while something on
// screen asked for it, and every subscriber reads the same instant, so two countdowns never disagree.
//
// useMutate(): one tap = one request for endpoints whose body is strict and carries no command id
// (PATCH /tasks/:id, POST /calls/:id/outcome, POST /appointments/:id/outcome, ...). It is the same
// contract as the shell's useCommand without the id: a second tap while one is in flight returns the
// in-flight promise, failures come back as `{ ok: false, message }` with a human sentence, and the
// listed queries are refetched when it settles. Endpoints that take a command id use useCommand.
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, type HttpMethod, messageFor, useApi } from '../../../shell/index.js';
import { useSurfaceMessages } from './messages.js';

type Listener = () => void;
const clocks = new Map<number, { now: number; listeners: Set<Listener>; timer: ReturnType<typeof setInterval> | null }>();

function clockFor(ms: number) {
  let c = clocks.get(ms);
  if (!c) {
    c = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(ms, c);
  }
  return c;
}

/** The current time, re-rendering every `intervalMs` while mounted. */
export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (fn: Listener) => {
      const c = clockFor(intervalMs);
      c.listeners.add(fn);
      if (c.timer === null) {
        c.now = Date.now();
        c.timer = setInterval(() => {
          c.now = Date.now();
          for (const l of c.listeners) l();
        }, intervalMs);
      }
      return () => {
        c.listeners.delete(fn);
        if (c.listeners.size === 0 && c.timer !== null) {
          clearInterval(c.timer);
          c.timer = null;
        }
      };
    },
    [intervalMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => clockFor(intervalMs).now,
    () => clockFor(intervalMs).now,
  );
}

export type MutateResult<R> = { ok: true; data: R } | { ok: false; code: string; message: string; status: number; details: Record<string, unknown> | null };

export interface Mutation<B, R> {
  run(path: string, body?: B): Promise<MutateResult<R>>;
  pending: boolean;
  error: Extract<MutateResult<R>, { ok: false }> | null;
  reset(): void;
}

export function useMutate<B = unknown, R = unknown>(method: Exclude<HttpMethod, 'GET'>, o: { invalidate?: QueryKey[] } = {}): Mutation<B, R> {
  const api = useApi();
  const qc = useQueryClient();
  const messages = useSurfaceMessages();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Extract<MutateResult<R>, { ok: false }> | null>(null);
  const inFlight = useRef<Promise<MutateResult<R>> | null>(null);
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
    (path: string, body?: B): Promise<MutateResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const p = (async (): Promise<MutateResult<R>> => {
        setPending(true);
        setError(null);
        try {
          const data = await api.request<R>(method, path, body ?? {});
          return { ok: true, data };
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
          const failure = { ok: false as const, code: err.code, status: err.status, details: err.details, message: messageFor(err, messages) };
          if (mounted.current) setError(failure);
          return failure;
        } finally {
          inFlight.current = null;
          if (mounted.current) setPending(false);
          for (const key of invalidate.current) void qc.invalidateQueries({ queryKey: key });
        }
      })();
      inFlight.current = p;
      return p;
    },
    [api, method, qc, messages],
  );
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}
