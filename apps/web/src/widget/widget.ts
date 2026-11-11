// The website chat widget (module 37, PHASE2_3_PLAN §5.4; R-INBOX-5 is module 22's server side).
//
// What a visitor sees, in order: a "Chat with {team}" button, shown only once the server confirmed there is a chat to
// offer (GET /public/chat/:widgetKey: the widget is connected, allowed on this website and has a notice); then the team
// name, the team's notice and the server's sentence that replies may come from the team's automated assistant, BEFORE
// they can write; then a short form (name, phone or email, message). Start sends the id of the notice they saw. If
// the team changed it meanwhile (WEBCHAT_DISCLOSURE_STALE) the widget shows the new notice in place, keeps what was
// typed and asks them to tap Start chat again. After that the panel shows the visitor's own messages once the server
// accepted each, and the replies the poll returns, each signed by who sent it: the team, or "{team}'s automated
// assistant" (it never passes as a person).
//
// Genuineness: there is no typing indicator, no "online" or "available" presence, no read receipts and no
// reply-time promise, because the server tells us none of them. A message appears only once the server has
// it; "Sending…" is only this browser's own request in flight. Nothing promises to text or email the visitor.
// D2: no Messenger or Instagram anywhere.
//
// Privacy: the browser keeps only the session token (per tab), never anything the visitor typed. A chat continued
// after a page change therefore shows the replies (the poll returns them all) and says the visitor's earlier
// messages are not shown here. Once the chat ended the tab forgets the token, so the next page view (or the next
// person at a shared computer) starts fresh, and the server returns nothing for an ended session anyway.
//
// Staying in the chat (E77, findings F2 / UXA-1): the server counts a visitor as gone after 30 minutes without a
// poll or a message from them, so the widget polls for as long as it holds a session and the page is open: every 3 s
// while the panel is open and the page in view, once a minute otherwise (panel closed, another page of the site, a
// tab in the background). Replies that arrive while the panel is closed are counted on the chat button, in words.
//
// On a phone the panel covers the whole page, so it is modal there (WCAG 2.4.11, finding UXA-2): aria-modal, Tab and
// Shift+Tab wrap inside it, and the page behind it is inert until it closes. On a wide screen it floats beside the
// page, which stays usable.
//
// Separate bundle: imports nothing outside src/widget (lint: realty/isolated-bundle), no framework, so the
// production build stays far under its 30 kB gzip budget (size.test.ts).
import { type ChatApi, EMAIL_MAX, MESSAGE_MAX, NAME_MAX, PHONE_MAX, type WidgetConfig, clean, newMessageId } from './api.js';
import type { EmbedConfig } from './config.js';
import { ASSISTANT_LINE, copy } from './copy.js';
import { CSS, FULL_SCREEN_MEDIA } from './styles.js';

export interface WidgetDeps {
  api: ChatApi;
  /** per-tab storage for the session token (sessionStorage in the page; absent when the browser refuses it) */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** poll interval in ms while the panel is open and the page in view (default 3000), and after a failed poll (default 15000) */
  pollMs?: number;
  retryMs?: number;
  /** poll interval while the visitor is not looking at the chat (default 60000): it keeps the session open (E77) */
  idleMs?: number;
  /** the page is in view (default: document.visibilityState) */
  visible?: () => boolean;
  /** the panel takes the whole screen, so it is modal (default: the FULL_SCREEN_MEDIA query) */
  fullScreen?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** the time a visitor's own message was accepted (tests) */
  now?: () => Date;
}

/** What the full-screen panel covers and may take focus: everything the browser would Tab to inside it. */
const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';
/** Elements of the page that never need to be made inert (they are not shown). */
const NOT_SHOWN = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT']);

