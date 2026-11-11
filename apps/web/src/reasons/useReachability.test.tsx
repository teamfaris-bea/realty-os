// The reachability summary as the compose box reads it (finding UXA-8): whether it is still loading (the box then
// picks no channel and says nothing it may take back), and, while a web chat is live, asked again on an interval, so a
// chat that ends while the agent is on the thread is said by the summary too, not only by a refused send.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../shell/index.js';
import { ShellProvider } from '../shell/context.js';
import { FakeFetch, tableWith } from '../shell/testing/fakeApi.js';
import { IDS, reachability } from '../surfaces/feed/lib/testing.js';
import { useReachabilityQuery } from './useReachability.js';

function wrapper(fake: FakeFetch) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith()}>
        {children}
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('useReachabilityQuery (finding UXA-8)', () => {
  it('says while the summary is loading, and not once it answered or failed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const fake = new FakeFetch().on(`GET /contacts/${IDS.jane}/reachability`, async () => {
      await gate;
      return { status: 200, body: { reachability: reachability(IDS.jane, {}, 'open') } };
    });
    const { result } = renderHook(() => useReachabilityQuery(IDS.jane), { wrapper: wrapper(fake) });
    expect(result.current).toEqual({ summary: null, pending: true });
    release();
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.summary?.channels.web_chat?.session).toEqual({ open: true, widgetConnected: true });
    const failing = renderHook(() => useReachabilityQuery(IDS.pat), { wrapper: wrapper(new FakeFetch()) });
    await waitFor(() => expect(failing.result.current).toEqual({ summary: null, pending: false }));
    // no contact: nothing to wait for
    expect(renderHook(() => useReachabilityQuery(null), { wrapper: wrapper(new FakeFetch()) }).result.current).toEqual({ summary: null, pending: false });
  });

  it('asks again on the interval it is given (the thread gives one while a web chat is live)', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, {}, 'open') } });
    renderHook(() => useReachabilityQuery(IDS.jane, { refetchMs: 40 }), { wrapper: wrapper(fake) });
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${IDS.jane}/reachability`).length).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
  });
});
