// Contract test of the compose surface's web-chat client (channelApi.ts), the box's preview (feed/lib/sendCheck.ts)
// and the reachability summary's web_chat entry against module 22's real routes, as the API itself describes them:
// the JSON Schemas apps/api/src/channels/webContract.ts generates from the routes' own Zod schemas (webContract.json;
// its drift test keeps it equal to what the API validates and serializes). Every request the client sends is checked
// against the route's request schema (a request the API would refuse is answered 422 and recorded), and the fake may
// only answer with responses the route's response schema accepts, so a future API change breaks this test.
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { Reachability } from '../../reasons/index.js';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { type Call, FakeFetch, type Reply, tableWith } from '../../shell/testing/fakeApi.js';
import { apiError, contract, requestViolations, responseViolations, violations } from '../../test/contract.js';
import { useSendCheck } from '../feed/lib/sendCheck.js';
import { CHANNEL_NOT_CONNECTED, type WebChatOutcome, useWebChatApprove, useWebChatSend } from './channelApi.js';
import { webChatState } from './channelChoice.js';

const CONTACT = '01900000-0000-7000-8000-00000000c001';
const DRAFT = '01900000-0000-7000-8000-00000000a001';
const MESSAGE = '01900000-0000-7000-8000-0000000e5501';
const DECISION_ID = '01900000-0000-7000-8000-0000000d0001';
const POINT = '01900000-0000-7000-8000-00000000ac01';

const allow = { id: null, outcome: 'allow', reasons: [], explanation: 'Allowed', phase: 'send' };
const message = (status: string, statusReason: string | null, body: string) => ({ id: MESSAGE, channel: 'web_chat', status, statusReason, purpose: 'informational', body, subject: null, scheduledFor: null, dispatchedAt: status === 'sent' ? '2026-11-11T17:00:31.000Z' : null });