type Attrs = Record<string, string | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** "Phone or email": an @ makes it an email; otherwise at least 7 digits make it a phone. */
export function parseContact(v: string): { email: string } | { phone: string } | null {
  const s = v.trim();
  if (s.includes('@')) return EMAIL.test(s) && s.length <= EMAIL_MAX ? { email: s } : null;
  return s.replace(/\D/g, '').length >= 7 && s.length <= PHONE_MAX ? { phone: s } : null;
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// A button in flight stays focusable (a disabled button drops the keyboard focus to the page): aria-disabled
// says it is busy and a second tap does nothing.
const busy = (b: HTMLButtonElement) => b.getAttribute('aria-disabled') === 'true';
function setBusy(b: HTMLButtonElement, label: string | null, idle = ''): void {
  if (label === null) {
    b.removeAttribute('aria-disabled');
    b.textContent = idle;
  } else {
    b.setAttribute('aria-disabled', 'true');
    b.textContent = label;
  }
}

interface Saved {
  token: string;
}

/** One message in the panel: the visitor's own (accepted by the server) or a reply the poll returned. */
interface Item {
  id: string;
  from: 'visitor' | 'team' | 'assistant';
  body: string;
  at: string;
}

export class ChatWidget {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLDivElement;
  private launcher: HTMLButtonElement | null = null;
  private panel: HTMLDivElement | null = null;
  private title: HTMLHeadingElement | null = null;
  private notice: { disc: HTMLParagraphElement; ai: HTMLParagraphElement } | null = null;
  private config: WidgetConfig | null = null;
  private token: string | null = null;
  /** the session came from storage (a page change): the visitor's earlier messages are not here */
  private restored = false;
  private cursor: string | null = null;
  /** this page's messages of the session, so closing and reopening the panel loses none */
  private items: Item[] = [];
  private seen = new Set<string>();
  private log: HTMLOListElement | null = null;
  private timer: unknown = null;
  private ended: 'closed' | 'unavailable' | null = null;
  /** the reply being sent: sending the same text again reuses its clientMessageId (the server stores it once) */
  private pending: { text: string; id: string } | null = null;
  /** a reply the visitor could not send because the chat ended, carried into a new chat */
  private carry = '';
  /** replies that arrived while the panel was closed (the chat button says how many) */
  private unread = 0;
  /** false until the first poll of a session kept from another page: the replies it returns are not new to the visitor */
  private baseline = true;
  /** a polite live region beside the chat button (new replies) and one inside the panel (the chat ended) */
  private announce: HTMLParagraphElement;
  private status: HTMLParagraphElement | null = null;
  /** "Replies appear here while this page is open." while the chat can still get replies */
  private openNote: HTMLParagraphElement | null = null;
  /** the page's elements this widget made inert while its full-screen panel is open */
  private inerted: Element[] | null = null;
  private mode: MediaQueryList | null = null;
  private readonly key: string;

  constructor(
    private readonly cfg: EmbedConfig,
    private readonly deps: WidgetDeps,
  ) {
    this.key = `realty-chat:${cfg.widgetKey}`;
    this.host = h('div', { 'data-realty-chat': '' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.append(h('style', {}, CSS));
    this.wrap = h('div', { class: 'w' });
    this.announce = h('p', { class: 'sr', role: 'status' });
    this.root.append(this.wrap);
    try {
      const s = this.deps.storage?.getItem(this.key);
      const saved = s ? (JSON.parse(s) as Saved) : null;
      if (saved && typeof saved.token === 'string') {
        this.token = saved.token;
        this.restored = true;
        this.baseline = false;
      }
    } catch {
      this.token = null;
    }
  }

  /** The shadow root (tests and Playwright read it; it is open). */
  get shadow(): ShadowRoot {
    return this.root;
  }

  /**
   * Asks the server for the team name and the notice (GET /public/chat/:widgetKey). True once there is a chat to
   * offer, and the chat button is shown; false (nothing is shown) when the widget is unknown, not allowed on this
   * website, turned off, has no notice, or could not be reached.
   */
  async load(): Promise<boolean> {
    const r = await this.deps.api.config(this.cfg.widgetKey);
    if (!r.ok || r.data.disclosure === null) return false;
    this.config = r.data;
    const launcher = h('button', { type: 'button', class: 'launch', 'aria-expanded': 'false', 'aria-controls': 'rw-panel' }, copy.launcher(r.data.teamName));
    launcher.addEventListener('click', () => this.open());
    this.launcher?.remove();
    this.launcher = launcher;
    this.wrap.prepend(launcher);
    if (!this.announce.isConnected) this.wrap.append(this.announce);
    // a session kept from another page of the site: the visitor is still here (E77), and the chat may have ended
    if (this.token && !this.ended && this.timer === null) this.schedule(0);
    return true;
  }

  open(): void {
    if (this.panel || !this.config || !this.launcher) return;
    this.launcher.hidden = true;
    this.launcher.setAttribute('aria-expanded', 'true');
    this.unread = 0;
    this.labelLauncher();
    this.title = h('h2', { id: 'rw-title' }, this.config.teamName);
    const close = h('button', { type: 'button', class: 'x' }, copy.close);
    close.addEventListener('click', () => this.close());
    // in the panel from the start, so what is said in it later (the chat ended) is announced
    this.status = h('p', { class: 'sr', role: 'status' });
    this.panel = h('div', { class: 'panel', id: 'rw-panel', role: 'dialog', 'aria-labelledby': 'rw-title' }, h('div', { class: 'head' }, this.title, close), this.status);
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      else this.wrapTab(e);
    });
    this.wrap.append(this.panel);
    this.applyMode();
    if (!this.deps.fullScreen && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mode = window.matchMedia(FULL_SCREEN_MEDIA);
      this.mode.addEventListener?.('change', this.applyMode);
    }
    if (this.token) this.showChat();
    else this.showStart();
  }

  close(): void {
    this.mode?.removeEventListener?.('change', this.applyMode);
    this.mode = null;
    this.inertPage(false);
    this.panel?.remove();
    this.panel = null;
    this.log = null;
    this.notice = null;
    this.status = null;
    this.openNote = null;
    if (this.launcher) {
      this.launcher.hidden = false;
      this.launcher.setAttribute('aria-expanded', 'false');
      this.launcher.focus();
    }
    // the chat goes on behind the button, at the idle pace (E77: closing the panel is not leaving the page)
    if (this.token && !this.ended && this.timer !== null) this.schedule(this.nextPollMs());
  }

  /** The visitor came back to the tab: an open chat looks for replies at once. */
  wake(): void {
    if (this.token && !this.ended && this.panel) this.schedule(0);
  }

  /** On a phone the panel covers the page: modal, with the page behind it inert. Floating beside it: neither. */
  private applyMode = (): void => {
    if (!this.panel) return;
    const full = this.deps.fullScreen ? this.deps.fullScreen() : (this.mode ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(FULL_SCREEN_MEDIA) : null))?.matches === true;
    if (full) this.panel.setAttribute('aria-modal', 'true');
    else this.panel.removeAttribute('aria-modal');
    this.inertPage(full);
  };

  /** Every element of the page beside the widget's way up to <body> (what the full-screen panel covers). */
  private inertPage(on: boolean): void {
    if (!on) {
      for (const el of this.inerted ?? []) el.removeAttribute('inert');
      this.inerted = null;
      return;
    }
    if (this.inerted) return;
    const out: Element[] = [];
    for (let node: Element = this.host; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        // what the site made inert itself stays its own business
        if (sib !== node && !NOT_SHOWN.has(sib.tagName) && !sib.hasAttribute('inert')) out.push(sib);
      }
    }
    for (const el of out) el.setAttribute('inert', '');
    this.inerted = out;
  }

  /** In the modal panel, Tab from the last control goes to the first and Shift+Tab from the first to the last. */
  private wrapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !this.panel || this.panel.getAttribute('aria-modal') !== 'true') return;
    const controls = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((c) => !c.hasAttribute('disabled') && !c.closest('[hidden]'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    const active = this.root.activeElement;
    const inside = active !== null && this.panel.contains(active);
    if (!inside || active === (e.shiftKey ? first : last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  private labelLauncher(): void {
    const team = this.config?.teamName ?? '';
    if (this.launcher) this.launcher.textContent = this.unread > 0 ? copy.launcherNew(team, this.unread) : copy.launcher(team);
    this.announce.textContent = this.unread > 0 ? copy.newReplies(team, this.unread) : '';
  }

  /** The team's notice and the assistant sentence, shown before the visitor can write anything. */
  private noticeNodes(): Node[] {
    const c = this.config!;
    const disc = h('p', { class: 'disc', 'data-disclosure': c.disclosure?.id ?? '' }, c.disclosure?.text ?? '');
    const ai = h('p', { class: 'ai' }, c.assistantNotice.trim() || ASSISTANT_LINE);
    this.notice = { disc, ai };
    return [disc, ai];
  }

  private body(...kids: Node[]): HTMLDivElement {
    const b = h('div', { class: 'body' }, ...kids);
    this.panel?.querySelector('.body')?.remove();
    this.panel?.querySelector('.foot')?.remove();
    this.panel?.append(b);
    return b;
  }

  private showStart(): void {
    const name = h('input', { name: 'name', autocomplete: 'name', maxlength: String(NAME_MAX), required: true });
    const contact = h('input', { name: 'contact', autocomplete: 'email', inputmode: 'email', maxlength: String(EMAIL_MAX), required: true, 'aria-describedby': 'rw-hint' });
    const msg = h('textarea', { name: 'message', maxlength: String(MESSAGE_MAX), required: true });
    msg.value = this.carry;
    this.carry = '';
    const err = h('p', { class: 'err', role: 'alert', id: 'rw-err' });
    const go = h('button', { type: 'submit', class: 'go' }, copy.start);
    const form = h(
      'form',
      { 'aria-label': copy.start, novalidate: true },
      h('label', {}, copy.name, name),
      h('label', {}, copy.contact, contact, h('span', { class: 'hint', id: 'rw-hint' }, copy.contactHint)),
      h('label', {}, copy.message, msg),
      err,
      go,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.start(name.value, contact.value, msg.value, go, err);
    });
    this.body(h('p', { class: 'note' }, copy.intro), ...this.noticeNodes(), form);
    name.focus();
  }

  private async start(name: string, contact: string, message: string, go: HTMLButtonElement, err: HTMLElement): Promise<void> {
    const n = clean(name, NAME_MAX);
    const c = parseContact(contact);
    const m = clean(message, MESSAGE_MAX, true);
    const need = !n ? copy.need.name : !c ? copy.need.contact : !m ? copy.need.message : null;
    if (need) {
      err.textContent = need;
      return;
    }
    const disclosure = this.config?.disclosure;
    if (busy(go) || !disclosure) return;
    setBusy(go, copy.starting);
    err.textContent = '';
    const r = await this.deps.api.start(this.cfg.widgetKey, { name: n, ...c!, message: m, disclosureId: disclosure.id });
    if (!this.panel) return;
    if (!r.ok) {
      setBusy(go, null, copy.start);
      if (r.failure === 'disclosure_stale') return this.refreshNotice(err);
      err.textContent = r.failure === 'invalid' && r.field ? copy.check[r.field] : r.failure === 'rate_limited' ? copy.tooManyStarts(r.retryAfterSeconds) : copy.failure[r.failure];
      return;
    }
    this.token = r.data.sessionToken;
    this.restored = false;
    this.baseline = true;
    this.cursor = null;
    this.ended = null;
    this.pending = null;
    this.items = [];
    this.save();
    this.showChat({ id: newMessageId(), from: 'visitor', body: m, at: this.now() });
  }

  /** WEBCHAT_DISCLOSURE_STALE: the team's current notice, shown in place; what was typed stays; Start chat again. */
  private async refreshNotice(err: HTMLElement): Promise<void> {
    const r = await this.deps.api.config(this.cfg.widgetKey);
    if (!this.panel) return;
    if (!r.ok || r.data.disclosure === null) {
      err.textContent = copy.failure.unavailable;
      return;
    }
    this.config = r.data;
    if (this.title) this.title.textContent = r.data.teamName;
    if (this.notice) {
      this.notice.disc.textContent = r.data.disclosure.text;
      this.notice.disc.setAttribute('data-disclosure', r.data.disclosure.id);
      this.notice.ai.textContent = r.data.assistantNotice.trim() || ASSISTANT_LINE;
    }
    err.textContent = copy.disclosureChanged;
  }

  private showChat(first: Item | null = null): void {
    this.seen.clear();
    this.log = h('ol', { class: 'log' });
    const restored = this.restored ? [h('p', { class: 'note' }, copy.restoredNote)] : [];
    this.openNote = this.ended ? null : h('p', { class: 'note' }, copy.openNote);
    this.body(...this.noticeNodes(), ...restored, h('div', { role: 'log', 'aria-label': copy.log, 'aria-live': 'polite' }, this.log), ...(this.openNote ? [this.openNote] : []));
    const earlier = this.items;
    this.items = [];
    this.add(first ? [...earlier, first] : earlier);
    this.footer();
    // the keyboard goes where the visitor acts next (the start form it was in is gone): the reply box, or a new chat,
    // or (a chat that can no longer be had) the Close button
    (this.panel?.querySelector<HTMLElement>('.foot textarea, .foot button') ?? this.panel?.querySelector<HTMLElement>('.x'))?.focus();
    if (!this.ended) this.schedule(0);
  }

  private footer(): void {
    const old = this.panel?.querySelector('.foot');
    // a visitor typing in the reply box keeps the keyboard in the footer when it changes (the chat ended)
    const hadFocus = !!old && old.contains(this.root.activeElement);
    old?.remove();
    if (!this.panel) return;
    if (this.ended) {
      const said = h('p', { class: 'note' }, this.ended === 'unavailable' ? copy.turnedOff : copy.ended);
      // a widget turned off (R-INBOX-7) can start no new chat: offering one would end in a refusal after the whole
      // form was filled in again (finding UXA-7)
      if (this.ended === 'unavailable') {
        this.panel.append(h('div', { class: 'foot' }, said));
        if (hadFocus) this.panel.querySelector<HTMLElement>('.x')?.focus();
        return;
      }
      const again = h('button', { type: 'button', class: 'go' }, copy.newChat);
      again.addEventListener('click', () => {
        this.forget();
        this.showStart();
      });
      this.panel.append(h('div', { class: 'foot' }, said, again));
      if (hadFocus) again.focus();
      return;
    }
    const field = h('textarea', { name: 'reply', maxlength: String(MESSAGE_MAX), 'aria-label': copy.replyField, rows: '1' });
    const go = h('button', { type: 'submit', class: 'go' }, copy.send);
    const err = h('p', { class: 'err', role: 'alert' });
    const form = h('form', { 'aria-label': copy.replyField }, err, h('div', { class: 'row' }, field, go));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send(field, go, err);
    });
    this.panel.append(h('div', { class: 'foot' }, form));
  }

  private async send(field: HTMLTextAreaElement, go: HTMLButtonElement, err: HTMLElement): Promise<void> {
    const text = clean(field.value, MESSAGE_MAX, true);
    const token = this.token;
    if (!text || !token || busy(go)) return;
    // one clientMessageId per typed message: the same text sent again (after a failure) is the same message
    const id = this.pending?.text === text ? this.pending.id : newMessageId();
    this.pending = { text, id };
    setBusy(go, copy.sending);
    err.textContent = '';
    const r = await this.deps.api.send(token, text, id);
    setBusy(go, null, copy.send);
    if (token !== this.token) return;
    if (r.ok) {
      this.pending = null;
      field.value = '';
      this.add([{ id, from: 'visitor', body: text, at: this.now() }]);
      return;
    }
    if (r.failure === 'closed' || r.failure === 'not_found' || r.failure === 'unavailable') {
      this.carry = field.value;
      return this.end(r.failure === 'unavailable' ? 'unavailable' : 'closed');
    }
    err.textContent = r.failure === 'invalid' && r.field === 'message' ? copy.check.message : r.failure === 'rate_limited' ? copy.tooManyMessages(r.retryAfterSeconds) : copy.failure[r.failure];
  }

  /** Render messages once each, in the order given (the visitor's own as accepted; replies as the poll returned them). */
  private add(ms: readonly Item[]): void {
    for (const m of ms) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      this.items.push(m);
      if (!this.log) continue;
      const team = this.config?.teamName ?? '';
      const who = m.from === 'visitor' ? copy.you : m.from === 'assistant' ? copy.assistant(team) : team;
      this.log.append(
        h('li', { class: `m ${m.from === 'visitor' ? 'v' : 't'}`, 'data-message-id': m.id, 'data-from': m.from }, h('p', { class: 'b' }, m.body), h('span', { class: 'meta' }, `${who} · ${timeOf(m.at)}`)),
      );
    }
    this.log?.lastElementChild?.scrollIntoView?.({ block: 'end' });
  }

  private schedule(ms: number): void {
    this.stopPolling();
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.timer = set(() => void this.poll(), ms);
  }

  private stopPolling(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** 3 s while the visitor is looking at the open panel; a minute otherwise (enough to keep the session open, E77). */
  private nextPollMs(): number {
    const visible = this.deps.visible ? this.deps.visible() : typeof document === 'undefined' || document.visibilityState !== 'hidden';
    return this.panel && visible ? (this.deps.pollMs ?? 3_000) : (this.deps.idleMs ?? 60_000);
  }

  /**
   * One poll: the replies in this session after the cursor (R-INBOX-5). It runs for as long as the widget holds a
   * session that has not ended, panel open or not: each poll tells the server the visitor is still on the page (E77).
   */
  async poll(): Promise<void> {
    this.timer = null;
    const token = this.token;
    if (!token || this.ended) return;
    const r = await this.deps.api.poll(token, this.cursor);
    if (this.ended || token !== this.token) return;
    if (!r.ok) {
      if (r.failure === 'closed' || r.failure === 'not_found') return this.end('closed');
      if (r.failure === 'unavailable') return this.end('unavailable');
      this.schedule(Math.max(this.deps.retryMs ?? 15_000, this.nextPollMs()));
      return;
    }
    const before = this.items.length;
    this.add(r.data.messages.map((m) => ({ id: m.id, from: m.from, body: m.body, at: m.sentAt })));
    if (!this.panel && this.baseline && this.items.length > before) {
      this.unread += this.items.length - before;
      this.labelLauncher();
    }
    this.baseline = true;
    // passed back unchanged, as the server gave it
    this.cursor = r.data.cursor;
    if (!r.data.open) return this.end('closed');
    this.schedule(this.nextPollMs());
  }

  private end(kind: 'closed' | 'unavailable'): void {
    // a reply the visitor was typing is not lost: it starts the new chat (finding UXA-6)
    const typing = this.panel?.querySelector<HTMLTextAreaElement>('.foot textarea')?.value ?? '';
    if (this.carry === '' && typing.trim() !== '') this.carry = typing;
    this.ended = kind;
    this.pending = null;
    this.stopPolling();
    // the tab forgets the session: a later page view, or the next person at this computer, starts fresh
    this.unsave();
    // a session kept from another page that had already ended when this page asked: nothing to show, start fresh
    if (this.restored && !this.panel && this.items.length === 0) return this.forget();
    this.openNote?.remove();
    this.openNote = null;
    if (this.status) this.status.textContent = kind === 'unavailable' ? copy.turnedOff : copy.ended;
    this.footer();
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private save(): void {
    try {
      if (this.token) this.deps.storage?.setItem(this.key, JSON.stringify({ token: this.token } satisfies Saved));
    } catch {
      /* storage refused: the chat still works for this page */
    }
  }

  private unsave(): void {
    try {
      this.deps.storage?.removeItem(this.key);
    } catch {
      /* nothing stored */
    }
  }

  private forget(): void {
    this.stopPolling();
    this.token = null;
    this.cursor = null;
    this.ended = null;
    this.restored = false;
    this.baseline = true;
    this.pending = null;
    this.items = [];
    this.unread = 0;
    this.labelLauncher();
    if (this.status) this.status.textContent = '';
    this.unsave();
  }
}
