// The chat widget's typed client for module 22's public web-chat routes (apps/api/src/channels/routes.ts):
//
//   GET  /public/chat/:widgetKey                  → {teamName, disclosure: {id, text} | null, assistantNotice}
//   POST /public/chat/:widgetKey/start            {name, phone | email, message, disclosureId} → {sessionToken, status: 'open'}
//   POST /public/chat/session/:token/messages     {message, clientMessageId} → {accepted: true}
//   GET  /public/chat/session/:token/poll?after=  → {messages: [{id, body, sentAt, from: 'team' | 'assistant'}], cursor, open}
//
// The shapes are the API's own: api.contract.test.ts checks every request this client sends and every response it
// reads against the JSON Schemas the API generates from its Zod definitions (apps/api/src/channels/webContract.json).
// Errors, which widget.ts says in plain words: 404 (an unknown or rotated key, a website the widget may not run on,
// an unknown session), 409 CHANNEL_NOT_CONNECTED (the team turned the widget off, R-INBOX-7), 409
// WEBCHAT_DISCLOSURE_STALE (the notice changed after the visitor saw it), 410 WEBCHAT_SESSION_CLOSED (the chat ended,
// E77), 429 (rate limits per widget, IP and session, E137; the wait is in error.details.retryAfterSeconds), 422 / 413
// (refused as invalid).
//
// The visitor is not a principal (R-TEN-12): no cookie is ever sent. The poll returns only the team's and the
// assistant's replies in the visitor's own session (R-INBOX-5); the visitor's own messages are the ones this browser
// sent and the server accepted. Every text is first made to fit the API's checks (no control or format characters
// except a message's newlines and tabs; the length caps), so a message is never refused for a character the visitor
// could not see.
//
// This file is part of the separate widget bundle: it imports nothing outside src/widget (lint: realty/isolated-bundle).

export interface WidgetConfig {
  teamName: string;
  /** the notice the visitor must see before writing; null: the team has none, so no chat can start */
  disclosure: { id: string; text: string } | null;
  /** the server's sentence saying replies may come from the team's automated assistant */
  assistantNotice: string;
}

export interface StartRequest {
  name: string;
  phone?: string;
  email?: string;
  message: string;
  disclosureId: string;
}

export interface StartResponse {
  sessionToken: string;
  status: 'open';
}

/** One reply in the visitor's own session, as the server delivered it. */
export interface ChatReply {
  id: string;
  body: string;
  sentAt: string;
  /** a person on the team, or the team's automated assistant (which never passes as a person) */
  from: 'team' | 'assistant';
}

export interface PollResponse {
  messages: ChatReply[];
  /** passed back unchanged as `after` */
  cursor: string | null;
  /** false: the chat ended (E77) */
  open: boolean;
}

export type ApiFailure =
  /** 429 */
  | 'rate_limited'
  /** 404: an unknown or rotated key, a website not on the widget's list, an unknown session */
  | 'not_found'
  /** 409 CHANNEL_NOT_CONNECTED: the widget is turned off */
  | 'unavailable'
  /** 409 WEBCHAT_DISCLOSURE_STALE: the notice changed since the widget showed it */
  | 'disclosure_stale'
  /** 410 WEBCHAT_SESSION_CLOSED: the chat ended */
  | 'closed'
  /** 422 / 413: refused as invalid */
  | 'invalid'
  /** anything else: network, 5xx, a response that is not the API's shape */
  | 'failed';

/** For 'invalid': the field the server named, when it named one. */
export type Field = 'name' | 'contact' | 'message';

/**
 * `retryAfterSeconds`: for 'rate_limited', the wait the API names (error.details.retryAfterSeconds; up to an hour for
 * the 20-starts-an-hour limit). The Retry-After header is not readable across origins, the body is.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure; field?: Field; retryAfterSeconds?: number };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The API's caps (contract webChat.nameMax / messageMax, StartBody's phone and email). */
export const NAME_MAX = 120;
export const MESSAGE_MAX = 2000;
export const PHONE_MAX = 40;
export const EMAIL_MAX = 254;
/** Widget keys are `wk_` + 40 hex (contract webChat.widgetKey); the API never looks up any other shape. */
export const WIDGET_KEY = /^wk_[0-9a-f]{40}$/;

