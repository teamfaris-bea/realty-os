// Shell context: the API client, the page table built from the registry, and the session.
//
// The session is server state (GET /auth/session) kept in the TanStack Query cache under
// SESSION_KEY. Login-like responses write it directly; a 401 UNAUTHENTICATED from any call clears
// it (and every other cached query, so nothing from the old session stays on screen).
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { ApiError, type ApiClient } from './api.js';
import { type AuthApi, type SessionInfo, authApi } from './authApi.js';
import type { PageTable } from './pages.js';

export const SESSION_KEY = ['auth', 'session'] as const;

interface ShellValue {
  api: ApiClient;
  auth: AuthApi;
  table: PageTable;
  /** set by an explicit sign-out so the gate sends the person to sign-in without a `next` */
  intent: { signedOut: boolean };
}

const ShellContext = createContext<ShellValue | null>(null);

export function ShellProvider({ api, table, children }: { api: ApiClient; table: PageTable; children: ReactNode }) {
  const value = useMemo(() => ({ api, auth: authApi(api), table, intent: { signedOut: false } }), [api, table]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error('useShell outside ShellProvider');
  return v;
}

export function useApi(): ApiClient {
  return useShell().api;
}

/** Clears every cached query except the (now null) session. */
function clearUserData(qc: QueryClient): void {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] || q.queryKey[1] !== SESSION_KEY[1] });
}

export interface SessionState {
  /** undefined while the first GET /auth/session is in flight */
  session: SessionInfo | null | undefined;
  /** the first load failed for a reason other than "not signed in" (e.g. offline) */
  loadError: ApiError | null;
  reload(): void;
  setSession(s: SessionInfo | null): void;
  signOut(): Promise<void>;
}

export function useSession(): SessionState {
  const { api, auth, intent } = useShell();
  const qc = useQueryClient();
  const q = useQuery<SessionInfo | null, ApiError>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return await auth.session();
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'UNAUTHENTICATED' || e.status === 401)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (q.data !== undefined) api.setCsrfToken(q.data?.csrfToken ?? null);
  }, [api, q.data]);

  const setSession = useCallback(
    (s: SessionInfo | null) => {
      const prev = qc.getQueryData<SessionInfo | null>(SESSION_KEY);
      api.setCsrfToken(s?.csrfToken ?? null);
      if (s) intent.signedOut = false;
      // a different user or team: nothing cached under the old one may be shown
      if (!s || !prev || prev.user.id !== s.user.id || prev.tenant?.id !== s.tenant?.id) clearUserData(qc);
      qc.setQueryData(SESSION_KEY, s);
    },
    [api, intent, qc],
  );

  const signOut = useCallback(async () => {
    intent.signedOut = true;
    try {
      await auth.logout();
    } catch (e) {
      // already signed out is fine; anything else still clears the local session below
      if (!(e instanceof ApiError)) throw e;
    }
    setSession(null);
  }, [auth, intent, setSession]);

  return {
    session: q.data,
    loadError: q.data === undefined && q.error ? q.error : null,
    reload: () => void q.refetch(),
    setSession,
    signOut,
  };
}

/** Wires the API client's 401 signal to the session cache. Mounted once by App. */
export function SessionSync() {
  const { api } = useShell();
  const qc = useQueryClient();
  useEffect(
    () =>
      api.onUnauthenticated(() => {
        clearUserData(qc);
        qc.setQueryData(SESSION_KEY, null);
      }),
    [api, qc],
  );
  return null;
}
