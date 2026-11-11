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

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
}

async function mount(api: ChatApi, storage: Map<string, string> | null = new Map(), o: { visible?: () => boolean; fullScreen?: () => boolean } = {}) {
  /** the pending timers, as the page's clock holds them (a cleared one is gone) */
  const timers: Timer[] = [];
  let next = 0;
  const store = storage && { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const w = new ChatWidget(EMBED, {
    api,
    storage: store,
    setTimer: (fn, ms) => {
      next += 1;
      timers.push({ id: next, fn, ms });
      return next;
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => new Date('2026-11-11T17:00:00.000Z'),
    ...o,
  });
  const loaded = await w.load();
  document.body.append(w.host);
  const $ = <T extends Element = HTMLElement>(sel: string) => w.shadow.querySelector<T>(sel);
  const text = () => w.shadow.textContent ?? '';
  /** run the pending poll timer(s), as the clock would */
  const tick = async () => {
    const due = timers.splice(0);
    for (const t of due) t.fn();
    await vi.waitFor(() => undefined);
    await Promise.resolve();
  };
  /** the delays of the pending timers */
  const delays = () => timers.map((t) => t.ms);
  return { w, loaded, $, text, tick, timers, delays };
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
      expect([...m.w.shadow.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Start a new chat');
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
    await vi.waitFor(() => expect(alert()).toBe('Too many chats were started from this connection. Please try again later.'));
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

  it('Escape or Close closes the panel and returns focus to the chat button; the chat stays open behind it at the idle pace (E77: the visitor is still on the page)', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    m.$('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.$('[role=dialog]')).toBeNull();
    expect(m.w.shadow.activeElement).toBe(m.$('.launch'));
    expect(m.$('.launch')!.getAttribute('aria-expanded')).toBe('false');
    // the next poll is a minute away, not three seconds
    expect(m.delays()).toEqual([60_000]);
    const calls = f.api.poll.mock.calls.length;
    await m.tick();
    expect(f.api.poll.mock.calls.length).toBe(calls + 1);
    expect(m.delays()).toEqual([60_000]);
  });

  it('E77 (findings F2, UXA-1): with the panel closed, or after a page change, the widget keeps polling once a minute while it holds a session, so a visitor still on the site keeps the chat open; replies that arrive meanwhile are counted, in words, on the chat button and shown when it opens', async () => {
    const f = fakeApi();
    const m = await mount(f.api);
    await startChat(m);
    await m.tick();
    m.$<HTMLButtonElement>('.x')!.click();
    f.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hi Pat, Ava here.')], cursor: 'c1', open: true } });
    await m.tick();
    expect(m.$('.launch')!.textContent).toBe('Chat with Harbor & Pine Team · 1 new reply');
    expect(m.$('.w > [role=status]')!.textContent).toBe('1 new reply in your chat with Harbor & Pine Team');
    f.polls.push({ ok: true, data: { messages: [reply('r2', 'assistant', 'Saturday works.')], cursor: 'c2', open: true } });
    await m.tick();
    expect(m.$('.launch')!.textContent).toBe('Chat with Harbor & Pine Team · 2 new replies');
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, 'c1');
    m.$<HTMLButtonElement>('.launch')!.click();
    expect(log(m).map(([, b]) => b)).toEqual(['Is 12 Oak St still available?', 'Hi Pat, Ava here.', 'Saturday works.']);
    expect(m.$('.launch')!.textContent).toBe('Chat with Harbor & Pine Team');
    // open again: polls at the chat's own pace, from the cursor
    expect(m.delays()).toEqual([0]);
    await m.tick();
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, 'c2');
    expect(m.delays()).toEqual([3_000]);
    // a page the visitor is not looking at (another tab) polls at the idle pace too
    document.body.innerHTML = '';
    const g = fakeApi();
    let shown = true;
    const n = await mount(g.api, new Map(), { visible: () => shown });
    await startChat(n);
    shown = false;
    await n.tick();
    expect(n.delays()).toEqual([60_000]);
    // a session kept for this tab is polled at once on the next page, panel closed, and its replies so far are not "new"
    document.body.innerHTML = '';
    const store = new Map([[`realty-chat:${KEY}`, JSON.stringify({ token: TOKEN })]]);
    const k = fakeApi();
    k.polls.push({ ok: true, data: { messages: [reply('r1', 'team', 'Hi Pat, Ava here.')], cursor: 'c1', open: true } });
    const p = await mount(k.api, store);
    expect(p.delays()).toEqual([0]);
    await p.tick();
    expect(k.api.poll).toHaveBeenCalledWith(TOKEN, null);
    expect(p.$('[role=dialog]')).toBeNull();
    expect(p.$('.launch')!.textContent).toBe('Chat with Harbor & Pine Team');
    expect(p.delays()).toEqual([60_000]);
  });

  it('E77 (finding chat-ended-session-readable): when the chat ends this tab forgets the session, so a later page view starts a new chat; a kept session that already ended is never shown again', async () => {
    const store = new Map<string, string>();
    const f = fakeApi();
    const m = await mount(f.api, store);
    await startChat(m);
    expect(store.has(`realty-chat:${KEY}`)).toBe(true);
    f.polls.push({ ok: true, data: { messages: [], cursor: null, open: false } });
    await m.tick();
    expect(m.text()).toContain('This chat has ended.');
    expect(store.has(`realty-chat:${KEY}`)).toBe(false);
    // this page still shows the ended chat when the panel is closed and opened again
    m.$<HTMLButtonElement>('.x')!.click();
    m.$<HTMLButtonElement>('.launch')!.click();
    expect(m.text()).toContain('This chat has ended.');
    // the next person in a shared tab: a kept session the server says has ended is forgotten unseen
    for (const ended of [{ ok: true as const, data: { messages: [], cursor: null, open: false } }, { ok: false as const, failure: 'closed' as const }]) {
      document.body.innerHTML = '';
      const kept = new Map([[`realty-chat:${KEY}`, JSON.stringify({ token: TOKEN })]]);
      const g = fakeApi();
      g.polls.push(ended);
      const n = await mount(g.api, kept);
      await n.tick();
      expect(kept.has(`realty-chat:${KEY}`)).toBe(false);
      n.$<HTMLButtonElement>('.launch')!.click();
      expect(n.$('form[aria-label="Start chat"]')).not.toBeNull();
      expect(n.text()).not.toContain('This chat has ended.');
      expect(n.timers).toHaveLength(0);
    }
  });

  it('E77 (finding UXA-6): a reply being typed when a poll ends the chat carries into the new chat; the ended chat no longer says replies appear here; the end is said in a live region that was already in the panel', async () => {
    for (const ending of [{ ok: true as const, data: { messages: [], cursor: null, open: false } }, { ok: false as const, failure: 'closed' as const }, { ok: false as const, failure: 'not_found' as const }]) {
      document.body.innerHTML = '';
      const f = fakeApi();
      const m = await mount(f.api);
      await startChat(m);
      const live = m.$('[role=dialog] > [role=status]')!;
      expect(live.textContent).toBe('');
      m.$<HTMLTextAreaElement>('textarea[name=reply]')!.value = 'I can come by at 3pm today';
      f.polls.push(ending);
      await m.tick();
      expect(live.isConnected).toBe(true);
      expect(live.textContent).toBe('This chat has ended.');
      expect(m.text()).not.toContain('Replies appear here while this page is open.');
      [...m.w.shadow.querySelectorAll('button')].find((b) => b.textContent === 'Start a new chat')!.click();
      expect(m.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('I can come by at 3pm today');
    }
  });

  it('R-INBOX-7 (finding UXA-7): a widget turned off during the chat offers no new chat, which could never start; the keyboard stays in the panel', async () => {
    const f = fakeApi();
    f.polls.push({ ok: false, failure: 'unavailable' });
    const m = await mount(f.api);
    await startChat(m);
    m.$<HTMLTextAreaElement>('textarea[name=reply]')!.focus();
    await m.tick();
    expect(m.text()).toContain("This chat isn't available any more.");
    expect([...m.w.shadow.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Start a new chat');
    expect(m.w.shadow.activeElement).toBe(m.$('.x'));
    expect(m.timers).toHaveLength(0);
  });

  it('E137 (finding UXA-10): a refused start says too many chats were started from this connection and how long to wait, from the server\'s retryAfterSeconds; a refused message says how long too', async () => {
    const f = fakeApi();
    f.api.start.mockResolvedValueOnce({ ok: false, failure: 'rate_limited', retryAfterSeconds: 1721 }).mockResolvedValueOnce({ ok: false, failure: 'rate_limited', retryAfterSeconds: 41 });
    const m = await mount(f.api);
    m.$<HTMLButtonElement>('.launch')!.click();
    fill(m, { message: 'Hi' });
    const alert = () => m.$('[role=alert]')!.textContent;
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(alert()).toBe('Too many chats were started from this connection. Please try again in about 29 minutes.'));
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(alert()).toBe('Too many chats were started from this connection. Please try again in a minute.'));
    expect(m.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('Hi');
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('[role=log]')).not.toBeNull());
    f.api.send.mockResolvedValueOnce({ ok: false, failure: 'rate_limited', retryAfterSeconds: 30 });
    await sendReply(m, 'Hello?');
    expect(m.$('.foot [role=alert]')!.textContent).toBe('Too many messages right now. Please try again in a minute.');
  });

  it('WCAG 2.4.11 (finding UXA-2): on a phone the full-screen panel is modal: aria-modal, Tab and Shift+Tab wrap inside it and the page behind is inert until it closes; on a wide screen the floating panel stays non-modal', async () => {
    const page = document.createElement('main');
    page.innerHTML = '<a href="/listings">See our listings</a><a href="/contact">Contact the office</a>';
    const already = document.createElement('div');
    already.setAttribute('inert', '');
    document.body.append(page, already);
    const f = fakeApi();
    const m = await mount(f.api, new Map(), { fullScreen: () => true });
    m.$<HTMLButtonElement>('.launch')!.click();
    const panel = m.$('[role=dialog]')!;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(page.hasAttribute('inert')).toBe(true);
    expect(m.w.host.hasAttribute('inert')).toBe(false);
    const controls = [...panel.querySelectorAll<HTMLElement>('button, input, textarea')];
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const tab = (shiftKey: boolean) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      (m.w.shadow.activeElement ?? panel).dispatchEvent(e);
      return e.defaultPrevented;
    };
    first.focus();
    expect(tab(true)).toBe(true);
    expect(m.w.shadow.activeElement).toBe(last);
    expect(tab(false)).toBe(true);
    expect(m.w.shadow.activeElement).toBe(first);
    // in the middle, the browser moves focus as usual
    controls[1]!.focus();
    expect(tab(false)).toBe(false);
    m.$<HTMLButtonElement>('.x')!.click();
    expect(page.hasAttribute('inert')).toBe(false);
    // what the site itself had made inert stays inert
    expect(already.hasAttribute('inert')).toBe(true);
    // a wide screen: a floating panel, the page stays usable
    document.body.innerHTML = '';
    document.body.append(page);
    const n = await mount(fakeApi().api, new Map(), { fullScreen: () => false });
    n.$<HTMLButtonElement>('.launch')!.click();
    expect(n.$('[role=dialog]')!.hasAttribute('aria-modal')).toBe(false);
    expect(page.hasAttribute('inert')).toBe(false);
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
