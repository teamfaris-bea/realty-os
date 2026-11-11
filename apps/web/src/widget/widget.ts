// The website chat widget (module 37, PHASE2_3_PLAN §5.4; R-INBOX-5 is module 22's server side).
//
// What a visitor sees, in order: a "Chat with {brokerage}" button; then the brokerage name, the team's stored
// disclosure and "The first reply may come from the team's assistant." BEFORE they can write; then a short
// form (name, phone or email, message). Start sends exactly the §5.4 body with the disclosure id. After that
// the panel shows the session's own messages as the server returns them (poll), and a reply box.
//
// Genuineness: there is no typing indicator, no "online" or "available" presence, no read receipts and no
// reply-time promise, because the server tells us none of them. A message appears only once the server has
// it; "Sending…" is only this browser's own request in flight. Nothing promises to text or email the visitor.
// D2: no Messenger or Instagram anywhere.
//
// Separate bundle: imports nothing outside src/widget (lint: realty/isolated-bundle), no framework, so the
// production build stays far under its 30 kB gzip budget (size.test.ts).
import type { ChatApi, ChatMessage } from './api.js';
import type { WidgetConfig } from './config.js';
import { ASSISTANT_LINE, copy } from './copy.js';
import { CSS } from './styles.js';

export interface WidgetDeps {
  api: ChatApi;
  /** per-tab storage for the session token (sessionStorage in the page; absent when the browser refuses it) */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** poll interval in ms (default 3000), and after a failed poll (default 15000) */
  pollMs?: number;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

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
  if (s.includes('@')) return EMAIL.test(s) && s.length <= 320 ? { email: s } : null;
  return s.replace(/\D/g, '').length >= 7 && s.length <= 40 ? { phone: s } : null;
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

export class ChatWidget {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLDivElement;
  private launcher: HTMLButtonElement;
  private panel: HTMLDivElement | null = null;
  private token: string | null = null;
  private cursor: string | null = null;
  private seen = new Set<string>();
  private log: HTMLOListElement | null = null;
  private timer: unknown = null;
  private ended = false;
  private readonly key: string;

  constructor(
    private readonly cfg: WidgetConfig,
    private readonly deps: WidgetDeps,
  ) {
    this.key = `realty-chat:${cfg.widgetKey}`;
    this.host = h('div', { 'data-realty-chat': '' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.append(h('style', {}, CSS));
    this.wrap = h('div', { class: 'w' });
    this.launcher = h('button', { type: 'button', class: 'launch', 'aria-expanded': 'false', 'aria-controls': 'rw-panel' }, copy.launcher(cfg.brokerage));
    this.launcher.addEventListener('click', () => this.open());
    this.wrap.append(this.launcher);
    this.root.append(this.wrap);
    try {
      const s = this.deps.storage?.getItem(this.key);
      const saved = s ? (JSON.parse(s) as Saved) : null;
      if (saved && typeof saved.token === 'string') this.token = saved.token;
    } catch {
      this.token = null;
    }
  }

  /** The shadow root (tests and Playwright read it; it is open). */
  get shadow(): ShadowRoot {
    return this.root;
  }

  open(): void {
    if (this.panel) return;
    this.launcher.hidden = true;
    this.launcher.setAttribute('aria-expanded', 'true');
    const title = h('h2', { id: 'rw-title' }, this.cfg.brokerage);
    const close = h('button', { type: 'button', class: 'x' }, copy.close);
    close.addEventListener('click', () => this.close());
    this.panel = h('div', { class: 'panel', id: 'rw-panel', role: 'dialog', 'aria-labelledby': 'rw-title' }, h('div', { class: 'head' }, title, close));
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.wrap.append(this.panel);
    if (this.token) this.showChat([]);
    else this.showStart();
  }

  close(): void {
    this.stopPolling();
    this.panel?.remove();
    this.panel = null;
    this.log = null;
    this.launcher.hidden = false;
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.focus();
  }

  /** The disclosure and the assistant line, shown before the visitor can write anything. */
  private disclosure(): Node[] {
    return [h('p', { class: 'disc', 'data-disclosure': this.cfg.disclosureId }, this.cfg.disclosure), h('p', { class: 'ai' }, ASSISTANT_LINE)];
  }

  private body(...kids: Node[]): HTMLDivElement {
    const b = h('div', { class: 'body' }, ...kids);
    this.panel?.querySelector('.body')?.remove();
    this.panel?.querySelector('.foot')?.remove();
    this.panel?.append(b);
    return b;
  }

  private showStart(error: string | null = null): void {
    const name = h('input', { name: 'name', autocomplete: 'name', maxlength: '120', required: true });
    const contact = h('input', { name: 'contact', autocomplete: 'email', inputmode: 'email', maxlength: '320', required: true, 'aria-describedby': 'rw-hint' });
    const msg = h('textarea', { name: 'message', maxlength: '2000', required: true });
    const err = h('p', { class: 'err', role: 'alert', id: 'rw-err' }, error ?? '');
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
    this.body(h('p', { class: 'note' }, copy.intro), ...this.disclosure(), form);
    name.focus();
  }

  private async start(name: string, contact: string, message: string, go: HTMLButtonElement, err: HTMLElement): Promise<void> {
    const n = name.trim();
    const c = parseContact(contact);
    const m = message.trim();
    const need = !n ? copy.need.name : !c ? copy.need.contact : !m ? copy.need.message : null;
    if (need) {
      err.textContent = need;
      return;
    }
    if (busy(go)) return;
    setBusy(go, copy.starting);
    err.textContent = '';
    const r = await this.deps.api.start(this.cfg.widgetKey, { name: n.slice(0, 120), ...c!, message: m.slice(0, 2000), disclosureId: this.cfg.disclosureId });
    if (!this.panel) return;
    if (!r.ok) {
      setBusy(go, null, copy.start);
      err.textContent = copy.failure[r.failure];
      return;
    }
    this.token = r.data.token;
    this.cursor = r.data.cursor;
    this.ended = false;
    this.save();
    this.showChat(r.data.messages);
  }

  private showChat(initial: ChatMessage[]): void {
    this.seen.clear();
    this.log = h('ol', { class: 'log' });
    this.body(...this.disclosure(), h('div', { role: 'log', 'aria-label': copy.log, 'aria-live': 'polite' }, this.log), h('p', { class: 'note' }, copy.openNote));
    this.add(initial);
    this.footer();
    // a restored session starts from the beginning of its own messages
    if (initial.length === 0) this.cursor = null;
    this.schedule(0);
  }

  private footer(error: string | null = null): void {
    const old = this.panel?.querySelector('.foot');
    // a visitor typing in the reply box keeps the keyboard in the footer when it changes (the chat ended)
    const hadFocus = !!old && old.contains(this.root.activeElement);
    old?.remove();
    if (!this.panel) return;
    if (this.ended) {
      const again = h('button', { type: 'button', class: 'go' }, copy.newChat);
      again.addEventListener('click', () => {
        this.forget();
        this.showStart();
      });
      this.panel.append(h('div', { class: 'foot' }, h('p', { class: 'note', role: 'status' }, copy.ended), again));
      if (hadFocus) again.focus();
      return;
    }
    const field = h('textarea', { name: 'reply', maxlength: '2000', 'aria-label': copy.replyField, rows: '1' });
    const go = h('button', { type: 'submit', class: 'go' }, copy.send);
    const err = h('p', { class: 'err', role: 'alert' }, error ?? '');
    const form = h('form', { 'aria-label': copy.replyField }, err, h('div', { class: 'row' }, field, go));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send(field, go, err);
    });
    this.panel.append(h('div', { class: 'foot' }, form));
  }

