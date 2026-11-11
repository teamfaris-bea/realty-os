// Contract test of the compose surface's STUB(22) client (channelApi.ts) against a fake of the PHASE2_3_PLAN
// §5.4 (22) interface: the web-chat branch of POST /contacts/:id/messages (dispatch.ts deliverChannelMessage)
// and an approved draft moved to web chat (drafts.ts: approved drafts may use web_chat). The fake accepts
// exactly the request shapes the client must send and answers with the shapes module 22 is specified to return
// (the Phase 1 ComposeResponse / ApproveResponse, plus CHANNEL_NOT_CONNECTED for an ended chat or a
// disconnected widget, E77 / R-INBOX-7). When module 22 lands the orchestrator points this file at the real
// route; a shape change then fails here first.
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, tableWith } from '../../shell/testing/fakeApi.js';
import { CHANNEL_NOT_CONNECTED, useWebChatApprove, useWebChatSend } from './channelApi.js';
import channelApiSource from './channelApi.ts?raw';

const CONTACT = '01900000-0000-7000-8000-00000000c001';
const DRAFT = '01900000-0000-7000-8000-00000000a001';
const DECISION = { id: null, outcome: 'allow', reasons: [], explanation: 'Allowed', phase: 'send' };

/** §5.4 (22) request shapes, checked field for field (strict: no extra field, as the API's z.strictObject). */
function isWebChatCompose(b: unknown): boolean {
  const o = b as Record<string, unknown>;
  return Object.keys(o).sort().join(',') === 'body,channel,idempotencyKey' && o.channel === 'web_chat' && typeof o.body === 'string' && (o.body as string).length >= 1 && (o.body as string).length <= 10_000 && /^[A-Za-z0-9_:.-]{8,100}$/.test(String(o.idempotencyKey));
}
function isWebChatApprove(b: unknown): boolean {
  const o = b as Record<string, unknown>;
  const p = o.editedPayload as Record<string, unknown> | undefined;
  const keys = Object.keys(o).filter((k) => k !== 'commandId' && k !== 'reviewedInboundSeq');
  return keys.join(',') === 'editedPayload' && !!p && Object.keys(p).sort().join(',') === 'body,channel' && p.channel === 'web_chat' && typeof p.body === 'string' && (o.reviewedInboundSeq === undefined || Number.isInteger(o.reviewedInboundSeq));
}

/** A fake module 22: refuses anything but the §5.4 shapes with 400, and an ended chat with CHANNEL_NOT_CONNECTED. */
function module22(state: { ended: boolean; asDecision?: boolean }) {
  return new FakeFetch()
    .on(`POST /contacts/${CONTACT}/messages`, (c) => {
      if (!isWebChatCompose(c.body)) return err(400, 'VALIDATION_FAILED');
      if (state.ended && state.asDecision) return { status: 200, body: { message: null, decision: { ...DECISION, outcome: 'deny', reasons: [CHANNEL_NOT_CONNECTED], explanation: 'The chat has ended' }, result: 'blocked' } };
      if (state.ended) return err(409, CHANNEL_NOT_CONNECTED);
      return { status: 201, body: { message: { id: '01900000-0000-7000-8000-0000000e5501', channel: 'web_chat', status: 'sent', statusReason: null, purpose: 'informational', body: (c.body as { body: string }).body, subject: null, scheduledFor: null, dispatchedAt: new Date().toISOString() }, decision: DECISION, result: 'sent' } };
    })
    .on(`POST /assistant/actions/${DRAFT}/approve`, (c) => {
      if (!isWebChatApprove(c.body)) return err(400, 'VALIDATION_FAILED');
      if (state.ended) return err(409, CHANNEL_NOT_CONNECTED);
      return { status: 200, body: { actionId: DRAFT, status: 'executed', result: 'sent', messageId: '01900000-0000-7000-8000-0000000e5502', decision: DECISION } };
    });
}

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

describe('STUB(22) compose/channelApi.ts against the §5.4 (22) interface', () => {
  it('R-INBOX-1: a web-chat reply is POST /contacts/:id/messages {channel: "web_chat", body, idempotencyKey} and the sent message comes back', async () => {
    const fake = module22({ ended: false });
    const { result } = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(fake) });
    let out: Awaited<ReturnType<typeof result.current.send>> | null = null;
    await act(async () => {
      out = await result.current.send('Yes, 10 to 12');
    });
    expect(out).toMatchObject({ kind: 'done', response: { result: 'sent', message: { channel: 'web_chat' } } });
    expect(fake.callsTo(`POST /contacts/${CONTACT}/messages`)).toHaveLength(1);
  });

  it('E77 R-INBOX-7: an ended chat or a disconnected widget is "chat_ended" whether module 22 answers 409 CHANNEL_NOT_CONNECTED or a blocked decision', async () => {
    for (const asDecision of [false, true]) {
      const fake = module22({ ended: true, asDecision });
      const { result } = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(fake) });
      let out: unknown = null;
      await act(async () => {
        out = await result.current.send('Hello?');
      });
      expect(out).toEqual({ kind: 'chat_ended' });
    }
  });

  it('an approved draft moved to web chat is POST /assistant/actions/:id/approve {editedPayload: {channel: "web_chat", body}}', async () => {
    const fake = module22({ ended: false });
    const { result } = renderHook(() => useWebChatApprove(CONTACT, DRAFT), { wrapper: wrapper(fake) });
    let out: { ok: boolean } | null = null;
    await act(async () => {
      out = await result.current.approve('Yes, 10 to 12', 7);
    });
    expect(out).toMatchObject({ ok: true, data: { result: 'sent' } });
    expect(fake.callsTo(`POST /assistant/actions/${DRAFT}/approve`)[0]!.body).toMatchObject({ editedPayload: { channel: 'web_chat', body: 'Yes, 10 to 12' }, reviewedInboundSeq: 7 });
  });

  it('every call to a module 22 route that does not exist yet is marked STUB(22) with its method and route', () => {
    const src = channelApiSource;
    const marks = [...src.matchAll(/\/\/ STUB\(22\): (GET|POST) (\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(marks).toEqual(['POST /contacts/:id/messages', 'POST /assistant/actions/:id/approve']);
    // and each marked line sits directly above the call it marks
    expect(src).toMatch(/\/\/ STUB\(22\): POST \/contacts\/:id\/messages\n\s+const cmd = useCommand/);
    expect(src).toMatch(/\/\/ STUB\(22\): POST \/assistant\/actions\/:id\/approve\n\s+const cmd = useCommand/);
  });
});
