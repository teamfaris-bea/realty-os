// @vitest-environment node
// Contract test of the widget's client (api.ts) against module 22's real public chat routes, as the API itself
// describes them: the JSON Schemas apps/api/src/channels/webContract.ts generates from the routes' own Zod schemas
// (webContract.json; its drift test keeps it equal to what the API validates and serializes). The fake behind the
// client (test/contract.ts contractFetch) refuses with 422 any request the API would refuse, and may itself only answer
// with bodies the API can send and with each error code at the API's status, so the client is held to the real API.
import { describe, expect, it } from 'vitest';
import { type Answer, type Exchange, apiError, contract, contractFetch } from '../test/contract.js';
import { EMAIL_MAX, MESSAGE_MAX, NAME_MAX, PHONE_MAX, WIDGET_KEY, chatApi, clean, newMessageId, parseConfig, parsePoll, parseStart } from './api.js';

const KEY = `wk_${'0123456789abcdef0123456789abcdef01234567'}`;
const TOKEN = 'Xq3_kR9vL2mN8pT4wY6zA1bC5dE7fG0hJ2iK4lM6nO8';
const DISCLOSURE = '01900000-0000-7000-8000-0000000d15c1';
const BASE = 'https://app.example.test/api/';
const SENT_AT = '2026-11-11T17:00:30.000Z';
const REPLY = { id: '01900000-0000-7000-8000-0000000e5503', body: 'Hi Pat, this is the team assistant. Ava will follow up shortly.', sentAt: SENT_AT, from: 'assistant' as const };
const CONFIG = { teamName: 'Harbor & Pine Team', disclosure: { id: DISCLOSURE, text: 'By starting a chat you agree the team may reply here.' }, assistantNotice: "Replies may come from Harbor & Pine Team's automated assistant or from a person on the team." };

/** A fake module 22 that plays exactly by the contract; `seen` and `problems` record what the client sent. */
function module22(answer: (x: Exchange) => Answer) {
  const seen: Exchange[] = [];
  const problems: string[] = [];
  return { api: chatApi(BASE, contractFetch(answer, seen, problems)), seen, problems };
}

const happy = (x: Exchange): Answer => {
  switch (x.key) {
    case 'GET /public/chat/:widgetToken':
      return { status: 200, body: CONFIG };
    case 'POST /public/chat/:widgetToken/start':
      return { status: 200, body: { sessionToken: TOKEN, status: 'open' } };
    case 'POST /public/chat/session/:token/messages':
      return { status: 200, body: { accepted: true } };
    case 'GET /public/chat/session/:token/poll':
      return { status: 200, body: x.query.after ? { messages: [], cursor: x.query.after, open: true } : { messages: [REPLY], cursor: `1762880430000000.${REPLY.id}`, open: true } };
    default:
      return apiError('NOT_FOUND');
  }
};

