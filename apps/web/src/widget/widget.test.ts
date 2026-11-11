// The chat widget in jsdom (module 37). It shows nothing until the server confirmed a chat to offer, then the team
// name, the team's notice and the server's assistant sentence before the visitor can write; start cites the notice's
// id; after a WEBCHAT_DISCLOSURE_STALE it shows the new notice in place and keeps what was typed; it renders the
// visitor's own messages once the server accepted each and only the replies the server returned, once, in order,
// signed by who sent them (R-INBOX-5); each typed message has one clientMessageId, reused when it is sent again; it
// never shows a typing indicator, presence, read receipt or reply-time promise (genuineness); and it says plainly when
// a chat ended (E77), when the widget is turned off (R-INBOX-7) and when it is rate limited (E137).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatApi, ChatReply, PollResponse, Result, WidgetConfig } from './api.js';
import { readConfig } from './config.js';
import { ChatWidget, parseContact } from './widget.js';

const KEY = `wk_${'ab'.repeat(20)}`;
const EMBED = { widgetKey: KEY, apiBase: 'https://app.example.com/api' };
const TOKEN = 'Xq3_kR9vL2mN8pT4wY6zA1bC5dE7fG0hJ2iK4lM6nO8';
const D1 = '01900000-0000-7000-8000-0000000d15c1';
const D2 = '01900000-0000-7000-8000-0000000d15c2';
const CONFIG: WidgetConfig = {
  teamName: 'Harbor & Pine Team',
  disclosure: { id: D1, text: 'By starting a chat, you agree that the team may reply here and keep a record of this conversation.' },
  assistantNotice: "Replies may come from Harbor & Pine Team's automated assistant or from a person on the team.",
};
const reply = (id: string, from: ChatReply['from'], body: string): ChatReply => ({ id, from, body, sentAt: '2026-11-11T17:00:30.000Z' });

/** Words that would claim activity or presence the server never reported. */
const PRESENCE = /typing|is writing|online|offline|available now|active now|\bseen\b|read receipt|replies in|within \d+ (minute|second)|agents? (are|is) (here|available)|messenger|instagram/i;

function fakeApi(config: Result<WidgetConfig> = { ok: true, data: CONFIG }) {
  const polls: Result<PollResponse>[] = [];
  const api = {
    config: vi.fn<ChatApi['config']>(async () => config),
    start: vi.fn<ChatApi['start']>(async () => ({ ok: true as const, data: { sessionToken: TOKEN, status: 'open' as const } })),
    send: vi.fn<ChatApi['send']>(async () => ({ ok: true as const, data: { accepted: true as const } })),
    poll: vi.fn<ChatApi['poll']>(async () => polls.shift() ?? { ok: true as const, data: { messages: [], cursor: null, open: true } }),
  };
  return { api, polls };
}