/** A FakeFetch route that plays the API by its contract (request checked, response required to be one the API sends). */
function byContract(fake: FakeFetch, route: string, path: string, reply: (c: Call, n: number) => Reply, problems: string[]) {
  return fake.on(`${route.split(' ')[0]} ${path}`, (c, n) => {
    const query = Object.fromEntries(new URL(c.path, 'http://x').searchParams);
    const bad = requestViolations(route, c.body, query);
    if (bad.length > 0) {
      problems.push(...bad.map((b) => `${route} ${b}`));
      return apiError('VALIDATION_FAILED');
    }
    const r = reply(c, n);
    if (r !== 'network-error' && r.status === 200) {
      const wrong = responseViolations(route, r.body);
      if (wrong.length > 0) throw new Error(`the fake answered ${route} with a body the API never sends: ${wrong.join('; ')}`);
    }
    return r;
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

describe('compose web chat against the real module 22 routes (webContract.json)', () => {
  it('R-INBOX-1 R-GATE-14: a reply in web chat is the API\'s ComposeBody on channel web_chat (one idempotency key per tap, no scheduleAt), and its ComposeResponse comes back', async () => {
    const problems: string[] = [];
    const fake = byContract(new FakeFetch(), 'POST /contacts/:id/messages', `/contacts/${CONTACT}/messages`, (c) => ({ status: 200, body: { message: message('sent', null, (c.body as { body: string }).body), decision: allow, result: 'sent' } }), problems);
    const { result } = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(fake) });
    let out: WebChatOutcome | null = null;
    await act(async () => {
      out = await result.current.send('Yes, 10 to 12');
    });
    expect(out).toMatchObject({ kind: 'done', response: { result: 'sent', message: { channel: 'web_chat', status: 'sent' } } });
    const [call] = fake.callsTo(`POST /contacts/${CONTACT}/messages`);
    expect(Object.keys(call!.body as object).sort()).toEqual(['body', 'channel', 'idempotencyKey']);
    expect(call!.body).toMatchObject({ channel: 'web_chat', body: 'Yes, 10 to 12' });
    expect(problems).toEqual([]);
    // the API refuses a scheduled chat reply (422), and the client has no way to send one
    expect(requestViolations('POST /contacts/:id/messages', { channel: 'web_chat', body: 'x', idempotencyKey: 'k-12345678', scheduleAt: 'tomorrow' }, {})).not.toEqual([]);
  });

  it('E77 R-INBOX-7: the send-time check refuses a reply to a chat that ended or whose widget is off with a blocked decision naming CHANNEL_NOT_CONNECTED, and the outcome says the chat ended', async () => {
    const problems: string[] = [];
    const blocked = { message: message('blocked', CHANNEL_NOT_CONNECTED, 'Are you still there?'), decision: { id: DECISION_ID, outcome: 'deny', reasons: [CHANNEL_NOT_CONNECTED], explanation: 'The chat has ended.', phase: 'send' }, result: 'blocked' };
    const fake = byContract(new FakeFetch(), 'POST /contacts/:id/messages', `/contacts/${CONTACT}/messages`, () => ({ status: 200, body: blocked }), problems);
    const { result } = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(fake) });
    let out: WebChatOutcome | null = null;
    await act(async () => {
      out = await result.current.send('Are you still there?');
    });
    expect(out).toEqual({ kind: 'chat_ended' });
    expect(problems).toEqual([]);
  });

  it('F1: a lost answer and its automatic retry (the same idempotency key or commandId): the API\'s replay (noop, the stored message or messageStatus, the stored decision) is read as what the first attempt did: the chat ended', async () => {
    const problems: string[] = [];
    const ended = { id: DECISION_ID, outcome: 'deny', reasons: [CHANNEL_NOT_CONNECTED], explanation: 'The chat has ended.', phase: 'send' };
    const reply = byContract(new FakeFetch(), 'POST /contacts/:id/messages', `/contacts/${CONTACT}/messages`, (_c, n) => (n === 1 ? 'network-error' : { status: 200, body: { message: message('blocked', CHANNEL_NOT_CONNECTED, 'Are you still there?'), decision: ended, result: 'noop' } }), problems);
    const sendHook = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(reply) });
    let out: WebChatOutcome | null = null;
    await act(async () => {
      out = await sendHook.result.current.send('Are you still there?');
    });
    expect(out).toEqual({ kind: 'chat_ended' });
    const keys = reply.callsTo(`POST /contacts/${CONTACT}/messages`).map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const approve = byContract(new FakeFetch(), 'POST /assistant/actions/:id/approve', `/assistant/actions/${DRAFT}/approve`, (_c, n) => (n === 1 ? 'network-error' : { status: 200, body: { actionId: DRAFT, status: 'approved', result: 'noop', messageId: MESSAGE, decision: ended, messageStatus: 'blocked' } }), problems);
    const approveHook = renderHook(() => useWebChatApprove(CONTACT, DRAFT), { wrapper: wrapper(approve) });
    await act(async () => {
      out = await approveHook.result.current.approve('Happy to help with Elm!', null, false);
    });
    expect(out).toEqual({ kind: 'chat_ended' });
    // a replay of an approval that did go out is that message, sent
    const went = byContract(new FakeFetch(), 'POST /assistant/actions/:id/approve', `/assistant/actions/${DRAFT}/approve`, () => ({ status: 200, body: { actionId: DRAFT, status: 'executed', result: 'noop', messageId: MESSAGE, decision: null, messageStatus: 'delivered' } }), problems);
    const wentHook = renderHook(() => useWebChatApprove(CONTACT, DRAFT), { wrapper: wrapper(went) });
    await act(async () => {
      out = await wentHook.result.current.approve('Happy to help with Elm!', null, false);
    });
    expect(out).toMatchObject({ kind: 'done', response: { result: 'noop', message: { status: 'delivered' } } });
    expect(problems).toEqual([]);
  });

  it('a draft answered in web chat is the API\'s ApproveBody {commandId, editedPayload: {channel: web_chat, body}, reviewedInboundSeq}; a chat draft sent as drafted carries no editedPayload', async () => {
    const problems: string[] = [];
    const fake = byContract(new FakeFetch(), 'POST /assistant/actions/:id/approve', `/assistant/actions/${DRAFT}/approve`, () => ({ status: 200, body: { actionId: DRAFT, status: 'executed', result: 'sent', messageId: MESSAGE, decision: allow } }), problems);
    const { result } = renderHook(() => useWebChatApprove(CONTACT, DRAFT), { wrapper: wrapper(fake) });
    let edited: WebChatOutcome | null = null;
    let asDrafted: WebChatOutcome | null = null;
    await act(async () => {
      edited = await result.current.approve('Yes, 10 to 12', 7, true);
    });
    await act(async () => {
      asDrafted = await result.current.approve('Happy to help with Elm!', null, false);
    });
    expect(edited).toMatchObject({ kind: 'done', response: { result: 'sent', message: { id: MESSAGE, channel: 'web_chat' } } });
    expect(asDrafted).toMatchObject({ kind: 'done' });
    const [a, b] = fake.callsTo(`POST /assistant/actions/${DRAFT}/approve`);
    expect(a!.body).toMatchObject({ editedPayload: { channel: 'web_chat', body: 'Yes, 10 to 12' }, reviewedInboundSeq: 7, commandId: expect.any(String) });
    expect(b!.body).not.toHaveProperty('editedPayload');
    expect(problems).toEqual([]);
  });

  it('module 22: the box previews a chat reply on the API\'s PreviewBody (channel web_chat, the real text) and reads its decision and final text', async () => {
    const problems: string[] = [];
    const fake = byContract(new FakeFetch(), 'POST /contacts/:id/messages/preview', `/contacts/${CONTACT}/messages/preview`, (c) => ({ status: 200, body: { decision: { id: null, outcome: 'deny', reasons: ['PAYMENT_INSTRUCTIONS'], explanation: 'Wire instructions are never sent.', phase: 'preview' }, body: (c.body as { body: string }).body } }), problems);
    const { result } = renderHook(() => useSendCheck({ contactId: CONTACT, channel: 'web_chat', body: 'Wire the deposit to account 1234' }), { wrapper: wrapper(fake) });
    await waitFor(() => expect(result.current.decision).toMatchObject({ outcome: 'deny', reasons: ['PAYMENT_INSTRUCTIONS'] }));
    expect(result.current.final).toBe('Wire the deposit to account 1234');
    expect(fake.callsTo(`POST /contacts/${CONTACT}/messages/preview`)[0]!.body).toEqual({ channel: 'web_chat', body: 'Wire the deposit to account 1234' });
    expect(problems).toEqual([]);
  });

  it('no chat to reply to (CONTACT_POINT_MISSING, the API\'s 422) is said in words, never as a code', async () => {
    expect(contract.errors.CONTACT_POINT_MISSING).toBe(422);
    const fake = new FakeFetch().on(`POST /contacts/${CONTACT}/messages`, apiError('CONTACT_POINT_MISSING'));
    const { result } = renderHook(() => useWebChatSend(CONTACT), { wrapper: wrapper(fake) });
    let out: WebChatOutcome | null = null;
    await act(async () => {
      out = await result.current.send('Hello');
    });
    expect(out).toEqual({ kind: 'error', code: 'CONTACT_POINT_MISSING', message: "There's no website chat with them to reply to.", details: null });
  });

  it('module 22: the reachability summary\'s web_chat entry, exactly as the API sends it, is read as open, ended, turned off or opted out', () => {
    const none = { hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [] };
    const summary = (web_chat: NonNullable<Reachability['channels']['web_chat']>, doNotContact: Reachability['doNotContact'] = null): { reachability: Reachability } => ({ reachability: { contactId: CONTACT, purposeNow: 'informational', doNotContact, channels: { sms: none, voice: none, email: none, web_chat } } });
    const point = (blocked: boolean, reasons: Reachability['channels']['sms']['reasons'] = []) => [{ pointId: POINT, addressHint: 'Website chat', blocked, reasons }];
    const optOut = { code: 'CONSENT_REVOKED' as const, source: 'opt_out_language' as const, purposes: ['informational' as const, 'marketing' as const], at: '2026-11-10T15:00:00.000Z', keyword: null, recordedBy: null, importBatchId: null, suppressionReason: null, addressHint: 'web chat', otherAddress: false, addressRemoved: false, evidence: { consentEventId: '01900000-0000-7000-8000-0000000ce001', inboundMessageId: '01900000-0000-7000-8000-0000000e5599', callId: null, suppressionId: null } };
    const cases = [
      { s: summary({ hasAddress: true, defaultPointId: POINT, blocked: false, reasons: [], points: point(false), session: { open: true, widgetConnected: true } }), want: { offered: true, blocked: false } },
      { s: summary({ hasAddress: true, defaultPointId: POINT, blocked: true, reasons: [], points: point(false), session: { open: false, widgetConnected: true } }), want: { offered: true, blocked: true, sentence: 'The chat has ended: they left the page' } },
      { s: summary({ hasAddress: true, defaultPointId: POINT, blocked: true, reasons: [], points: point(false), session: { open: true, widgetConnected: false } }), want: { offered: true, blocked: true, sentence: 'The website chat was turned off' } },
      { s: summary({ hasAddress: true, defaultPointId: POINT, blocked: true, reasons: [optOut], points: point(true, [optOut]), session: { open: true, widgetConnected: true } }), want: { offered: true, blocked: true, sentence: 'Asked in the chat to stop being contacted on Nov 10' } },
      { s: summary({ ...none, session: null }), want: { offered: false, blocked: false } },
      // R-CHAN-2 (review optouts/F1): the person-level do-not-contact, first among the chat's reasons, in its own words
      { s: summary({ hasAddress: true, defaultPointId: POINT, blocked: true, reasons: [{ ...optOut, code: 'PERSON_DO_NOT_CONTACT', addressHint: null }, optOut], points: point(true, [{ ...optOut, code: 'PERSON_DO_NOT_CONTACT', addressHint: null }, optOut]), session: { open: true, widgetConnected: true } }, { ...optOut, code: 'PERSON_DO_NOT_CONTACT', addressHint: null }), want: { offered: true, blocked: true, sentence: 'Asked not to be contacted at all on Nov 10' } },
    ];
    for (const c of cases) {
      // the fixture is what the API sends (its response schema accepts it, every field present)
      expect(violations(contract.routes['GET /contacts/:id/reachability']!.response, c.s)).toEqual([]);
      expect(webChatState(c.s.reachability, true)).toMatchObject(c.want);
    }
  });
});
