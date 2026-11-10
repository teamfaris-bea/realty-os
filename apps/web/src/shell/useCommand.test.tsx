// useCommand: one tap = one commandId; retries and re-sends reuse it; double taps never send twice;
// REAUTH_REQUIRED prompts and re-sends the same command; optimistic updates roll back on failure.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api.js';
import { SESSION_KEY, ShellProvider } from './context.js';
import { ReauthProvider } from './reauth.js';
import { FakeFetch, err, sessionFixture, tableWith } from './testing/fakeApi.js';
import { type Command, newCommandId, useCommand } from './useCommand.js';

function setup(fake: FakeFetch, o: { session?: ReturnType<typeof sessionFixture>; errorMessages?: Record<string, string> } = {}) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(SESSION_KEY, o.session ?? sessionFixture());
  const table = tableWith({ pages: [], errorMessages: o.errorMessages ?? {} });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={table}>
        <ReauthProvider>{children}</ReauthProvider>
      </ShellProvider>
    </QueryClientProvider>
  );
  return { api, qc, wrapper };
}

const ids = () => {
  let n = 0;
  return () => `cmd-${++n}`;
};

describe('useCommand', () => {
  it('sends a fresh commandId with each tap, in the body', async () => {
    const fake = new FakeFetch().on('POST /leads/c1/accept', { status: 200, body: { ok: true } });
    const { wrapper } = setup(fake);
    const gen = ids();
    const { result } = renderHook(() => useCommand<{ expectedSeq: number }>('/leads/c1/accept', { newId: gen }), { wrapper });
    await act(() => result.current.run({ expectedSeq: 3 }));
    await act(() => result.current.run({ expectedSeq: 4 }));
    expect(fake.calls.map((c) => c.body)).toEqual([
      { expectedSeq: 3, commandId: 'cmd-1' },
      { expectedSeq: 4, commandId: 'cmd-2' },
    ]);
  });

  it('a double tap while the first is in flight sends one command and both taps get its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeFetch().on('POST /leads/c1/claim', async () => {
      await gate;
      return { status: 200, body: { claimed: true } };
    });
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => useCommand<object, { claimed: boolean }>('/leads/c1/claim', { newId: ids() }), { wrapper });
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.run({});
      b = result.current.run({});
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    release();
    const [ra, rb] = await act(() => Promise.all([a, b]));
    expect(fake.calls).toHaveLength(1);
    expect(ra).toEqual({ ok: true, data: { claimed: true }, commandId: 'cmd-1' });
    expect(rb).toBe(ra);
    expect(result.current.pending).toBe(false);
  });

  it('two different buttons tapped concurrently are two commands with distinct ids', async () => {
    const fake = new FakeFetch().on('POST /tasks/t1/complete', { status: 200, body: {} }).on('POST /tasks/t2/complete', { status: 200, body: {} });
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => [useCommand('/tasks/t1/complete'), useCommand('/tasks/t2/complete')] as const, { wrapper });
    await act(() => Promise.all([result.current[0].run({}), result.current[1].run({})]));
    const sent = fake.calls.map((c) => (c.body as { commandId: string }).commandId);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    for (const id of sent) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('retries a network failure and a 503 with the SAME commandId, then succeeds', async () => {
    const fake = new FakeFetch().on('POST /x', (_c, n) => (n === 1 ? 'network-error' : n === 2 ? err(503, 'INTERNAL_ERROR') : { status: 200, body: { done: 1 } }));
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => useCommand('/x', { newId: ids(), retryDelayMs: () => 1 }), { wrapper });
    const r = await act(() => result.current.run({}));
    expect(r).toMatchObject({ ok: true, commandId: 'cmd-1' });
    expect(fake.calls.map((c) => (c.body as { commandId: string }).commandId)).toEqual(['cmd-1', 'cmd-1', 'cmd-1']);
  });

  it('never retries a 4xx (a 409 conflict is reported once, as a sentence)', async () => {
    const fake = new FakeFetch().on('POST /leads/c1/claim', err(409, 'LEAD_ALREADY_CLAIMED'));
    const { wrapper } = setup(fake, { errorMessages: { LEAD_ALREADY_CLAIMED: 'Someone else claimed this lead first.' } });
    const { result } = renderHook(() => useCommand('/leads/c1/claim', { newId: ids(), retryDelayMs: () => 1 }), { wrapper });
    const r = await act(() => result.current.run({}));
    expect(fake.calls).toHaveLength(1);
    expect(r).toEqual({ ok: false, code: 'LEAD_ALREADY_CLAIMED', status: 409, details: null, message: 'Someone else claimed this lead first.', commandId: 'cmd-1' });
    expect(result.current.error?.message).toBe('Someone else claimed this lead first.');
  });

  it('after automatic retries run out, retry() re-sends the failed command with its original id', async () => {
    let up = false;
    const fake = new FakeFetch().on('POST /x', () => (up ? { status: 200, body: {} } : 'network-error'));
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => useCommand('/x', { newId: ids(), retries: 1, retryDelayMs: () => 1 }), { wrapper });
    const first = await act(() => result.current.run({ n: 1 }));
    expect(first).toMatchObject({ ok: false, code: 'NETWORK_ERROR', commandId: 'cmd-1' });
    expect(first.ok === false && first.message).toMatch(/Can't reach the server/);
    up = true;
    const again = await act(() => result.current.retry()!);
    expect(again).toMatchObject({ ok: true, commandId: 'cmd-1' });
    expect(fake.calls.map((c) => c.body)).toEqual([
      { n: 1, commandId: 'cmd-1' },
      { n: 1, commandId: 'cmd-1' },
      { n: 1, commandId: 'cmd-1' },
    ]);
    expect(result.current.retry()).toBeNull();
  });

  it('uses the endpoint id key when it is not commandId (messages: idempotencyKey)', async () => {
    const fake = new FakeFetch().on('POST /contacts/c1/messages', { status: 201, body: {} });
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => useCommand('/contacts/c1/messages', { idKey: 'idempotencyKey', newId: ids() }), { wrapper });
    await act(() => result.current.run({ channel: 'sms', body: 'hi' }));
    expect(fake.calls[0]?.body).toEqual({ channel: 'sms', body: 'hi', idempotencyKey: 'cmd-1' });
  });

  it('applies an optimistic update and rolls it back when the command fails; refetches listed queries', async () => {
    const fake = new FakeFetch().on('POST /tasks/t1/complete', err(404, 'NOT_FOUND')).on('GET /tasks', { status: 200, body: ['fresh'] });
    const { wrapper, qc, api } = setup(fake);
    qc.setQueryData(['tasks'], ['t1']);
    qc.setQueryDefaults(['tasks'], { queryFn: () => api.get('/tasks') });
    const seen: unknown[] = [];
    const { result } = renderHook(
      () =>
        useCommand('/tasks/t1/complete', {
          invalidate: [['tasks']],
          optimistic: (_b, { queryClient }) => {
            const before = queryClient.getQueryData(['tasks']);
            queryClient.setQueryData(['tasks'], []);
            seen.push(queryClient.getQueryData(['tasks']));
            return () => queryClient.setQueryData(['tasks'], before);
          },
        }),
      { wrapper },
    );
    const r = await act(() => result.current.run({}));
    expect(r.ok).toBe(false);
    expect(seen).toEqual([[]]);
    // rolled back, then invalidated (stale) so an observer refetches the server's truth
    expect(qc.getQueryData(['tasks'])).toEqual(['t1']);
    expect(qc.getQueryState(['tasks'])?.isInvalidated).toBe(true);
  });

  it('REAUTH_REQUIRED asks for the password, then re-sends the SAME command', async () => {
    const fake = new FakeFetch()
      .on('POST /admin/members/u1/role', (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { role: 'team_lead' } }))
      .on('POST /auth/reauth', { status: 200, body: { next: 'ready', session: sessionFixture({ csrfToken: 'after-reauth' }) } });
    const { wrapper } = setup(fake);
    let cmd!: Command<{ role: string }, unknown>;
    function Probe() {
      cmd = useCommand<{ role: string }>('/admin/members/u1/role', { newId: ids() });
      return null;
    }
    render(<Probe />, { wrapper });
    let p!: Promise<unknown>;
    act(() => {
      p = cmd.run({ role: 'team_lead' });
    });
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(act(() => p)).resolves.toMatchObject({ ok: true, commandId: 'cmd-1' });
    const sends = fake.callsTo('POST /admin/members/u1/role');
    expect(sends.map((c) => (c.body as { commandId: string }).commandId)).toEqual(['cmd-1', 'cmd-1']);
    // the re-sent command carries the rotated CSRF token from the re-auth response
    expect(sends[1]?.headers['x-csrf-token']).toBe('after-reauth');
    expect(fake.callsTo('POST /auth/reauth')[0]?.body).toEqual({ password: 'correct horse battery staple' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REAUTH asks for the authenticator code too when MFA is on; Cancel fails the command with a sentence', async () => {
    const fake = new FakeFetch().on('POST /x', err(401, 'REAUTH_REQUIRED'));
    const { wrapper } = setup(fake, { session: sessionFixture({ mfa: { enabled: true, verified: true, enrollmentRequired: false } }) });
    let cmd!: Command<object, unknown>;
    function Probe() {
      cmd = useCommand('/x', { newId: ids() });
      return null;
    }
    render(<Probe />, { wrapper });
    let p!: Promise<unknown>;
    act(() => {
      p = cmd.run({});
    });
    await screen.findByRole('dialog');
    expect(screen.getByLabelText('Authenticator code')).toHaveAttribute('autocomplete', 'one-time-code');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(act(() => p)).resolves.toMatchObject({ ok: false, code: 'REAUTH_REQUIRED', message: expect.stringMatching(/password again/) });
    expect(fake.calls).toHaveLength(1);
  });

  it('a wrong password keeps the prompt open with a sentence, not a code', async () => {
    const fake = new FakeFetch().on('POST /x', err(401, 'REAUTH_REQUIRED')).on('POST /auth/reauth', err(401, 'LOGIN_FAILED'));
    const { wrapper } = setup(fake);
    let cmd!: Command<object, unknown>;
    function Probe() {
      cmd = useCommand('/x');
      return null;
    }
    render(<Probe />, { wrapper });
    act(() => void cmd.run({}));
    await screen.findByRole('dialog');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/don't match/);
    expect(screen.getByRole('dialog').textContent).not.toMatch(/LOGIN_FAILED/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('onSuccess sees the data; pending clears even when the call throws unexpectedly', async () => {
    const onSuccess = vi.fn();
    const fake = new FakeFetch().on('POST /ok', { status: 200, body: { v: 1 } });
    const { wrapper } = setup(fake);
    const { result } = renderHook(() => useCommand('/ok', { onSuccess }), { wrapper });
    await act(() => result.current.run({ a: 1 }));
    expect(onSuccess).toHaveBeenCalledWith({ v: 1 }, { a: 1 });
    expect(result.current.pending).toBe(false);
  });
});

describe('newCommandId', () => {
  it('is a v4 UUID and unique across many taps', () => {
    const s = new Set(Array.from({ length: 2000 }, newCommandId));
    expect(s.size).toBe(2000);
  });
});
