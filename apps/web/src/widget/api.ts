// The chat widget's typed client for module 22's public web-chat routes (PHASE2_3_PLAN §5.4, 22
// api/channels-inbox). None of them exists yet: every call is marked `// STUB(22): <METHOD> <route>`, and
// api.contract.test.ts pins the shapes against a fake of the §5.4 interface. The orchestrator wires the real
// routes when module 22 lands.
//
//   POST /public/chat/:widgetKey/start            {name, phone|email, message, disclosureId}
//   POST /public/chat/session/:token/messages     {body}
//   GET  /public/chat/session/:token/poll?after=  the session's own messages after a cursor
//
// §5.4 fixes the routes and the start body; the response shapes below are this client's reading of it and
// are marked VERIFY(22): module 22 owns them. The visitor reads only their own session's messages (R-INBOX-5):
// the client never asks for anything else, and renders only what the server returned (no typing, no
// presence, no invented replies; genuineness).
//
// This file is part of the separate widget bundle: it imports nothing outside src/widget
// (lint: realty/isolated-bundle).

export interface StartRequest {
  name: string;
  phone?: string;
  email?: string;
  message: string;
  disclosureId: string;
}

/** One message of the visitor's own session. `from: 'team'` is the team (a person or the team's assistant, whose text signs itself). */
export interface ChatMessage {
  id: string;
  from: 'visitor' | 'team';
  body: string;
  at: string;
}

/** VERIFY(22): start answers with the session token the visitor's later calls carry, and the session so far. */
export interface StartResponse {
  token: string;
  messages: ChatMessage[];
  cursor: string | null;
}

/** VERIFY(22): poll answers with the messages after the cursor, the next cursor, and whether the session ended (E77). */
export interface PollResponse {
  messages: ChatMessage[];
  cursor: string | null;
  ended: boolean;
}

/** VERIFY(22): posting a message answers with the stored message. */
export interface SendResponse {
  message: ChatMessage;
}

export type ApiFailure =
  /** 429 (R-INBOX-5 rate limits per widget and per IP, E137) */
  | 'rate_limited'
  /** the session is over (404/410, or CHANNEL_NOT_CONNECTED on the session) */
  | 'ended'
  /** the widget is disconnected or unknown (CHANNEL_NOT_CONNECTED or 404 on start, R-INBOX-7) */
  | 'unavailable'
  /** the request was refused as invalid (400) */
  | 'invalid'
  /** anything else: network, 5xx, a response that is not the agreed shape */
  | 'failed';

export type Result<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const isStr = (v: unknown): v is string => typeof v === 'string';

function message(v: unknown): ChatMessage | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.id) || !isStr(o.body) || !isStr(o.at) || (o.from !== 'visitor' && o.from !== 'team')) return null;
  return { id: o.id, from: o.from, body: o.body, at: o.at };
}

function messages(v: unknown): ChatMessage[] | null {
  if (!Array.isArray(v)) return null;
  const out: ChatMessage[] = [];
  for (const m of v) {
    const x = message(m);
    if (!x) return null;
    out.push(x);
  }
  return out;
}

const cursor = (v: unknown): string | null | undefined => (v === null ? null : isStr(v) ? v : undefined);

export function parseStart(v: unknown): StartResponse | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const ms = messages(o.messages ?? []);
  const c = cursor(o.cursor ?? null);
  return isStr(o.token) && o.token.length >= 16 && ms && c !== undefined ? { token: o.token, messages: ms, cursor: c } : null;
}

export function parsePoll(v: unknown): PollResponse | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const ms = messages(o.messages);
  const c = cursor(o.cursor ?? null);
  return ms && c !== undefined && typeof (o.ended ?? false) === 'boolean' ? { messages: ms, cursor: c, ended: o.ended === true } : null;
}

export function parseSend(v: unknown): SendResponse | null {
  const m = message(((v ?? {}) as Record<string, unknown>).message);
  return m ? { message: m } : null;
}

async function errorCode(r: Response): Promise<string | null> {
  try {
    const j = (await r.json()) as { error?: { code?: unknown } };
    return isStr(j.error?.code) ? j.error.code : null;
  } catch {
    return null;
  }
}

async function call<T>(f: Fetch, url: string, init: RequestInit, parse: (v: unknown) => T | null, onSession: boolean): Promise<Result<T>> {
  let r: Response;
  try {
    r = await f(url, { ...init, credentials: 'omit', headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  } catch {
    return { ok: false, failure: 'failed' };
  }
  if (r.ok) {
    let j: unknown;
    try {
      j = await r.json();
    } catch {
      return { ok: false, failure: 'failed' };
    }
    const d = parse(j);
    return d ? { ok: true, data: d } : { ok: false, failure: 'failed' };
  }
  if (r.status === 429) return { ok: false, failure: 'rate_limited' };
  const code = await errorCode(r);
  if (code === 'CHANNEL_NOT_CONNECTED') return { ok: false, failure: onSession ? 'ended' : 'unavailable' };
  if (r.status === 404 || r.status === 410) return { ok: false, failure: onSession ? 'ended' : 'unavailable' };
  if (r.status === 400) return { ok: false, failure: 'invalid' };
  return { ok: false, failure: 'failed' };
}

export interface ChatApi {
  start(widgetKey: string, req: StartRequest): Promise<Result<StartResponse>>;
  send(token: string, body: string): Promise<Result<SendResponse>>;
  poll(token: string, after: string | null): Promise<Result<PollResponse>>;
}

/** `base` is the Realty OS API origin + "/api" (the widget runs on the brokerage's own website). */
export function chatApi(base: string, f: Fetch = (i, init) => fetch(i, init)): ChatApi {
  const root = base.replace(/\/+$/, '');
  const enc = encodeURIComponent;
  return {
    start(widgetKey, req) {
      const body: StartRequest = { name: req.name, ...(req.phone ? { phone: req.phone } : {}), ...(req.email ? { email: req.email } : {}), message: req.message, disclosureId: req.disclosureId };
      // STUB(22): POST /public/chat/:widgetKey/start
      return call(f, `${root}/public/chat/${enc(widgetKey)}/start`, { method: 'POST', body: JSON.stringify(body) }, parseStart, false);
    },
    send(token, body) {
      // STUB(22): POST /public/chat/session/:token/messages
      return call(f, `${root}/public/chat/session/${enc(token)}/messages`, { method: 'POST', body: JSON.stringify({ body }) }, parseSend, true);
    },
    poll(token, after) {
      // STUB(22): GET /public/chat/session/:token/poll
      return call(f, `${root}/public/chat/session/${enc(token)}/poll${after ? `?after=${enc(after)}` : ''}`, { method: 'GET' }, parsePoll, true);
    },
  };
}

