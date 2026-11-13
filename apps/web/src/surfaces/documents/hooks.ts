// Hooks of the documents surface. useUpload is useAction's rule for a multipart body: one tap (one file chosen) = one
// request through api.upload, never retried automatically (an upload is not idempotent and takes no commandId); a
// second call while one is in flight returns the in-flight promise; REAUTH_REQUIRED opens the shell's prompt once.
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, messageFor, useApi, useRequestReauth, useSession } from '../../shell/index.js';
import { UPLOAD_MESSAGES } from './words.js';

export type UploadResult<R> = { ok: true; data: R } | { ok: false; code: string; message: string };

export function useUpload<R>(o: { invalidate?: QueryKey[] } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  const requestReauth = useRequestReauth();
  const [pending, setPending] = useState(false);
  const inFlight = useRef<Promise<UploadResult<R>> | null>(null);
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
    (path: string, form: FormData): Promise<UploadResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const p = (async (): Promise<UploadResult<R>> => {
        setPending(true);
        let reauthed = false;
        try {
          for (;;) {
            try {
              return { ok: true as const, data: await api.upload<R>(path, form) };
            } catch (e) {
              if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && !reauthed) {
                reauthed = true;
                if (await requestReauth()) continue;
              }
              const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
              return { ok: false as const, code: err.code, message: messageFor(err, UPLOAD_MESSAGES) };
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
    [api, qc, requestReauth],
  );
  return { run, pending };
}

/** The signed-in person's id and role in the current team. */
export function useMe(): { userId: string | null; role: NonNullable<ReturnType<typeof useSession>['session']>['tenants'][number]['role'] | null } {
  const { session } = useSession();
  return { userId: session?.user.id ?? null, role: session?.tenant?.role ?? null };
}
