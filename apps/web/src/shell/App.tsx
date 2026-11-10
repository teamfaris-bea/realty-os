// The app: providers, the session gate and the routes built from the page registry.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';
import { Navigate, type RouteObject, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom';
import { Button, EvidenceRoutesProvider, Notice } from '../design/index.js';
import { ApiClient, isRetryable } from './api.js';
import { pathAfterAuth, sessionGate } from './authApi.js';
import { SessionSync, ShellProvider, useSession, useShell } from './context.js';
import { messageFor } from './errorMessages.js';
import { AppLayout, PageFrame, PageLoading } from './Layout.js';
import { type PageTable, buildPageTable, canOpen } from './pages.js';
import { surfaces } from './registry.js';
import { ReauthProvider } from './reauth.js';
import { NotFoundPage } from './ShellPages.js';
import { homeFallback } from './shellSurface.js';
import type { PageDef } from './types.js';
import { LoginPage, MfaEnrollPage, MfaVerifyPage, ChooseTeamPage } from './auth/SignIn.js';
import { ForgotPasswordPage, InvitePage, ResetPasswordPage, SignupPage } from './auth/Account.js';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // reads retry only when a retry can help (offline blip, 502/503/504), never on 4xx
        retry: (count, e) => count < 2 && isRetryable(e),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

/** Blocks the app until the session is known; sends it through MFA / team choice first. */
function RequireReady({ children }: { children: ReactNode }) {
  const { session, loadError, reload } = useSession();
  const { intent } = useShell();
  const location = useLocation();
  if (session === undefined) {
    if (loadError) {
      return (
        <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
          <Notice tone="error" title="Can't load the app">
            {messageFor(loadError)}
          </Notice>
          <Button onClick={reload}>Try again</Button>
        </div>
      );
    }
    return <PageLoading />;
  }
  if (sessionGate(session) !== 'ready') {
    // after an explicit sign-out the next sign-in starts at home, not on the page signed out from
    const here = session === null && intent.signedOut ? '/' : `${location.pathname}${location.search}`;
    return <Navigate to={pathAfterAuth(session, here)} replace />;
  }
  return <>{children}</>;
}

/** Loads the session for screens outside the app frame (they decide what to do with it). */
function WithSession({ children }: { children: ReactNode }) {
  const { session, loadError } = useSession();
  if (session === undefined && !loadError) return <PageLoading />;
  return <>{children}</>;
}

function RegistryPage({ page }: { page: PageDef }) {
  const { session } = useSession();
  const role = session?.tenant?.role;
  if (!role || !canOpen(page, role)) return <PageFrame title="Not available" detail={false}><NotFoundPage /></PageFrame>;
  const C = page.component;
  return (
    <PageFrame title={page.title} detail={page.nav === undefined && page.path !== '/more'}>
      <C />
    </PageFrame>
  );
}

export function buildRoutes(table: PageTable): RouteObject[] {
  const open = (el: ReactNode) => <WithSession>{el}</WithSession>;
  return [
    { path: '/login', element: open(<LoginPage />) },
    { path: '/login/mfa', element: open(<MfaVerifyPage />) },
    { path: '/mfa/enroll', element: open(<MfaEnrollPage />) },
    { path: '/choose-team', element: open(<ChooseTeamPage />) },
    { path: '/signup', element: open(<SignupPage />) },
    { path: '/forgot-password', element: open(<ForgotPasswordPage />) },
    { path: '/reset-password', element: open(<ResetPasswordPage />) },
    { path: '/invite', element: open(<InvitePage />) },
    { path: '/invite/:token', element: open(<InvitePage />) },
    {
      element: (
        <RequireReady>
          <AppLayout />
        </RequireReady>
      ),
      children: [
        ...table.pages.map((p) => ({ path: p.path, element: <RegistryPage page={p} /> })),
        {
          path: '*',
          element: (
            <PageFrame title="Not available" detail={false}>
              <NotFoundPage />
            </PageFrame>
          ),
        },
      ],
    },
  ];
}

export const defaultPageTable = (): PageTable => buildPageTable(surfaces, homeFallback);

function Providers({ api, table, queryClient, children }: { api: ApiClient; table: PageTable; queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ShellProvider api={api} table={table}>
        <SessionSync />
        <ReauthProvider>
          <EvidenceFromTable>{children}</EvidenceFromTable>
        </ReauthProvider>
      </ShellProvider>
    </QueryClientProvider>
  );
}

function EvidenceFromTable({ children }: { children: ReactNode }) {
  const { table } = useShell();
  return <EvidenceRoutesProvider routes={table.evidenceRoutes}>{children}</EvidenceRoutesProvider>;
}

export interface AppProps {
  api?: ApiClient;
  table?: PageTable;
  queryClient?: QueryClient;
  /** tests pass a memory router built from buildRoutes */
  router?: ReturnType<typeof createBrowserRouter>;
}

export function App(props: AppProps = {}) {
  const api = useMemo(() => props.api ?? new ApiClient(), [props.api]);
  const table = useMemo(() => props.table ?? defaultPageTable(), [props.table]);
  const queryClient = useMemo(() => props.queryClient ?? createQueryClient(), [props.queryClient]);
  const router = useMemo(() => props.router ?? createBrowserRouter(buildRoutes(table)), [props.router, table]);
  return (
    <Providers api={api} table={table} queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  );
}