describe('widget/api.ts against the real module 22 public chat routes (webContract.json)', () => {
  it('uses exactly the four public chat routes of the contract, with its key format and length caps', () => {
    expect(Object.keys(contract.routes).filter((k) => k.includes('/public/chat/')).sort()).toEqual([
      'GET /public/chat/:widgetToken',
      'GET /public/chat/session/:token/poll',
      'POST /public/chat/:widgetToken/start',
      'POST /public/chat/session/:token/messages',
    ]);
    expect(WIDGET_KEY.source).toBe(contract.webChat.widgetKey);
    expect(KEY).toMatch(WIDGET_KEY);
    expect(TOKEN).toMatch(new RegExp(contract.webChat.sessionToken));
    expect([NAME_MAX, MESSAGE_MAX]).toEqual([contract.webChat.nameMax, contract.webChat.messageMax]);
    const start = contract.routes['POST /public/chat/:widgetToken/start']!.body!.properties as Record<string, { maxLength: number }>;
    expect([start.phone!.maxLength, start.email!.maxLength, start.name!.maxLength, start.message!.maxLength]).toEqual([PHONE_MAX, EMAIL_MAX, NAME_MAX, MESSAGE_MAX]);
  });

  it('R-INBOX-5: GET /public/chat/:widgetKey gives the team name, the notice with its id and the assistant sentence; a team without a notice has disclosure null', async () => {
    const m = module22(happy);
    expect(await m.api.config(KEY)).toEqual({ ok: true, data: CONFIG });
    const none = module22((x) => (x.key === 'GET /public/chat/:widgetToken' ? { status: 200, body: { ...CONFIG, disclosure: null } } : happy(x)));
    expect(await none.api.config(KEY)).toEqual({ ok: true, data: { ...CONFIG, disclosure: null } });
    expect(m.seen.map((s) => [s.url.pathname, s.credentials])).toEqual([[`/api/public/chat/${KEY}`, 'omit']]);
    expect([...m.problems, ...none.problems]).toEqual([]);
  });

  it('R-INBOX-5 start: exactly {name, phone or email, message, disclosureId}, never both contacts, no cookies; it answers {sessionToken, status: "open"}', async () => {
    const m = module22(happy);
    expect(await m.api.start(KEY, { name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: DISCLOSURE })).toEqual({ ok: true, data: { sessionToken: TOKEN, status: 'open' } });
    expect(await m.api.start(KEY, { name: 'Pat Lee', email: 'pat@example.com', message: 'Hi', disclosureId: DISCLOSURE })).toEqual({ ok: true, data: { sessionToken: TOKEN, status: 'open' } });
    expect(m.seen.map((s) => s.body)).toEqual([
      { name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: DISCLOSURE },
      { name: 'Pat Lee', email: 'pat@example.com', message: 'Hi', disclosureId: DISCLOSURE },
    ]);
    expect(m.seen.every((s) => s.credentials === 'omit')).toBe(true);
    expect(m.problems).toEqual([]);
    // the API refuses both contacts at once (422); handed both, the client sends only the phone
    const both = module22(happy);
    await both.api.start(KEY, { name: 'Pat', phone: '4155550101', email: 'pat@example.com', message: 'Hi', disclosureId: DISCLOSURE });
    expect(both.seen[0]!.body).not.toHaveProperty('email');
    expect(both.problems).toEqual([]);
  });

  it('messages: {message, clientMessageId} answered {accepted: true}; poll passes the cursor back unchanged and reads replies from the team or the assistant', async () => {
    const m = module22(happy);
    const id = newMessageId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await m.api.send(TOKEN, 'Can I see it Saturday?', id)).toEqual({ ok: true, data: { accepted: true } });
    const first = await m.api.poll(TOKEN, null);
    expect(first).toEqual({ ok: true, data: { messages: [REPLY], cursor: `1762880430000000.${REPLY.id}`, open: true } });
    const cursor = first.ok ? first.data.cursor : null;
    expect(await m.api.poll(TOKEN, cursor)).toEqual({ ok: true, data: { messages: [], cursor, open: true } });
    expect(m.seen.map((s) => [s.key, s.body ?? s.query])).toEqual([
      ['POST /public/chat/session/:token/messages', { message: 'Can I see it Saturday?', clientMessageId: id }],
      ['GET /public/chat/session/:token/poll', {}],
      ['GET /public/chat/session/:token/poll', { after: cursor }],
    ]);
    expect(m.problems).toEqual([]);
  });

  it('E77 R-INBOX-7 E137: every error the routes answer is a plain failure the widget can say in words', async () => {
    const failing = (code: string, details?: Record<string, unknown>) => module22(() => apiError(code, details)).api;
    const start = (api: ReturnType<typeof failing>) => api.start(KEY, { name: 'Pat', phone: '4155550101', message: 'Hi', disclosureId: DISCLOSURE });
    expect(await failing('NOT_FOUND').config(KEY)).toEqual({ ok: false, failure: 'not_found' });
    expect(await failing('CHANNEL_NOT_CONNECTED').config(KEY)).toEqual({ ok: false, failure: 'unavailable' });
    expect(await start(failing('WEBCHAT_DISCLOSURE_STALE'))).toEqual({ ok: false, failure: 'disclosure_stale' });
    expect(await start(failing('RATE_LIMITED'))).toEqual({ ok: false, failure: 'rate_limited' });
    expect(await start(failing('VALIDATION_FAILED', { issues: [{ path: '/phone', code: 'invalid' }] }))).toEqual({ ok: false, failure: 'invalid', field: 'contact' });
    expect(await failing('WEBCHAT_SESSION_CLOSED').send(TOKEN, 'hello?', newMessageId())).toEqual({ ok: false, failure: 'closed' });
    expect(await failing('CHANNEL_NOT_CONNECTED').poll(TOKEN, null)).toEqual({ ok: false, failure: 'unavailable' });
    expect(await failing('NOT_FOUND').poll(TOKEN, null)).toEqual({ ok: false, failure: 'not_found' });
    expect(await failing('PAYLOAD_TOO_LARGE').send(TOKEN, 'x', newMessageId())).toEqual({ ok: false, failure: 'invalid' });
    expect(await chatApi(BASE, async () => Promise.reject(new TypeError('Failed to fetch'))).poll(TOKEN, null)).toEqual({ ok: false, failure: 'failed' });
  });

  it('what the visitor types is made to fit the API first: no control or format characters (a message keeps its newlines), within the caps, so it is never refused for a character they cannot see', async () => {
    const m = module22(happy);
    await m.api.start(KEY, { name: 'Pa\u200bt\tLee\u0007', email: ' pat@example.com\u200e ', message: `Hi\r\nthere\u2028${'x'.repeat(5000)}`, disclosureId: DISCLOSURE });
    await m.api.send(TOKEN, `\u202eline one\nline two\u0000${'y'.repeat(3000)}`, newMessageId());
    await m.api.send(TOKEN, `${'z'.repeat(1999)}😀`, newMessageId());
    expect(m.problems).toEqual([]);
    const [start, send, emoji] = m.seen.map((s) => s.body as { name?: string; email?: string; message: string });
    expect(start).toMatchObject({ name: 'Pat Lee', email: 'pat@example.com' });
    expect(start!.message.startsWith('Hi\nthere')).toBe(true);
    expect(start!.message).toHaveLength(MESSAGE_MAX);
    expect(send!.message.startsWith('line one\nline two y')).toBe(true);
    expect(send!.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    // a character is never cut in half at the cap
    expect(emoji!.message).toBe('z'.repeat(1999));
    expect(clean('  \u200d  ', 10)).toBe('');
  });

  it('R-INBOX-5: a joined emoji (a family, a profession, a rainbow flag) keeps its zero-width joiner and goes as typed; a joiner that joins no emoji and every other format character are still dropped', async () => {
    const m = module22(happy);
    const typed = ['\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 see you at 3', '\ud83c\udff3\ufe0f\u200d\ud83c\udf08', '\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb sent the docs', '\ud83c\udfc3\ud83c\udffd\u200d\u2640\ufe0f on my way', '\u2764\ufe0f\u200d\ud83d\udd25'];
    for (const t of typed) await m.api.send(TOKEN, t, newMessageId());
    // a joiner after a letter or before nothing, a bidi override, a zero-width space and a tag character
    await m.api.send(TOKEN, 'a\u200db \u202eok\u200b \ud83d\udc68\u200d \u{E0041}', newMessageId());
    // the contract fake refuses any message the API's own pattern refuses
    expect(m.problems).toEqual([]);
    const sent = m.seen.map((s) => (s.body as { message: string }).message);
    expect(sent.slice(0, typed.length)).toEqual(typed);
    expect(sent[typed.length]).toBe('ab ok \ud83d\udc68');
    // at the cap, a joiner whose second emoji was cut off goes with it
    expect(clean(`${'z'.repeat(1997)}\ud83d\udc68\u200d\ud83d\udc69`, MESSAGE_MAX, true)).toBe(`${'z'.repeat(1997)}\ud83d\udc68`);
    // a name, a phone and an email keep no format character at all (the API refuses every one there)
    expect(clean('Pat \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67', NAME_MAX)).toBe('Pat \ud83d\udc68\ud83d\udc69\ud83d\udc67');
  });

  it('a response that is not the API shape is a failure and is never rendered (no invented messages)', () => {
    expect(parseStart({ sessionToken: 'short', status: 'open' })).toBeNull();
    expect(parseStart({ sessionToken: TOKEN, status: 'closed' })).toBeNull();
    expect(parseConfig({ teamName: '', disclosure: null, assistantNotice: '' })).toBeNull();
    expect(parseConfig({ teamName: 'T', disclosure: { id: DISCLOSURE }, assistantNotice: '' })).toBeNull();
    // the poll carries only replies: a "visitor" message is not one, nor is a body without a time
    expect(parsePoll({ messages: [{ ...REPLY, from: 'visitor' }], cursor: null, open: true })).toBeNull();
    expect(parsePoll({ messages: [{ id: 'm', body: 'x', from: 'team' }], cursor: null, open: true })).toBeNull();
    expect(parsePoll({ messages: [], cursor: 3, open: true })).toBeNull();
    expect(parsePoll({ messages: [], cursor: null })).toBeNull();
    // fields the API does not send are dropped, never shown
    expect(parsePoll({ messages: [{ ...REPLY, typing: true }], cursor: null, open: true, presence: 'online' })).toEqual({ messages: [REPLY], cursor: null, open: true });
  });
});
