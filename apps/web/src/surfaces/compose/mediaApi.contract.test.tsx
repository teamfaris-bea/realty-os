// Contract test of the compose surface's photo and video client (mediaApi.ts), and of the box's text with media
// (ComposeBody mediaIds, PreviewBody withMedia, PreviewResponse textSender), against the API's own schemas
// (apps/api/src/channels/webContract.json, generated from the routes' Zod schemas). Every request is checked against
// the route's request schema; the fake may only answer with what the API can send: a 201 upload its response schema
// accepts, a 204 with no body, or an error whose status is the contract's for its code.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { tableWith } from '../../shell/testing/fakeApi.js';
import { apiError, contract, requestViolations, responseViolations, routeFor } from '../../test/contract.js';
import { useSendCheck } from '../feed/lib/sendCheck.js';
import { MEDIA_UPLOAD_LIMIT_WORDS, deleteMedia, mediaErrorSentence, sendRefusalSentence, uploadMedia } from './mediaApi.js';
import { blobToBase64 } from './prepareMedia.js';

const CONTACT = '01900000-0000-7000-8000-00000000c001';
const UPLOAD = '01900000-0000-7000-8000-0000000f0001';

interface Seen {
  key: string;
  method: string;
  body: unknown;
}

/** A fetch that plays the API by its contract for these routes (status-aware: 201 bodies checked, 204 empty). */
function byContract(answer: (x: Seen) => { status: number; body?: unknown }, seen: Seen[], problems: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), 'https://app.example.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = routeFor(method, url.pathname);
    if (!key) throw new Error(`${method} ${url.pathname} is not a contract route`);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const x = { key, method, body };
    seen.push(x);
    const bad = requestViolations(key, body, Object.fromEntries(url.searchParams));
    if (bad.length > 0) {
      problems.push(...bad.map((b) => `${key} ${b}`));
      const e = apiError('VALIDATION_FAILED');
      return new Response(JSON.stringify(e.body), { status: e.status });
    }
    const a = answer(x);
    if (a.status === 204) {
      expect(responseViolations(key, null)).toEqual([]);
      return new Response(null, { status: 204 });
    }
    if (a.status < 300) {
      const wrong = responseViolations(key, a.body);
      if (wrong.length > 0) throw new Error(`the fake answered ${key} with a body the API never sends: ${wrong.join('; ')}`);
    } else {
      const code = (a.body as { error?: { code?: string } }).error?.code;
      if (typeof code !== 'string' || contract.errors[code] !== a.status) throw new Error(`${key} answered ${a.status} ${String(code)}, not how the API answers that code`);
    }
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
}

const upload = (b: { contentType: string; data: string }) => ({ status: 201, body: { upload: { id: UPLOAD, contentType: b.contentType, byteSize: atob(b.data).length, expiresAt: '2026-11-13T17:00:00.000Z' } } });