const FORMAT = /\p{Cf}/u;
const SYMBOL = /\p{So}/u;
const ZWJ = '‍';

/** What may sit between an emoji and its joiner: the two presentation selectors and the five skin tones. */
function isEmojiTail(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

/**
 * Whether the zero-width joiner at `i` joins two emoji (a family, a profession, a rainbow flag), where it is part of
 * the emoji. This is the API's rule (contract webChat message pattern): U+200D only right after an emoji (its tail
 * aside) and right before another one. Written as a loop, not a lookbehind, so older Safari can still parse the bundle.
 */
function joinsEmoji(ch: readonly string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && isEmojiTail(ch[j]!)) j--;
  return j >= 0 && SYMBOL.test(ch[j]!) && i + 1 < ch.length && SYMBOL.test(ch[i + 1]!);
}

/** Format characters dropped; a message keeps the joiners inside its emoji. */
function dropFormat(s: string, keepEmojiJoiners: boolean): string {
  if (!keepEmojiJoiners) return s.replace(/\p{Cf}/gu, '');
  const ch = Array.from(s);
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i]!;
    if (!FORMAT.test(c) || (c === ZWJ && joinsEmoji(ch, i))) out += c;
  }
  return out;
}

/**
 * Text as the API accepts it: format characters dropped (a message keeps the joiners inside its emoji, so a family
 * stays one emoji), control characters a space (a message keeps its newlines and tabs), trimmed and capped at `max`
 * UTF-16 units without splitting a character in two or leaving a joiner whose second emoji was cut off.
 */
export function clean(s: string, max: number, multiline = false): string {
  const kept = dropFormat(s, multiline).replace(/\p{Cc}/gu, (c) => (multiline && (c === '\n' || c === '\t') ? c : multiline && c === '\r' ? '' : ' '));
  let cut = kept.trim().slice(0, max);
  while (/[\uD800-\uDBFF]$/.test(cut) || cut.endsWith(ZWJ)) cut = cut.slice(0, -1);
  return cut.trim();
}

/** A UUID (v4) for clientMessageId: one per typed message, reused when that same message is sent again. */
export function newMessageId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseConfig(v: unknown): WidgetConfig | null {
  const o = obj(v);
  if (!o || !isStr(o.teamName) || o.teamName.trim() === '' || !isStr(o.assistantNotice)) return null;
  if (o.disclosure === null) return { teamName: o.teamName, disclosure: null, assistantNotice: o.assistantNotice };
  const d = obj(o.disclosure);
  if (!d || !isStr(d.id) || !isStr(d.text)) return null;
  return { teamName: o.teamName, disclosure: { id: d.id, text: d.text }, assistantNotice: o.assistantNotice };
}

export function parseStart(v: unknown): StartResponse | null {
  const o = obj(v);
  return o && isStr(o.sessionToken) && /^[A-Za-z0-9_-]{16,200}$/.test(o.sessionToken) && o.status === 'open' ? { sessionToken: o.sessionToken, status: 'open' } : null;
}

export function parseAccepted(v: unknown): { accepted: true } | null {
  return obj(v)?.accepted === true ? { accepted: true } : null;
}

function reply(v: unknown): ChatReply | null {
  const o = obj(v);
  if (!o || !isStr(o.id) || !isStr(o.body) || !isStr(o.sentAt) || (o.from !== 'team' && o.from !== 'assistant')) return null;
  return { id: o.id, body: o.body, sentAt: o.sentAt, from: o.from };
}

/**
 * A page of replies. An entry this widget cannot show (a sender it does not know yet, a field missing) is skipped, never
 * drawn, while the page and its cursor still count: refusing the whole page would poll the same cursor for ever, and
 * the visitor would never see a later reply (finding F4). A page that is not the API's shape at all is refused.
 */
export function parsePoll(v: unknown): PollResponse | null {
  const o = obj(v);
  if (!o || !Array.isArray(o.messages) || typeof o.open !== 'boolean' || (o.cursor !== null && !isStr(o.cursor))) return null;
  const messages = o.messages.map(reply).filter((r): r is ChatReply => r !== null);
  return { messages, cursor: o.cursor as string | null, open: o.open };
}