  private async send(field: HTMLTextAreaElement, go: HTMLButtonElement, err: HTMLElement): Promise<void> {
    const text = field.value.trim();
    if (!text || !this.token || busy(go)) return;
    setBusy(go, copy.sending);
    err.textContent = '';
    const r = await this.deps.api.send(this.token, text.slice(0, 2000));
    setBusy(go, null, copy.send);
    if (r.ok) {
      field.value = '';
      this.add([r.data.message]);
      return;
    }
    if (r.failure === 'ended') return this.end();
    err.textContent = copy.failure[r.failure];
  }

  /** Render messages the server returned, once each, in the order given. */
  private add(ms: ChatMessage[]): void {
    if (!this.log) return;
    for (const m of ms) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      const mine = m.from === 'visitor';
      this.log.append(
        h('li', { class: `m ${mine ? 'v' : 't'}`, 'data-message-id': m.id }, h('p', { class: 'b' }, m.body), h('span', { class: 'meta' }, `${mine ? copy.you : this.cfg.brokerage} · ${timeOf(m.at)}`)),
      );
    }
    this.log.lastElementChild?.scrollIntoView?.({ block: 'end' });
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

  /** One poll: the session's own messages after the cursor (R-INBOX-5). Stops when the panel closes or the session ends. */
  async poll(): Promise<void> {
    this.timer = null;
    if (!this.token || !this.panel || this.ended) return;
    const r = await this.deps.api.poll(this.token, this.cursor);
    if (!this.panel) return;
    if (!r.ok) {
      if (r.failure === 'ended') return this.end();
      this.schedule(this.deps.retryMs ?? 15_000);
      return;
    }
    this.add(r.data.messages);
    if (r.data.cursor !== null) this.cursor = r.data.cursor;
    if (r.data.ended) return this.end();
    this.schedule(this.deps.pollMs ?? 3_000);
  }

  private end(): void {
    this.ended = true;
    this.stopPolling();
    this.footer();
  }

  private save(): void {
    try {
      if (this.token) this.deps.storage?.setItem(this.key, JSON.stringify({ token: this.token } satisfies Saved));
    } catch {
      /* storage refused: the chat still works for this page */
    }
  }

  private forget(): void {
    this.token = null;
    this.cursor = null;
    this.ended = false;
    try {
      this.deps.storage?.removeItem(this.key);
    } catch {
      /* nothing stored */
    }
  }
}