async function mount(api: ChatApi, storage: Map<string, string> | null = new Map()) {
  const timers: (() => void)[] = [];
  const store = storage && { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const w = new ChatWidget(EMBED, { api, storage: store, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined, now: () => new Date('2026-11-11T17:00:00.000Z') });
  const loaded = await w.load();
  document.body.append(w.host);
  const $ = <T extends Element = HTMLElement>(sel: string) => w.shadow.querySelector<T>(sel);
  const text = () => w.shadow.textContent ?? '';
  /** run the pending poll timer(s), as the clock would */
  const tick = async () => {
    const due = timers.splice(0);
    for (const fn of due) fn();
    await vi.waitFor(() => undefined);
    await Promise.resolve();
  };
  return { w, loaded, $, text, tick, timers };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function fill(m: Mounted, o: { name?: string; contact?: string; message?: string } = {}) {
  m.$<HTMLInputElement>('input[name=name]')!.value = o.name ?? 'Pat Lee';
  m.$<HTMLInputElement>('input[name=contact]')!.value = o.contact ?? '(415) 555-0101';
  m.$<HTMLTextAreaElement>('textarea[name=message]')!.value = o.message ?? 'Is 12 Oak St still available?';
}

async function startChat(m: Mounted, message = 'Is 12 Oak St still available?') {
  m.$<HTMLButtonElement>('.launch')!.click();
  fill(m, { message });
  m.$<HTMLFormElement>('form')!.requestSubmit();
  await vi.waitFor(() => expect(m.$('[role=log] ol')).not.toBeNull());
}

async function sendReply(m: Mounted, text: string) {
  m.$<HTMLTextAreaElement>('textarea[name=reply]')!.value = text;
  m.$<HTMLFormElement>('.foot form')!.requestSubmit();
  await vi.waitFor(() => expect(m.$('.foot .go')?.textContent ?? 'Send').not.toBe('Sending…'));
}

const log = (m: Mounted) => [...m.w.shadow.querySelectorAll('[data-message-id]')].map((e) => [e.getAttribute('data-from'), e.querySelector('.b')!.textContent]);

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('chat widget (module 37)', () => {
  it('R-INBOX-5: shows the team name, the notice and the assistant sentence from the server before the visitor can write', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    expect(m.loaded).toBe(true);
    expect(f.api.config).toHaveBeenCalledWith(KEY);
    expect(m.$('.launch')!.textContent).toBe('Chat with Harbor & Pine Team');
    m.$<HTMLButtonElement>('.launch')!.click();
    expect(m.$('[role=dialog] h2')!.textContent).toBe('Harbor & Pine Team');
    const disc = m.$('[data-disclosure]')!;
    expect(disc.textContent).toBe(CONFIG.disclosure!.text);
    expect(disc.getAttribute('data-disclosure')).toBe(D1);
    expect(m.$('.ai')!.textContent).toBe(CONFIG.assistantNotice);
    // both come before every field in reading order
    expect(disc.compareDocumentPosition(m.$('form')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.text()).not.toMatch(PRESENCE);
  });

  it('nothing is shown when there is no chat to offer: an unknown key or another website (404), a widget turned off, no notice yet, or no answer', async () => {
    for (const config of [
      { ok: false as const, failure: 'not_found' as const },
      { ok: false as const, failure: 'unavailable' as const },
      { ok: false as const, failure: 'failed' as const },
      { ok: true as const, data: { ...CONFIG, disclosure: null } },
    ]) {
      const m = await mount(fakeApi(config).api);
      expect(m.loaded).toBe(false);
      expect(m.$('.launch')).toBeNull();
      expect(m.text()).toBe(m.$('style')!.textContent);
    }
  });

  it('start cites the notice the visitor saw; the conversation shows their own message and then only the replies the server returned, signed by who sent them', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    expect(f.api.start).toHaveBeenCalledWith(KEY, { name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: D1 });
    expect(log(m)).toEqual([['visitor', 'Is 12 Oak St still available?']]);
    // the start form is gone: the keyboard is in the reply box, not lost on the page
    expect(m.w.shadow.activeElement).toBe(m.$('textarea[name=reply]'));
    expect(m.$('[data-from=visitor] .meta')!.textContent).toMatch(/^You · /);
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'assistant', 'Hi Pat, this is the team assistant. Ava will follow up.'), reply('r2', 'team', 'Hi Pat, Ava here. Yes it is!')], cursor: 'c2', open: true } });
    await m.tick();
    expect(log(m)).toEqual([
      ['visitor', 'Is 12 Oak St still available?'],
      ['assistant', 'Hi Pat, this is the team assistant. Ava will follow up.'],
      ['team', 'Hi Pat, Ava here. Yes it is!'],
    ]);
    expect(m.$('[data-message-id=r1] .meta')!.textContent).toMatch(/^Harbor & Pine Team's automated assistant · /);
    expect(m.$('[data-message-id=r2] .meta')!.textContent).toMatch(/^Harbor & Pine Team · /);
    // the notice and the assistant sentence stay in view for the whole chat
    expect(m.text()).toContain(CONFIG.assistantNotice);
    expect(m.text()).toContain('Replies appear here while this page is open.');
    expect(m.text()).not.toMatch(PRESENCE);
  });

  it('genuineness: nothing appears between polls; the cursor goes back exactly as the server gave it; a repeat delivery is drawn once', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    await m.tick();
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, null);
    expect(log(m)).toHaveLength(1);
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hello!')], cursor: '1762880430000000.01900000-0000-7000-8000-0000000e5503', open: true } });
    await m.tick();
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hello!')], cursor: '1762880430000000.01900000-0000-7000-8000-0000000e5503', open: true } });
    await m.tick();
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, '1762880430000000.01900000-0000-7000-8000-0000000e5503');
    expect(log(m)).toEqual([
      ['visitor', 'Is 12 Oak St still available?'],
      ['team', 'Hello!'],
    ]);
    expect(m.text()).not.toMatch(PRESENCE);
    expect(m.w.shadow.querySelector('[class*=typing],[class*=presence],[class*=dot]')).toBeNull();
  });

  it('a reply is shown once the server accepted it; "Sending…" is only this browser\'s request in flight; one clientMessageId per message, the same one when it is sent again', async () => {
    const f = fakeApi();
    let release: () => void = () => undefined;
    f.api.send.mockImplementationOnce(() => new Promise((ok) => (release = () => ok({ ok: true, data: { accepted: true } }))));
    const m = await mount(f.api);
    await startChat(m);
    const field = m.$<HTMLTextAreaElement>('textarea[name=reply]')!;
    field.value = 'Can I see it Saturday?';
    m.$<HTMLFormElement>('.foot form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('.foot .go')!.textContent).toBe('Sending…'));
    expect(log(m)).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(log(m)).toHaveLength(2));
    expect(log(m)[1]).toEqual(['visitor', 'Can I see it Saturday?']);
    expect(m.$('.foot .go')!.textContent).toBe('Send');
    expect(field.value).toBe('');
    const firstId = f.api.send.mock.calls[0]![2];
    // a send that fails keeps the text; sending it again is the same message (the server stores it once)
    f.api.send.mockResolvedValueOnce({ ok: false, failure: 'failed' });
    await sendReply(m, 'And Sunday?');
    expect(m.$('.foot [role=alert]')!.textContent).toBe("Couldn't send. Check your connection and try again.");
    expect(field.value).toBe('And Sunday?');
    await sendReply(m, 'And Sunday?');
    const [, , retryA] = f.api.send.mock.calls[1]!;
    const [, , retryB] = f.api.send.mock.calls[2]!;
    expect(retryA).toBe(retryB);
    expect(retryA).not.toBe(firstId);
    // a different message gets its own id
    await sendReply(m, 'Thanks!');
    expect(f.api.send.mock.calls[3]![2]).not.toBe(retryA);
    expect(log(m).map(([, b]) => b)).toEqual(['Is 12 Oak St still available?', 'Can I see it Saturday?', 'And Sunday?', 'Thanks!']);
  });

  it('E77: when the session ends the widget says so, stops polling and offers a new chat that keeps the unsent reply; nothing is promised by text or email', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    f.polls.push({ ok: true, data: { messages: [], cursor: null, open: false } });
    await m.tick();
    expect(m.text()).toContain('This chat has ended.');
    expect(m.timers).toHaveLength(0);
    expect(m.$('textarea[name=reply]')).toBeNull();
    expect(m.text()).not.toMatch(/we('ll| will) (text|email|call)|by text|by email/i);
    // a 410 WEBCHAT_SESSION_CLOSED on a send ends it too; the reply carries into the new chat's message
    document.body.innerHTML = '';
    const g = fakeApi();
    g.api.send.mockResolvedValueOnce({ ok: false, failure: 'closed' });
    const n = await mount(g.api);
    await startChat(n);
    await sendReply(n, 'hello?');
    await vi.waitFor(() => expect(n.text()).toContain('This chat has ended.'));
    [...n.w.shadow.querySelectorAll('button')].find((b) => b.textContent === 'Start a new chat')!.click();
    expect(n.$('form[aria-label="Start chat"]')).not.toBeNull();
    expect(n.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('hello?');
  });

  it('R-INBOX-7: a widget turned off during the chat ends it in words, on a poll or a send', async () => {
    for (const via of ['poll', 'send'] as const) {
      document.body.innerHTML = '';
      const f = fakeApi();
      if (via === 'poll') f.polls.push({ ok: false, failure: 'unavailable' });
      else f.api.send.mockResolvedValueOnce({ ok: false, failure: 'unavailable' });
      const m = await mount(f.api);
      await startChat(m);
      if (via === 'poll') await m.tick();
      else await sendReply(m, 'still there?');
      await vi.waitFor(() => expect(m.text()).toContain("This chat isn't available any more."));
      expect(m.$('textarea[name=reply]')).toBeNull();
    }
  });

  it('WEBCHAT_DISCLOSURE_STALE: the widget shows the team\'s new notice in place, keeps what was typed, asks to start again, and the next start cites the new notice', async () => {
    const f = fakeApi();
    f.api.start.mockResolvedValueOnce({ ok: false, failure: 'disclosure_stale' });
    const m = await mount(f.api);
    m.$<HTMLButtonElement>('.launch')!.click();
    f.api.config.mockResolvedValueOnce({ ok: true, data: { ...CONFIG, disclosure: { id: D2, text: 'Our new chat notice.' } } });
    fill(m, { message: 'Hello' });
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('[role=alert]')!.textContent).toBe('The notice above has just changed. Please read it, then tap Start chat again.'));
    expect(m.$('[data-disclosure]')!.textContent).toBe('Our new chat notice.');
    expect(m.$('[data-disclosure]')!.getAttribute('data-disclosure')).toBe(D2);
    expect(m.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('Hello');
    expect(m.$<HTMLInputElement>('input[name=name]')!.value).toBe('Pat Lee');
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('[role=log]')).not.toBeNull());
    expect(f.api.start.mock.calls.map((c) => c[1].disclosureId)).toEqual([D1, D2]);
  });

  it('E137: a rate-limited start says so and keeps what the visitor typed; a refused phone or email is named; a widget turned off says chat is not available', async () => {
    const f = fakeApi();
    f.api.start
      .mockResolvedValueOnce({ ok: false, failure: 'rate_limited' })
      .mockResolvedValueOnce({ ok: false, failure: 'invalid', field: 'contact' })
      .mockResolvedValueOnce({ ok: false, failure: 'unavailable' });
    const m = await mount(f.api);
    m.$<HTMLButtonElement>('.launch')!.click();
    fill(m, { name: 'Pat', contact: 'pat@example.com', message: 'Hi' });
    const alert = () => m.$('[role=alert]')!.textContent;
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(alert()).toBe('Too many messages right now. Please wait a minute and try again.'));
    expect(m.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('Hi');
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(alert()).toBe('Please check the phone number or email address.'));
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(alert()).toBe("Chat isn't available right now. Please try again later."));
    expect(f.api.start).toHaveBeenLastCalledWith(KEY, { name: 'Pat', email: 'pat@example.com', message: 'Hi', disclosureId: D1 });
  });

  it('the form asks for a name, a phone or email, and a message before anything is sent', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    m.$<HTMLButtonElement>('.launch')!.click();
    m.$<HTMLFormElement>('form')!.requestSubmit();
    expect(m.$('[role=alert]')!.textContent).toBe('Please enter your name.');
    m.$<HTMLInputElement>('input[name=name]')!.value = 'Pat';
    m.$<HTMLInputElement>('input[name=contact]')!.value = 'not a contact';
    m.$<HTMLFormElement>('form')!.requestSubmit();
    expect(m.$('[role=alert]')!.textContent).toBe('Please enter a phone number or an email address.');
    expect(f.api.start).not.toHaveBeenCalled();
    expect(parseContact('pat@example.com')).toEqual({ email: 'pat@example.com' });
    expect(parseContact('+1 (415) 555-0101')).toEqual({ phone: '+1 (415) 555-0101' });
    expect(parseContact('12345')).toBeNull();
    expect(parseContact('pat@')).toBeNull();
    expect(parseContact(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });

  it('a session kept for this tab continues after a page change: it reads the replies from the start and says the visitor\'s earlier messages are not shown here', async () => {
    const store = new Map([[`realty-chat:${KEY}`, JSON.stringify({ token: TOKEN })]]);
    const f = fakeApi();
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hello Pat, Ava here.')], cursor: 'c1', open: true } });
    const m = await mount(f.api, store);
    m.$<HTMLButtonElement>('.launch')!.click();
    await m.tick();
    expect(f.api.poll).toHaveBeenCalledWith(TOKEN, null);
    expect(log(m)).toEqual([['team', 'Hello Pat, Ava here.']]);
    expect(m.text()).toContain('Your earlier messages in this chat are not shown after the page changes. The team still has them.');
    expect(f.api.start).not.toHaveBeenCalled();
  });

  it('closing and reopening the panel keeps this page\'s messages and polls on from the cursor', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hi!')], cursor: 'c1', open: true } });
    await m.tick();
    m.$<HTMLButtonElement>('.x')!.click();
    m.$<HTMLButtonElement>('.launch')!.click();
    expect(log(m)).toEqual([
      ['visitor', 'Is 12 Oak St still available?'],
      ['team', 'Hi!'],
    ]);
    expect(m.text()).not.toContain('Your earlier messages');
    await m.tick();
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, 'c1');
  });

  it('Escape or Close closes the panel, stops polling and returns focus to the chat button', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    m.$('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.$('[role=dialog]')).toBeNull();
    expect(m.w.shadow.activeElement).toBe(m.$('.launch'));
    expect(m.$('.launch')!.getAttribute('aria-expanded')).toBe('false');
    // a poll timer that fires after closing asks nothing
    const calls = f.api.poll.mock.calls.length;
    await m.tick();
    expect(f.api.poll.mock.calls.length).toBe(calls);
  });

  it('the embed needs only a well-formed widget key; the API base is the script\'s own origin unless data-api says otherwise', () => {
    const s = document.createElement('script');
    s.src = 'https://app.example.com/widget/chat.js';
    expect(readConfig(s, 'https://harbor.example/')).toBeNull();
    s.dataset.widgetKey = 'wk_preview_0123456789abcdef';
    expect(readConfig(s, 'https://harbor.example/')).toBeNull();
    s.dataset.widgetKey = ` ${KEY} `;
    expect(readConfig(s, 'https://harbor.example/')).toEqual({ widgetKey: KEY, apiBase: 'https://app.example.com/api' });
    s.dataset.api = 'https://api.example.com/api/';
    expect(readConfig(s, 'https://harbor.example/')).toEqual({ widgetKey: KEY, apiBase: 'https://api.example.com/api' });
    s.dataset.api = '/api';
    expect(readConfig(s, 'https://harbor.example/listings')).toEqual({ widgetKey: KEY, apiBase: 'https://harbor.example/api' });
    expect(readConfig(null, 'https://harbor.example/')).toBeNull();
  });
});
