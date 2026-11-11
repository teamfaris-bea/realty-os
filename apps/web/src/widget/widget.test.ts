// The chat widget in jsdom (module 37). It shows the brokerage name, the stored disclosure and "The first reply
// may come from the team's assistant." before the visitor can write; it sends exactly the §5.4 start body; it
// renders only what the server returned, once, in order (R-INBOX-5: the session's own messages); it never shows
// a typing indicator, presence, read receipt or reply-time promise (genuineness); it says plainly when a chat
// ended (E77), when the widget is not available (R-INBOX-7) and when it is rate limited (E137).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatApi, ChatMessage, Result } from './api.js';
import { readConfig } from './config.js';
import { ASSISTANT_LINE } from './copy.js';
import { ChatWidget, parseContact } from './widget.js';

const CFG = { widgetKey: 'wk_test_0123456789abcdef', brokerage: 'Harbor Realty LLC', disclosureId: '01900000-0000-7000-8000-0000000d15c1', disclosure: 'By starting a chat, you agree that Harbor Realty LLC may reply here.', apiBase: 'https://app.example.com/api' };
const TOKEN = 'st_0123456789abcdef0123456789abcdef';
const msg = (id: string, from: 'visitor' | 'team', body: string): ChatMessage => ({ id, from, body, at: '2026-11-11T17:00:00Z' });

/** Words that would claim activity or presence the server never reported. */
const PRESENCE = /typing|is writing|online|offline|available now|active now|\bseen\b|read receipt|replies in|within \d+ (minute|second)|agents? (are|is) (here|available)|messenger|instagram/i;

function fakeApi() {
  const polls: Result<{ messages: ChatMessage[]; cursor: string | null; ended: boolean }>[] = [];
  const api = {
    start: vi.fn<ChatApi['start']>(async (_k, req) => ({ ok: true as const, data: { token: TOKEN, messages: [msg('m1', 'visitor', req.message)], cursor: 'c1' } })),
    send: vi.fn<ChatApi['send']>(async (_t, body) => ({ ok: true as const, data: { message: msg(`s-${body}`, 'visitor', body) } })),
    poll: vi.fn<ChatApi['poll']>(async () => polls.shift() ?? { ok: true as const, data: { messages: [], cursor: null, ended: false } }),
  };
  return { api, polls };
}