/** The error code, for a validation failure the field its first issue names, and for a rate limit the wait. */
async function errorOf(r: Response): Promise<{ code: string | null; field?: Field; retryAfterSeconds?: number }> {
  try {
    const e = obj(obj(await r.json())?.error);
    const details = obj(e?.details);
    const issues = details?.issues;
    const path = Array.isArray(issues) ? obj(issues[0])?.path : undefined;
    const field: Field | undefined = path === '/name' ? 'name' : path === '/phone' || path === '/email' ? 'contact' : path === '/message' ? 'message' : undefined;
    const wait = details?.retryAfterSeconds;
    const retryAfterSeconds = typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? Math.ceil(wait) : undefined;
    return { code: isStr(e?.code) ? e.code : null, ...(field ? { field } : {}), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
  } catch {
    return { code: null };
  }
}

async function call<T>(f: Fetch, url: string, init: RequestInit, parse: (v: unknown) => T | null): Promise<Result<T>> {
  let r: Response;
  try {
    r = await f(url, { ...init, credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  } catch {
    return { ok: false, failure: 'failed' };
  }
  if (r.ok) {
    try {
      const d = parse(await r.json());
      return d ? { ok: true, data: d } : { ok: false, failure: 'failed' };
    } catch {
      return { ok: false, failure: 'failed' };
    }
  }
  if (r.status === 404) return { ok: false, failure: 'not_found' };
  if (r.status === 410) return { ok: false, failure: 'closed' };
  const e = await errorOf(r);
  if (r.status === 429) return { ok: false, failure: 'rate_limited', ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };
  if (r.status === 409 && e.code === 'CHANNEL_NOT_CONNECTED') return { ok: false, failure: 'unavailable' };
  if (r.status === 409 && e.code === 'WEBCHAT_DISCLOSURE_STALE') return { ok: false, failure: 'disclosure_stale' };
  if (r.status === 422 || r.status === 413) return { ok: false, failure: 'invalid', ...(e.field ? { field: e.field } : {}) };
  return { ok: false, failure: 'failed' };
}

export interface ChatApi {
  config(widgetKey: string): Promise<Result<WidgetConfig>>;
  start(widgetKey: string, req: StartRequest): Promise<Result<StartResponse>>;
  send(token: string, message: string, clientMessageId: string): Promise<Result<{ accepted: true }>>;
  poll(token: string, after: string | null): Promise<Result<PollResponse>>;
}

/** `base` is the Realty OS API origin + "/api" (the widget runs on the brokerage's own website). */
export function chatApi(base: string, f: Fetch = (i, init) => fetch(i, init)): ChatApi {
  const root = base.replace(/\/+$/, '');
  const enc = encodeURIComponent;
  return {
    config(widgetKey) {
      return call(f, `${root}/public/chat/${enc(widgetKey)}`, { method: 'GET' }, parseConfig);
    },
    start(widgetKey, req) {
      const contact = req.phone !== undefined ? { phone: clean(req.phone, PHONE_MAX) } : req.email !== undefined ? { email: clean(req.email, EMAIL_MAX) } : {};
      const body: StartRequest = { name: clean(req.name, NAME_MAX), ...contact, message: clean(req.message, MESSAGE_MAX, true), disclosureId: req.disclosureId };
      return call(f, `${root}/public/chat/${enc(widgetKey)}/start`, { method: 'POST', body: JSON.stringify(body) }, parseStart);
    },
    send(token, message, clientMessageId) {
      const body = { message: clean(message, MESSAGE_MAX, true), clientMessageId };
      return call(f, `${root}/public/chat/session/${enc(token)}/messages`, { method: 'POST', body: JSON.stringify(body) }, parseAccepted);
    },
    poll(token, after) {
      return call(f, `${root}/public/chat/session/${enc(token)}/poll${after !== null ? `?after=${enc(after)}` : ''}`, { method: 'GET' }, parsePoll);
    },
  };
}
