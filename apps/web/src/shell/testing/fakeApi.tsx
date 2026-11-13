// Test helpers for shell/surface component tests: a scripted fetch, a session fixture, and a
// renderer that mounts the real App (providers + routes from a page table) on a memory router.
import { render } from '@testing-library/react';
import { type ReactElement, StrictMode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { ApiClient } from '../api.js';
import { App, buildRoutes, createQueryClient } from '../App.js';
import type { SessionInfo } from '../authApi.js';
import { type PageTable, buildPageTable } from '../pages.js';
import { homeFallback, shellSurface } from '../shellSurface.js';
import type { SurfaceModule } from '../types.js';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status: number; body?: unknown } | 'network-error';
type Handler = Reply | ((call: Call, n: number) => Reply | Promise<Reply>);

/** A fetch that answers from a script keyed by "METHOD /path" (path without the /api prefix). */
export class FakeFetch {
  calls: Call[] = [];
  private handlers = new Map<string, Handler>();
  private counts = new Map<string, number>();

  on(key: string, h: Handler): this {
    this.handlers.set(key, h);
    return this;
  }

  callsTo(key: string): Call[] {
    const [m, p] = key.split(' ');
    return this.calls.filter((c) => c.method === m && c.path === p);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    // a JSON body is parsed; any other body (a FormData upload) is kept as it is, so a test can read its fields
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : (init?.body ?? undefined);
    const call = { method, path, headers, body };
    this.calls.push(call);
    const key = `${method} ${path}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const h = this.handlers.get(key);
    const r = h === undefined ? { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } } : typeof h === 'function' ? await h(call, n) : h;
    if (r === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}

export function err(status: number, code: string, details?: Record<string, unknown>): Reply {
  return { status, body: { error: details ? { code, requestId: 'req-1', details } : { code, requestId: 'req-1' } } };
}

export function sessionFixture(over: Partial<SessionInfo> = {}): SessionInfo {
  const tenant = { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role: 'agent' as const };
  return {
    user: { id: '01900000-0000-7000-8000-0000000000aa', email: 'ava@example.test', displayName: 'Ava Agent' },
    tenant,
    tenants: [tenant],
    mfa: { enabled: false, verified: false, enrollmentRequired: false },
    reauthenticatedAt: null,
    csrfToken: 'csrf-1',
    ...over,
  };
}

export function tableWith(...extra: SurfaceModule[]): PageTable {
  return buildPageTable([shellSurface, ...extra], homeFallback);
}

/** Mounts the whole app at `path` with a fake API. */
export function renderApp(o: { fake: FakeFetch; path?: string; table?: PageTable }): { router: ReturnType<typeof createMemoryRouter>; api: ApiClient; view: ReturnType<typeof render>; qc: ReturnType<typeof createQueryClient> } {
  const api = new ApiClient({ fetch: o.fake.fetch });
  const table = o.table ?? tableWith();
  const router = createMemoryRouter(buildRoutes(table), { initialEntries: [o.path ?? '/'] });
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false, staleTime: Infinity } });
  // StrictMode, as in main.tsx: effects run twice in development, which catches non-idempotent effects
  const view = render(
    (
      <StrictMode>
        <App api={api} table={table} router={router} queryClient={qc} />
      </StrictMode>
    ) as ReactElement,
  );
  // qc: a test can stand in for a timer-driven refetch (the thread's 15 s summary refresh) without waiting for it
  return { router, api, view, qc };
}