describe('D5a compose media against the real routes (webContract.json)', () => {
  it('R-MMS-8: the contract has both routes and every media refusal code with its status', () => {
    expect(Object.keys(contract.routes)).toEqual(expect.arrayContaining(['POST /contacts/:id/outbound-media', 'DELETE /contacts/:id/outbound-media/:uploadId']));
    expect(contract.errors).toMatchObject({ MEDIA_NOT_ALLOWED: 422, MEDIA_TOO_LARGE: 422, MEDIA_LOCATION_NOT_REMOVED: 422, MEDIA_UPLOAD_GONE: 409, MEDIA_UPLOAD_LIMIT: 409, RATE_LIMITED: 429, NOT_FOUND: 404 });
  });

  it('R-MMS-8: an upload is exactly the API\'s UploadMediaBody {contentType, data: strict padded base64} and its 201 UploadMediaResponse comes back; a removal is a DELETE answered 204', async () => {
    const seen: Seen[] = [];
    const problems: string[] = [];
    const api = new ApiClient({ fetch: byContract((x) => (x.method === 'DELETE' ? { status: 204 } : upload(x.body as { contentType: string; data: string })), seen, problems) });
    // 1, 2 and 3 bytes: every padding the base64 can have
    for (const n of [1, 2, 3, 1000]) {
      const data = await blobToBase64(new Blob([new Uint8Array(n).fill(0xfb)]));
      expect(data.length % 4).toBe(0);
      const r = await uploadMedia(api, CONTACT, { contentType: 'image/jpeg', data }, 'photo');
      expect(r).toEqual({ ok: true, upload: { id: UPLOAD, contentType: 'image/jpeg', byteSize: n, expiresAt: '2026-11-13T17:00:00.000Z' } });
    }
    expect(Object.keys(seen[0]!.body as object).sort()).toEqual(['contentType', 'data']);
    expect(await deleteMedia(api, CONTACT, UPLOAD)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ key: 'DELETE /contacts/:id/outbound-media/:uploadId', body: undefined });
    expect(problems).toEqual([]);
    // the API refuses what this client never sends: another type, a commandId, unpadded base64
    expect(requestViolations('POST /contacts/:id/outbound-media', { contentType: 'image/webp', data: 'AAAA' }, {})).not.toEqual([]);
    expect(requestViolations('POST /contacts/:id/outbound-media', { contentType: 'image/jpeg', data: 'AAAA', commandId: 'x' }, {})).not.toEqual([]);
    expect(requestViolations('POST /contacts/:id/outbound-media', { contentType: 'image/jpeg', data: 'AA-A' }, {})).not.toEqual([]);
  });

  it('R-MMS-8: every refusal of an upload is said in words, never as a code; a removal of one already gone (404) counts as removed', async () => {
    const cases: [string, Record<string, unknown> | undefined, string][] = [
      ['MEDIA_UPLOAD_LIMIT', undefined, MEDIA_UPLOAD_LIMIT_WORDS],
      ['MEDIA_LOCATION_NOT_REMOVED', undefined, "The location couldn't be removed from this file, so it can't be sent. Send a link to it instead."],
      ['MEDIA_NOT_ALLOWED', undefined, "This file can't be sent by text. Try a JPEG or PNG photo, or an MP4 or MOV video."],
      ['MEDIA_TOO_LARGE', { limitBytes: 500_000, scope: 'item' }, "It's larger than a text can carry: a video can be at most 500 KB."],
      ['RATE_LIMITED', undefined, 'Too many photos and videos were attached in the last hour. Try again later.'],
      ['NOT_FOUND', undefined, "This person isn't available to you any more."],
      ['PAYLOAD_TOO_LARGE', undefined, "It's larger than a text can carry."],
    ];
    for (const [code, details, words] of cases) {
      const api = new ApiClient({ fetch: byContract(() => apiError(code, details), [], []) });
      const r = await uploadMedia(api, CONTACT, { contentType: 'video/mp4', data: 'AAAA' }, 'video');
      expect(r).toEqual({ ok: false, code, sentence: words });
      expect(r.ok ? '' : r.sentence).not.toMatch(/[A-Z]{3,}_/);
    }
    expect(mediaErrorSentence('MEDIA_TOO_LARGE', { limitBytes: 5_000_000, scope: 'total' })).toBe('That would make this text larger than 5 MB in all.');
    const gone = new ApiClient({ fetch: byContract(() => apiError('NOT_FOUND'), [], []) });
    expect(await deleteMedia(gone, CONTACT, UPLOAD)).toBe(true);
  });

  it('R-MMS-8: a text with media is the API\'s ComposeBody (mediaIds 1 to 10, the words may be empty) and its refusals are said in words', () => {
    const ok = { channel: 'sms', body: '', idempotencyKey: 'k-12345678', mediaIds: [UPLOAD] };
    expect(requestViolations('POST /contacts/:id/messages', ok, {})).toEqual([]);
    expect(requestViolations('POST /contacts/:id/messages', { ...ok, mediaIds: [] }, {})).not.toEqual([]);
    expect(requestViolations('POST /contacts/:id/messages', { ...ok, mediaIds: Array.from({ length: 11 }, () => UPLOAD) }, {})).not.toEqual([]);
    expect(sendRefusalSentence('MEDIA_UPLOAD_GONE', { uploadId: UPLOAD })).toBe('Not sent: a photo or video is no longer available. Remove it and attach it again.');
    expect(sendRefusalSentence('VALIDATION_FAILED', { issues: [{ path: '/mediaIds', code: 'media_text_only' }] })).toBe('Not sent: photos and videos go only by text.');
    expect(sendRefusalSentence('VALIDATION_FAILED', { issues: [{ path: '/body', code: 'text_too_long' }] })).toBe('Not sent: too long for a text. Shorten it or send an email.');
    expect(sendRefusalSentence('MEDIA_TOO_LARGE', { limitBytes: 5_000_000, scope: 'total' })).toBe('Not sent: that would make this text larger than 5 MB in all.');
    expect(sendRefusalSentence('DRAFT_STALE', null)).toBeNull();
  });

  it('R-MMS-9: the preview of a text with media is the API\'s PreviewBody (withMedia, the words may be empty) and its textSender is read', async () => {
    const seen: Seen[] = [];
    const problems: string[] = [];
    const api = new ApiClient({ fetch: byContract(() => ({ status: 200, body: { decision: { id: null, outcome: 'allow', reasons: [], explanation: 'Allowed', phase: 'preview' }, body: '', textSender: 'toll_free' } }), seen, problems) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ShellProvider api={api} table={tableWith()}>
          {children}
        </ShellProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useSendCheck({ contactId: CONTACT, channel: 'sms', body: '', withMedia: true }), { wrapper });
    await waitFor(() => expect(result.current.textSender).toBe('toll_free'));
    expect(seen[0]!.body).toEqual({ channel: 'sms', body: '', withMedia: true });
    expect(problems).toEqual([]);
    // without media the words are required by the route's handler, and the client never previews empty words
    expect(responseViolations('POST /contacts/:id/messages/preview', { decision: { id: null, outcome: 'allow', reasons: [], explanation: 'x', phase: 'preview' }, body: 'x' })).toEqual([]);
  });
});
