// Module 37 adversarial tests of the public chat widget: it runs on a brokerage's website for anonymous
// visitors, so everything it shows is treated as text and nothing it is told can make it claim more.
//   markup     a message body, a brokerage name or a disclosure carrying HTML is shown as text, never parsed
//   honesty    extra fields from the server ("typing", "online", "agentName") are ignored, never rendered
//   isolation  the widget never sends cookies, never stores more than its session token, and asks the
//              server only for its own session (R-INBOX-5)
//   abuse      a 2,000-character cap on what the visitor sends; a second Send tap while one is in flight sends once
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatApi, chatApi } from './api.js';
import { ChatWidget } from './widget.js';

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
const CFG = { widgetKey: 'wk_test_0123456789abcdef', brokerage: `Harbor ${HOSTILE}`, disclosureId: 'd1', disclosure: `Terms ${HOSTILE}`, apiBase: 'https://app.example.com/api' };
const TOKEN = 'st_0123456789abcdef0123456789abcdef';

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as { __pwned?: number }).__pwned;
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('chat widget adversarial (module 37)', () => {
  it('markup in a message, the brokerage name or the disclosure is shown as text and never runs', async () => {
    const seen: RequestInit[] = [];
    const f = vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push(init);
      if (url.endsWith('/start')) return json(201, { token: TOKEN, messages: [{ id: 'm1', from: 'visitor', body: HOSTILE, at: '2026-11-11T17:00:00Z' }], cursor: 'c1' });
      return json(200, { messages: [{ id: 'm2', from: 'team', body: HOSTILE, at: '2026-11-11T17:00:01Z', typing: true, online: true, agentName: 'Totally A Human' }], cursor: 'c2', ended: false, typing: true, presence: 'online' });
    });
    const timers: (() => void)[] = [];
    const w = new ChatWidget(CFG, { api: chatApi(CFG.apiBase, f), storage: null, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
    document.body.append(w.host);
    w.open();
    const root = w.shadow;
    (root.querySelector('input[name=name]') as HTMLInputElement).value = 'Pat';
    (root.querySelector('input[name=contact]') as HTMLInputElement).value = 'pat@example.com';
    (root.querySelector('textarea[name=message]') as HTMLTextAreaElement).value = HOSTILE;
    (root.querySelector('form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(root.querySelector('[data-message-id=m1]')).not.toBeNull());
    timers.splice(0).forEach((fn) => fn());
    await vi.waitFor(() => expect(root.querySelector('[data-message-id=m2]')).not.toBeNull());
    expect(root.querySelectorAll('img, script:not(style)').length).toBe(0);
    expect(root.querySelector('[data-message-id=m2] .b')!.textContent).toBe(HOSTILE);
    expect(root.querySelector('h2')!.textContent).toBe(CFG.brokerage);
    expect(root.querySelector('[data-disclosure]')!.textContent).toBe(CFG.disclosure);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // the server's extra claims are never shown
    expect(root.textContent).not.toMatch(/typing|online|Totally A Human/i);
    // no cookies, ever: the visitor is not a principal
    expect(seen.every((i) => i.credentials === 'omit')).toBe(true);
  });

  it('R-INBOX-5: the widget asks only for its own session, by the token it was given, and stores nothing but that token', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/start')) return json(201, { token: TOKEN, messages: [], cursor: null });
      return json(200, { messages: [], cursor: null, ended: false });
    });
    const store = new Map<string, string>();
    const timers: (() => void)[] = [];
    const w = new ChatWidget(CFG, { api: chatApi(CFG.apiBase, f), storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
    document.body.append(w.host);
    w.open();
    const root = w.shadow;
    (root.querySelector('input[name=name]') as HTMLInputElement).value = 'Pat';
    (root.querySelector('input[name=contact]') as HTMLInputElement).value = '415 555 0101';
    (root.querySelector('textarea[name=message]') as HTMLTextAreaElement).value = 'Hi';
    (root.querySelector('form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(store.size).toBe(1));
    timers.splice(0).forEach((fn) => fn());
    await vi.waitFor(() => expect(urls.length).toBe(2));
    expect(urls).toEqual([`${CFG.apiBase}/public/chat/${CFG.widgetKey}/start`, `${CFG.apiBase}/public/chat/session/${TOKEN}/poll`]);
    expect([...store.entries()]).toEqual([[`realty-chat:${CFG.widgetKey}`, JSON.stringify({ token: TOKEN })]]);
    // nothing the visitor typed is kept in the browser
    expect(JSON.stringify([...store.values()])).not.toMatch(/Pat|415|Hi/);
  });

  it('a long message is capped at 2,000 characters, and a double tap on Send sends once', async () => {
    let release: () => void = () => undefined;
    const api: ChatApi = {
      start: vi.fn(async () => ({ ok: true as const, data: { token: TOKEN, messages: [], cursor: null } })),
      send: vi.fn<ChatApi['send']>((_t, body) => new Promise((ok) => (release = () => ok({ ok: true, data: { message: { id: 's1', from: 'visitor', body, at: '2026-11-11T17:00:00Z' } } })))),
      poll: vi.fn(async () => ({ ok: true as const, data: { messages: [], cursor: null, ended: false } })),
    };
    const w = new ChatWidget(CFG, { api, storage: null, setTimer: () => 0, clearTimer: () => undefined });
    document.body.append(w.host);
    w.open();
    const root = w.shadow;
    (root.querySelector('input[name=name]') as HTMLInputElement).value = 'Pat';
    (root.querySelector('input[name=contact]') as HTMLInputElement).value = 'pat@example.com';
    (root.querySelector('textarea[name=message]') as HTMLTextAreaElement).value = 'x'.repeat(5000);
    (root.querySelector('form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect((vi.mocked(api.start).mock.calls[0]![1] as { message: string }).message).toHaveLength(2000);
    await vi.waitFor(() => expect(root.querySelector('textarea[name=reply]')).not.toBeNull());
    (root.querySelector('textarea[name=reply]') as HTMLTextAreaElement).value = 'y'.repeat(3000);
    const form = root.querySelector('.foot form') as HTMLFormElement;
    form.requestSubmit();
    form.requestSubmit();
    release();
    await vi.waitFor(() => expect(root.querySelector('[data-message-id=s1]')).not.toBeNull());
    expect(api.send).toHaveBeenCalledTimes(1);
    expect((vi.mocked(api.send).mock.calls[0]![1] as string).length).toBe(2000);
  });
});