function mount(api: ChatApi, storage: Map<string, string> | null = new Map()) {
  const timers: (() => void)[] = [];
  const store = storage && { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const w = new ChatWidget(CFG, { api, storage: store, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
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
  return { w, $, text, tick, timers };
}

async function startChat(m: ReturnType<typeof mount>, message = 'Is 12 Oak St still available?') {
  m.$<HTMLButtonElement>('.launch')!.click();
  m.$<HTMLInputElement>('input[name=name]')!.value = 'Pat Lee';
  m.$<HTMLInputElement>('input[name=contact]')!.value = '(415) 555-0101';
  m.$<HTMLTextAreaElement>('textarea[name=message]')!.value = message;
  m.$<HTMLFormElement>('form')!.requestSubmit();
  await vi.waitFor(() => expect(m.$('ol[role=log]')).not.toBeNull());
}

const logIds = (m: ReturnType<typeof mount>) => [...m.w.shadow.querySelectorAll('[data-message-id]')].map((e) => e.getAttribute('data-message-id'));

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('chat widget (module 37)', () => {
  it('R-INBOX-5: shows the brokerage name, the disclosure and "the first reply may come from the team\'s assistant" before the visitor can write', () => {
    const m = mount(fakeApi().api);
    expect(m.$('.launch')!.textContent).toBe('Chat with Harbor Realty LLC');
    m.$<HTMLButtonElement>('.launch')!.click();
    expect(m.$('[role=dialog] h2')!.textContent).toBe('Harbor Realty LLC');
    const disc = m.$('[data-disclosure]')!;
    expect(disc.textContent).toBe(CFG.disclosure);
    expect(disc.getAttribute('data-disclosure')).toBe(CFG.disclosureId);
    expect(m.text()).toContain(ASSISTANT_LINE);
    expect(ASSISTANT_LINE).toBe("The first reply may come from the team's assistant.");
    // both come before every field in reading order
    const form = m.$('form')!;
    expect(disc.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.text()).not.toMatch(PRESENCE);
  });

  it('start sends exactly the §5.4 body with the disclosure id, and the conversation shows only what the server returned', async () => {
    const f = fakeApi();
    const m = mount(f.api);
    await startChat(m);
    expect(f.api.start).toHaveBeenCalledWith(CFG.widgetKey, { name: 'Pat Lee', phone: '(415) 555-0101', message: 'Is 12 Oak St still available?', disclosureId: CFG.disclosureId });
    expect(logIds(m)).toEqual(['m1']);
    expect(m.$('[data-message-id=m1]')!.textContent).toContain('You');
    // the disclosure and assistant line stay in view for the whole chat
    expect(m.text()).toContain(ASSISTANT_LINE);
    expect(m.text()).toContain('Replies appear here while this page is open.');
  });

  it('genuineness: nothing appears between polls; a team reply appears only once the server returns it, once, and no typing or presence is ever shown', async () => {
    const f = fakeApi();
    const m = mount(f.api);
    await startChat(m);
    expect(m.text()).not.toMatch(PRESENCE);
    // first poll: nothing new; the panel shows exactly the same messages
    await m.tick();
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, 'c1');
    expect(logIds(m)).toEqual(['m1']);
    expect(m.text()).not.toMatch(PRESENCE);
    // the server returns the assistant's first reply (it signs itself; the widget adds nothing)
    f.polls.push({ ok: true, data: { messages: [msg('m2', 'team', 'Hi Pat, this is the Harbor team assistant. Ava will reply shortly.')], cursor: 'c2', ended: false } });
    await m.tick();
    expect(logIds(m)).toEqual(['m1', 'm2']);
    expect(m.$('[data-message-id=m2]')!.textContent).toContain('Harbor Realty LLC');
    // a repeat delivery of the same message is not drawn twice
    f.polls.push({ ok: true, data: { messages: [msg('m2', 'team', 'Hi Pat, this is the Harbor team assistant. Ava will reply shortly.')], cursor: 'c2', ended: false } });
    await m.tick();
    expect(logIds(m)).toEqual(['m1', 'm2']);
    expect(f.api.poll).toHaveBeenLastCalledWith(TOKEN, 'c2');
    expect(m.text()).not.toMatch(PRESENCE);
    expect(m.w.shadow.querySelector('[class*=typing],[class*=presence],[class*=dot]')).toBeNull();
  });

  it('a reply is shown once the server stored it; "Sending…" is only this browser\'s request in flight', async () => {
    const f = fakeApi();
    let release: () => void = () => undefined;
    f.api.send.mockImplementationOnce((_t, body) => new Promise((ok) => (release = () => ok({ ok: true, data: { message: msg('s1', 'visitor', body) } }))));
    const m = mount(f.api);
    await startChat(m);
    const field = m.$<HTMLTextAreaElement>('textarea[name=reply]')!;
    field.value = 'Can I see it Saturday?';
    m.$<HTMLFormElement>('.foot form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('.foot .go')!.textContent).toBe('Sending…'));
    expect(logIds(m)).toEqual(['m1']);
    release();
    await vi.waitFor(() => expect(logIds(m)).toEqual(['m1', 's1']));
    expect(m.$('.foot .go')!.textContent).toBe('Send');
    expect(field.value).toBe('');
    expect(f.api.send).toHaveBeenCalledWith(TOKEN, 'Can I see it Saturday?');
  });

  it('E77: when the session ends the widget says so, stops polling and offers a new chat; nothing is promised by text or email', async () => {
    const f = fakeApi();
    const m = mount(f.api);
    await startChat(m);
    f.polls.push({ ok: true, data: { messages: [], cursor: null, ended: true } });
    await m.tick();
    expect(m.text()).toContain('This chat has ended.');
    expect(m.timers).toHaveLength(0);
    expect(m.$('textarea[name=reply]')).toBeNull();
    expect(m.text()).not.toMatch(/we('ll| will) (text|email|call)|by text|by email/i);
    // a 404/410 on a send ends it too
    const g = fakeApi();
    g.api.send.mockResolvedValueOnce({ ok: false, failure: 'ended' });
    document.body.innerHTML = '';
    const n = mount(g.api);
    await startChat(n);
    n.$<HTMLTextAreaElement>('textarea[name=reply]')!.value = 'hello?';
    n.$<HTMLFormElement>('.foot form')!.requestSubmit();
    await vi.waitFor(() => expect(n.text()).toContain('This chat has ended.'));
    const again = [...n.w.shadow.querySelectorAll('button')].find((b) => b.textContent === 'Start a new chat')!;
    again.click();
    expect(n.$('form[aria-label="Start chat"]')).not.toBeNull();
  });

  it('E137: a rate-limited start says so and keeps what the visitor typed; R-INBOX-7: a disconnected widget says chat is not available', async () => {
    const f = fakeApi();
    f.api.start.mockResolvedValueOnce({ ok: false, failure: 'rate_limited' }).mockResolvedValueOnce({ ok: false, failure: 'unavailable' });
    const m = mount(f.api);
    m.$<HTMLButtonElement>('.launch')!.click();
    m.$<HTMLInputElement>('input[name=name]')!.value = 'Pat';
    m.$<HTMLInputElement>('input[name=contact]')!.value = 'pat@example.com';
    m.$<HTMLTextAreaElement>('textarea[name=message]')!.value = 'Hi';
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('[role=alert]')!.textContent).toBe('Too many messages right now. Please wait a minute and try again.'));
    expect(m.$<HTMLTextAreaElement>('textarea[name=message]')!.value).toBe('Hi');
    m.$<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(m.$('[role=alert]')!.textContent).toBe("Chat isn't available right now. Please try again later."));
    expect(f.api.start).toHaveBeenLastCalledWith(CFG.widgetKey, { name: 'Pat', email: 'pat@example.com', message: 'Hi', disclosureId: CFG.disclosureId });
  });

  it('the form asks for a name, a phone or email, and a message before anything is sent', () => {
    const f = fakeApi();
    const m = mount(f.api);
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
  });

  it('a session kept for this tab continues after a page change: opening reads the session\'s own messages from the start', async () => {
    const store = new Map([[`realty-chat:${CFG.widgetKey}`, JSON.stringify({ token: TOKEN })]]);
    const f = fakeApi();
    f.polls.push({ ok: true, data: { messages: [msg('m1', 'visitor', 'Hi'), msg('m2', 'team', 'Hello Pat, Ava here.')], cursor: 'c2', ended: false } });
    const m = mount(f.api, store);
    m.$<HTMLButtonElement>('.launch')!.click();
    await m.tick();
    expect(f.api.poll).toHaveBeenCalledWith(TOKEN, null);
    expect(logIds(m)).toEqual(['m1', 'm2']);
    expect(f.api.start).not.toHaveBeenCalled();
  });

  it('Escape or Close closes the panel, stops polling and returns focus to the chat button', async () => {
    const f = fakeApi();
    const m = mount(f.api);
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

  it('an embed without its key, brokerage name or disclosure renders nothing (no chat it cannot start honestly)', () => {
    const s = document.createElement('script');
    s.src = 'https://app.example.com/widget/chat.js';
    expect(readConfig(s, 'https://harbor.example/')).toBeNull();
    Object.assign(s.dataset, { widgetKey: 'wk', brokerage: 'Harbor Realty LLC', disclosureId: 'd1' });
    expect(readConfig(s, 'https://harbor.example/')).toBeNull();
    s.dataset.disclosure = 'By starting a chat…';
    expect(readConfig(s, 'https://harbor.example/')).toEqual({ widgetKey: 'wk', brokerage: 'Harbor Realty LLC', disclosureId: 'd1', disclosure: 'By starting a chat…', apiBase: 'https://app.example.com/api' });
    expect(readConfig(null, 'https://harbor.example/')).toBeNull();
  });
});
