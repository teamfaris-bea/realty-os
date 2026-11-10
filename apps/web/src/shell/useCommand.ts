// useCommand: one tap = one command (BUILD_PLAN module 17).
//
//   const accept = useCommand<{ expectedSeq: number }>(`/leads/${id}/accept`, { invalidate: [['feed']] });
//   <Button pending={accept.pending} onClick={() => accept.run({ expectedSeq })}>Accept</Button>
//
// - A commandId is generated once per tap (per `run`) and sent in the body (`commandId`, or the
//   key the endpoint names, e.g. `idempotencyKey` for messages). Automatic retries after a network
//   failure or a 502/503/504, and a later `retry()` of a failed run, reuse the SAME id, so the
//   server can treat a repeat as the same command (ownership replay is a no-op, R-OWN; message
//   idempotency keys).
// - A second `run` while one is in flight returns the in-flight promise: a double tap never sends
//   two commands.
// - REAUTH_REQUIRED opens the re-auth prompt; after it succeeds the same command is sent again.
// - `optimistic` applies a cache change before the call and is rolled back if the call fails.
//   Cached queries listed in `invalidate` are refetched when the call settles, so a 409 conflict
//   shows the fresh state.
// - The result never throws for an expected failure: `{ ok: false, code, message }`, where
//   `message` is a human sentence (errorMessages) and `code` is for logic, never for display.
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError, type HttpMethod, isRetryable } from './api.js';
import { useShell } from './context.js';
import { messageFor } from './errorMessages.js';
import { useRequestReauth } from './reauth.js';

export type CommandResult<R> =
  | { ok: true; data: R; commandId: string }
  | { ok: false; code: string; message: string; status: number; details: Record<string, unknown> | null; commandId: string };

export interface CommandOptions<C, R> {
  method?: Exclude<HttpMethod, 'GET'>;
  /** body field that carries the command id (default 'commandId') */
  idKey?: string;
  /** automatic retries with the same id after NETWORK_ERROR / 502 / 503 / 504 (default 2) */
  retries?: number;
  /** delay before automatic retry n (1-based); default 400 ms × n */
  retryDelayMs?: (attempt: number) => number;
  invalidate?: QueryKey[];
  /** apply an optimistic cache update; return its rollback */
  optimistic?: (body: C, ctx: { commandId: string; queryClient: QueryClient }) => (() => void) | void;
  onSuccess?: (data: R, body: C) => void;
  /** id generator (tests); default crypto.randomUUID */
  newId?: () => string;
}

export interface Command<C, R> {
  run(body: C): Promise<CommandResult<R>>;
  /** re-sends the last failed command with its original commandId; null if there is none */
  retry(): Promise<CommandResult<R>> | null;
  pending: boolean;
  /** the last failure (cleared by the next run) */
  error: Extract<CommandResult<R>, { ok: false }> | null;
}

export function newCommandId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useCommand<C extends object, R = unknown>(path: string, o: CommandOptions<C, R> = {}): Command<C, R> {
  const { api, table } = useShell();
  const qc = useQueryClient();
  const requestReauth = useRequestReauth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Extract<CommandResult<R>, { ok: false }> | null>(null);
  const inFlight = useRef<Promise<CommandResult<R>> | null>(null);
  const lastFailed = useRef<{ body: C; commandId: string } | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const execute = useCallback(
    (body: C, commandId: string): Promise<CommandResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const { method = 'POST', idKey = 'commandId', retries = 2, retryDelayMs = (n) => 400 * n, invalidate = [], optimistic, onSuccess } = opts.current;
      const payload = { ...body, [idKey]: commandId };
      const p = (async (): Promise<CommandResult<R>> => {
        setPending(true);
        setError(null);
        const rollback = optimistic?.(body, { commandId, queryClient: qc }) ?? undefined;
        let reauthed = false;
        let attempt = 0;
        try {
          for (;;) {
            try {
              const data = await api.request<R>(method, path, payload);
              lastFailed.current = null;
              onSuccess?.(data, body);
              return { ok: true, data, commandId };
            } catch (e) {
              if (isRetryable(e) && attempt < retries) {
                attempt += 1;
                await sleep(retryDelayMs(attempt));
                continue;
              }
              if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && !reauthed) {
                reauthed = true;
                if (await requestReauth()) continue;
              }
              rollback?.();
              lastFailed.current = { body, commandId };
              const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
              const failure = { ok: false as const, code: err.code, status: err.status, details: err.details, message: messageFor(err, table.errorMessages), commandId };
              setError(failure);
              return failure;
            }
          }
        } finally {
          inFlight.current = null;
          setPending(false);
          for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
        }
      })();
      inFlight.current = p;
      return p;
    },
    [api, path, qc, requestReauth, table.errorMessages],
  );

  const run = useCallback((body: C) => inFlight.current ?? execute(body, (opts.current.newId ?? newCommandId)()), [execute]);
  const retry = useCallback(() => {
    const f = lastFailed.current;
    return f ? execute(f.body, f.commandId) : null;
  }, [execute]);

  return { run, retry, pending, error };
}
