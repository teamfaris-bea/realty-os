// Contract test of the widget's STUB(22) client (api.ts) against a fake of the PHASE2_3_PLAN §5.4 (22)
// public web-chat interface:
//   POST /public/chat/:widgetKey/start {name, phone|email, message, disclosureId}
//   POST /public/chat/session/:token/messages
//   GET  /public/chat/session/:token/poll?after=
// The fake accepts exactly those requests (strict bodies, no cookies: the visitor is not a principal) and
// answers with the response shapes api.ts reads (VERIFY(22)). When module 22 lands the orchestrator runs this
// against the real routes; a shape change fails here first.
import { describe, expect, it } from 'vitest';
import { chatApi, parsePoll, parseStart } from './api.js';
import apiSource from './api.ts?raw';

const KEY = 'wk_preview_0123456789abcdef';
const TOKEN = 'st_0123456789abcdef0123456789abcdef';
const DISCLOSURE = '01900000-0000-7000-8000-0000000d15c1';

interface Seen {
  method: string;
  url: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

/** A fake module 22: 400 for anything but the §5.4 shapes. */
function module22(opts: { limit?: boolean; ended?: boolean; disconnected?: boolean } = {}) {
  const seen: Seen[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const f = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ method: init.method ?? 'GET', url, body, credentials: init.credentials });
    if (opts.limit) return json(429, { error: { code: 'RATE_LIMITED' } });
    const u = new URL(url, 'https://app.example.com');
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/public\/chat\/([^/]+)\/start$/.exec(u.pathname)) && init.method === 'POST') {
      if (opts.disconnected) return json(409, { error: { code: 'CHANNEL_NOT_CONNECTED' } });
      const keys = Object.keys(body ?? {}).sort().join(',');
      const ok = m[1] === KEY && (keys === 'disclosureId,message,name,phone' || keys === 'disclosureId,email,message,name') && body!.disclosureId === DISCLOSURE && String(body!.message).length <= 2000;
      if (!ok) return json(400, { error: { code: 'VALIDATION_FAILED' } });
      return json(201, { token: TOKEN, messages: [{ id: 'm1', from: 'visitor', body: body!.message, at: '2026-11-11T17:00:00Z' }], cursor: 'c1' });
    }
    if ((m = /^\/api\/public\/chat\/session\/([^/]+)\/messages$/.exec(u.pathname)) && init.method === 'POST') {
      if (opts.ended) return json(410, { error: { code: 'CHANNEL_NOT_CONNECTED' } });
      if (m[1] !== TOKEN || Object.keys(body ?? {}).join(',') !== 'body') return json(400, { error: { code: 'VALIDATION_FAILED' } });
      return json(201, { message: { id: 'm2', from: 'visitor', body: body!.body, at: '2026-11-11T17:01:00Z' } });
    }
    if ((m = /^\/api\/public\/chat\/session\/([^/]+)\/poll$/.exec(u.pathname)) && (init.method ?? 'GET') === 'GET') {
      if (opts.ended) return json(404, { error: { code: 'NOT_FOUND' } });
      if (m[1] !== TOKEN) return json(404, { error: { code: 'NOT_FOUND' } });
      const after = u.searchParams.get('after');
      const all = [
        { id: 'm1', from: 'visitor', body: 'Is 12 Oak St still available?', at: '2026-11-11T17:00:00Z' },
        { id: 'm3', from: 'team', body: 'Hi Pat, this is the Harbor team assistant. Ava will reply shortly.', at: '2026-11-11T17:00:30Z' },
      ];
      return json(200, { messages: after === 'c1' ? all.slice(1) : all, cursor: 'c2', ended: false });
    }
    return json(404, { error: { code: 'NOT_FOUND' } });
  };
  return { f, seen };
}

const api = (m: ReturnType<typeof module22>) => chatApi('https://app.example.com/api/', m.f);

describe('STUB(22) widget/api.ts against the §5.4 (22) public web-chat interface', () => {
  it('R-INBOX-5: start sends exactly {name, phone|email, message, disclosureId} to /public/chat/:widgetKey/start, with no cookies', async () => {
    const m = module22();
    const byPhone = await api(m).start(KEY, { name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: DISCLOSURE });
    expect(byPhone).toEqual({ ok: true, data: { token: TOKEN, messages: [{ id: 'm1', from: 'visitor', body: 'Is 12 Oak St still available?', at: '2026-11-11T17:00:00Z' }], cursor: 'c1' } });
    const byEmail = await api(m).start(KEY, { name: 'Pat Lee', email: 'pat@example.com', message: 'Hi', disclosureId: DISCLOSURE });
    expect(byEmail.ok).toBe(true);
    expect(m.seen.map((s) => [s.method, s.url, s.credentials])).toEqual([
      ['POST', `https://app.example.com/api/public/chat/${KEY}/start`, 'omit'],
      ['POST', `https://app.example.com/api/public/chat/${KEY}/start`, 'omit'],
    ]);
    expect(m.seen[0]!.body).toEqual({ name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: DISCLOSURE });
  });

  it('R-INBOX-5: messages go to /public/chat/session/:token/messages as {body}; poll reads only this session after the cursor', async () => {
    const m = module22();
    const sent = await api(m).send(TOKEN, 'Can I see it Saturday?');
    expect(sent).toEqual({ ok: true, data: { message: { id: 'm2', from: 'visitor', body: 'Can I see it Saturday?', at: '2026-11-11T17:01:00Z' } } });
    const first = await api(m).poll(TOKEN, null);
    const next = await api(m).poll(TOKEN, 'c1');
    expect(first.ok && first.data.messages.map((x) => x.id)).toEqual(['m1', 'm3']);
    expect(next.ok && next.data).toEqual({ messages: [expect.objectContaining({ id: 'm3', from: 'team' })], cursor: 'c2', ended: false });
    expect(m.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST https://app.example.com/api/public/chat/session/${TOKEN}/messages`,
      `GET https://app.example.com/api/public/chat/session/${TOKEN}/poll`,
      `GET https://app.example.com/api/public/chat/session/${TOKEN}/poll?after=c1`,
    ]);
  });

  it('E137: rate limits (429) are "rate_limited"; R-INBOX-7: a disconnected widget is "unavailable"; E77: an ended session is "ended"', async () => {
    expect(await api(module22({ limit: true })).start(KEY, { name: 'x', phone: '4155550101', message: 'x', disclosureId: DISCLOSURE })).toEqual({ ok: false, failure: 'rate_limited' });
    expect(await api(module22({ limit: true })).send(TOKEN, 'x')).toEqual({ ok: false, failure: 'rate_limited' });
    expect(await api(module22({ disconnected: true })).start(KEY, { name: 'x', phone: '4155550101', message: 'x', disclosureId: DISCLOSURE })).toEqual({ ok: false, failure: 'unavailable' });
    expect(await api(module22({ ended: true })).send(TOKEN, 'x')).toEqual({ ok: false, failure: 'ended' });
    expect(await api(module22({ ended: true })).poll(TOKEN, 'c1')).toEqual({ ok: false, failure: 'ended' });
    expect(await api(module22()).start('wrong-key', { name: 'x', phone: '4155550101', message: 'x', disclosureId: DISCLOSURE })).toEqual({ ok: false, failure: 'invalid' });
  });

  it('a response that is not the agreed shape is a failure, never rendered (no invented messages)', () => {
    expect(parseStart({ token: 'short' })).toBeNull();
    expect(parseStart({ token: TOKEN, messages: [{ id: 'm', from: 'agent', body: 'x', at: 'y' }] })).toBeNull();
    expect(parsePoll({ messages: [{ id: 'm', from: 'team', body: 'x', at: 'y' }], cursor: 'c', typing: true, online: true })).toEqual({ messages: [{ id: 'm', from: 'team', body: 'x', at: 'y' }], cursor: 'c', ended: false });
    expect(parsePoll({ messages: 'nope' })).toBeNull();
    expect(parsePoll({ messages: [], cursor: 3 })).toBeNull();
  });

  it('every call to a module 22 route that does not exist yet is marked STUB(22) with its method and route', () => {
    const marks = [...apiSource.matchAll(/\/\/ STUB\(22\): (GET|POST) (\S+)/g)].map((x) => `${x[1]} ${x[2]}`);
    expect(marks).toEqual(['POST /public/chat/:widgetKey/start', 'POST /public/chat/session/:token/messages', 'GET /public/chat/session/:token/poll']);
    expect(apiSource.match(/\bcall\(f,/g)).toHaveLength(3);
  });
});
