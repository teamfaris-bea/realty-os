// The Gmail adapter of module 68 (PHASE2_3_PLAN §5.4 #68, R-GMAIL-3, R-GMAIL-4, R-GMAIL-11).
//
// Read-only by construction: the interface has no send, modify, label, trash or delete method, and the only scope
// ever requested is exactly `gmail.readonly`. Access tokens are returned to the caller and live in memory for one
// sync pass; only the refresh token is stored (encrypted, mailSync/token.ts).
//
// VERIFY every Gmail API shape below against Google's current documentation before a real adapter exists:
//   - OAuth 2.0 token endpoint (code exchange with PKCE S256, refresh, `invalid_grant`, the granted `scope` string)
//   - users.getProfile (emailAddress, historyId)
//   - users.history.list (startHistoryId, historyTypes messageAdded/messageDeleted/labelAdded, pageToken,
//     HTTP 404 for an expired startHistoryId)
//   - users.messages.list (q=after:<epoch seconds>, maxResults, pageToken)
//   - users.messages.get (format=metadata|full; payload.headers, labelIds, internalDate in ms, the parts tree)
//   - the revoke endpoint (oauth2.googleapis.com/revoke)
//   - quotas and rate limits (per-user units)
// This build ships ONLY the deterministic fake and an "unconfigured" adapter that refuses every call: no Google
// OAuth client is configured, no Gmail API is ever called and no real token exists (lane priorities).
import { createHash } from 'node:crypto';
import { ProviderError } from '../providers/types.js';

/** The one scope Realty OS ever requests or stores (R-GMAIL-3; the user_mail_links scopes CHECK). VERIFY. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPES: readonly string[] = [GMAIL_READONLY_SCOPE];

export interface GmailRef {
  id: string;
  threadId: string;
}
export interface GmailLabelChange {
  id: string;
  threadId: string;
  /** labels the message now has after the change (VERIFY: history.labelsAdded carries message.labelIds) */
  labelIds: string[];
}
export interface GmailAttachmentMeta {
  name: string;
  mimeType: string;
  sizeBytes: number;
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Gmail's internalDate, epoch milliseconds (never the sender's Date header) */
  internalDate: number;
  headers: { name: string; value: string }[];
  /** the text/plain part, decoded; null when the message has none (HTML is never read or stored) */
  textPlain: string | null;
  /** attachment metadata only; content is never fetched (E208) */
  attachments: GmailAttachmentMeta[];
}

export type HistoryPage =
  | {
      added: GmailRef[];
      removed: GmailRef[];
      labelChanges: GmailLabelChange[];
      /** the mailbox's history id (the cursor once the LAST page is done) */
      historyId: string;
      /** the largest history record id ON this page (history[].id, VERIFY): a safe cursor after this page commits */
      pageHistoryId: string | null;
      nextPageToken?: string;
    }
  | { expired: true };

export interface GmailProvider {
  /** false in production until a reviewed Google OAuth client exists (honest status; R-INT-6 + N19) */
  readonly configured: boolean;
  authorizeUrl(i: { state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] }): string;
  exchangeCode(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string; grantedScopes: string[] }>;
  profile(accessToken: string): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(accessToken: string, startHistoryId: string, pageToken?: string): Promise<HistoryPage>;
  /** the backfill window only, never the whole mailbox */
  listMessages(accessToken: string, window: { after: number; pageToken?: string; max: number }): Promise<{ refs: GmailRef[]; nextPageToken?: string }>;
  getMessage(accessToken: string, id: string, format: 'metadata' | 'full'): Promise<GmailMessage>;
  refresh(refreshToken: string): Promise<{ accessToken: string } | { invalidGrant: true }>;
  revoke(refreshToken: string): Promise<{ revoked: boolean }>;
}

/** Production without a reviewed Google client: every call refuses; nothing reaches Google. */
export class UnconfiguredGmail implements GmailProvider {
  readonly configured = false;
  authorizeUrl(): string {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async exchangeCode(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async profile(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async listHistory(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async listMessages(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async getMessage(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async refresh(): Promise<never> {
    throw new ProviderError('not_configured', 'GMAIL_NOT_CONFIGURED');
  }
  async revoke(): Promise<{ revoked: boolean }> {
    return { revoked: false };
  }
}

// ---- the deterministic fake ------------------------------------------------------------------------------

export interface FakeMailInput {
  id?: string;
  threadId?: string;
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string | null;
  html?: string;
  messageId?: string | null;
  labelIds?: string[];
  internalDate: number;
  attachments?: GmailAttachmentMeta[];
}

interface FakeMailbox {
  address: string;
  messages: Map<string, GmailMessage & { html?: string }>;
  /** history records: (historyId, kind, ref) */
  history: { id: number; kind: 'added' | 'removed' | 'labels'; ref: GmailRef; labelIds?: string[] }[];
  historyId: number;
  /** history ids at or below this are "expired" (Gmail keeps history for a limited time; VERIFY) */
  expiredBelow: number;
}

interface FakeGrant {
  challenge: string;
  mailbox: string;
  scopes: string[];
  used: boolean;
}

const sha = (s: string) => createHash('sha256').update(s, 'ascii').digest('base64url');

/**
 * Deterministic in-memory Gmail. Tests drive the "Google side": `issueCode` is the person approving in Google's
 * dialog (with whatever scopes Google would grant), `deliver` puts a message in a mailbox, `trash`/`remove` change it.
 * `calls` records every API call (method + arguments without tokens), so tests can prove what was and was not read.
 */
export class FakeGmail implements GmailProvider {
  readonly configured = true;
  readonly calls: { method: string; arg?: string }[] = [];
  readonly revoked: string[] = [];
  readonly mailboxes = new Map<string, FakeMailbox>();
  readonly #grants = new Map<string, FakeGrant>();
  readonly #refresh = new Map<string, { mailbox: string; scopes: string[]; invalid: boolean }>();
  readonly #access = new Map<string, string>();
  #n = 0;
  /** the next exchangeCode fails (an outage at Google) */
  failNextExchange = false;

  mailbox(address: string): FakeMailbox {
    const a = address.toLowerCase();
    let m = this.mailboxes.get(a);
    if (!m) {
      m = { address: a, messages: new Map(), history: [], historyId: 1000, expiredBelow: 0 };
      this.mailboxes.set(a, m);
    }
    return m;
  }

  authorizeUrl(i: { state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] }): string {
    const u = new URL('https://accounts.fake.invalid/o/oauth2/v2/auth');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', 'fake-gmail-client');
    u.searchParams.set('redirect_uri', i.redirectUri);
    u.searchParams.set('scope', i.scopes.join(' '));
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  }

  /** The person approved in Google's dialog. `scopes` defaults to exactly gmail.readonly. */
  issueCode(i: { codeChallenge: string; mailbox: string; scopes?: string[] }): string {
    this.#n += 1;
    const code = `fake-gmail-code-${this.#n}`;
    this.mailbox(i.mailbox);
    this.#grants.set(code, { challenge: i.codeChallenge, mailbox: i.mailbox.toLowerCase(), scopes: i.scopes ?? [GMAIL_READONLY_SCOPE], used: false });
    return code;
  }

  async exchangeCode(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string; grantedScopes: string[] }> {
    this.calls.push({ method: 'exchangeCode' });
    if (this.failNextExchange) {
      this.failNextExchange = false;
      throw new ProviderError('unavailable', 'FAKE_OUTAGE');
    }
    const g = this.#grants.get(i.code);
    if (!g || g.used) throw new ProviderError('rejected', 'invalid_grant');
    g.used = true; // a code is single use (VERIFY: Google also revokes tokens issued from a reused code)
    if (sha(i.codeVerifier) !== g.challenge) throw new ProviderError('rejected', 'invalid_grant');
    this.#n += 1;
    const refreshToken = `fake-refresh-${this.#n}`;
    const accessToken = `fake-access-${this.#n}`;
    this.#refresh.set(refreshToken, { mailbox: g.mailbox, scopes: g.scopes, invalid: false });
    this.#access.set(accessToken, g.mailbox);
    return { refreshToken, accessToken, grantedScopes: [...g.scopes] };
  }

  #box(accessToken: string): FakeMailbox {
    const a = this.#access.get(accessToken);
    if (!a) throw new ProviderError('rejected', 'UNAUTHENTICATED');
    return this.mailbox(a);
  }

  async profile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
    this.calls.push({ method: 'profile' });
    const m = this.#box(accessToken);
    return { emailAddress: m.address, historyId: String(m.historyId) };
  }

  async listHistory(accessToken: string, startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    this.calls.push({ method: 'listHistory', arg: `${startHistoryId}:${pageToken ?? ''}` });
    const m = this.#box(accessToken);
    const start = Number(startHistoryId);
    if (start < m.expiredBelow) return { expired: true };
    const after = m.history.filter((h) => h.id > start);
    const offset = pageToken ? Number(pageToken) : 0;
    const PAGE = 3;
    const page = after.slice(offset, offset + PAGE);
    const more = after.length > offset + PAGE;
    const last = page.length > 0 ? page[page.length - 1]!.id : start;
    return {
      added: page.filter((h) => h.kind === 'added').map((h) => h.ref),
      removed: page.filter((h) => h.kind === 'removed').map((h) => h.ref),
      labelChanges: page.filter((h) => h.kind === 'labels').map((h) => ({ ...h.ref, labelIds: h.labelIds ?? [] })),
      historyId: String(Math.max(last, m.historyId)),
      pageHistoryId: page.length > 0 ? String(last) : null,
      ...(more ? { nextPageToken: String(offset + PAGE) } : {}),
    };
  }

  async listMessages(accessToken: string, w: { after: number; pageToken?: string; max: number }): Promise<{ refs: GmailRef[]; nextPageToken?: string }> {
    this.calls.push({ method: 'listMessages', arg: `${w.after}:${w.pageToken ?? ''}:${w.max}` });
    const m = this.#box(accessToken);
    const all = [...m.messages.values()].filter((x) => x.internalDate >= w.after).sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? -1 : 1));
    const offset = w.pageToken ? Number(w.pageToken) : 0;
    const size = Math.min(w.max, 4);
    const refs = all.slice(offset, offset + size).map((x) => ({ id: x.id, threadId: x.threadId }));
    return { refs, ...(all.length > offset + size ? { nextPageToken: String(offset + size) } : {}) };
  }

  async getMessage(accessToken: string, id: string, format: 'metadata' | 'full'): Promise<GmailMessage> {
    this.calls.push({ method: 'getMessage', arg: `${id}:${format}` });
    const m = this.#box(accessToken);
    const x = m.messages.get(id);
    if (!x) throw new ProviderError('rejected', 'NOT_FOUND');
    const { html: _html, ...rest } = x;
    return { ...rest, labelIds: [...x.labelIds], headers: x.headers.map((h) => ({ ...h })), textPlain: format === 'full' ? x.textPlain : null, attachments: x.attachments.map((a) => ({ ...a })) };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string } | { invalidGrant: true }> {
    this.calls.push({ method: 'refresh' });
    const r = this.#refresh.get(refreshToken);
    if (!r || r.invalid) return { invalidGrant: true };
    this.#n += 1;
    const accessToken = `fake-access-${this.#n}`;
    this.#access.set(accessToken, r.mailbox);
    return { accessToken };
  }

  async revoke(refreshToken: string): Promise<{ revoked: boolean }> {
    this.calls.push({ method: 'revoke' });
    this.revoked.push(refreshToken);
    // like Google, a revoke ends the whole grant (this user + this client): every token of the same mailbox dies
    const r = this.#refresh.get(refreshToken);
    if (r) for (const x of this.#refresh.values()) if (x.mailbox === r.mailbox) x.invalid = true;
    return { revoked: true };
  }

  // ---- the Google side, for tests -------------------------------------------------------------------------

  /** The person removed Realty OS's access in their Google account (E217). */
  revokeAllFor(mailbox: string): void {
    for (const r of this.#refresh.values()) if (r.mailbox === mailbox.toLowerCase()) r.invalid = true;
  }

  /** Delivers (or sends) a message in a mailbox; returns its Gmail id. */
  deliver(mailbox: string, i: FakeMailInput): string {
    const m = this.mailbox(mailbox);
    this.#n += 1;
    const id = i.id ?? `m${this.#n.toString(16).padStart(8, '0')}`;
    const threadId = i.threadId ?? `t${id}`;
    const headers: { name: string; value: string }[] = [{ name: 'From', value: i.from }];
    if (i.to?.length) headers.push({ name: 'To', value: i.to.join(', ') });
    if (i.cc?.length) headers.push({ name: 'Cc', value: i.cc.join(', ') });
    if (i.bcc?.length) headers.push({ name: 'Bcc', value: i.bcc.join(', ') });
    if (i.subject !== undefined) headers.push({ name: 'Subject', value: i.subject });
    if (i.messageId !== null) headers.push({ name: 'Message-ID', value: i.messageId ?? `<${id}@mail.fake.invalid>` });
    m.messages.set(id, { id, threadId, labelIds: i.labelIds ?? ['INBOX'], internalDate: i.internalDate, headers, textPlain: i.text === undefined ? 'Hello' : i.text, attachments: i.attachments ?? [], ...(i.html ? { html: i.html } : {}) });
    m.historyId += 1;
    m.history.push({ id: m.historyId, kind: 'added', ref: { id, threadId } });
    return id;
  }

  /** Moves a message to TRASH or SPAM (a label change in history). */
  label(mailbox: string, id: string, labelIds: string[]): void {
    const m = this.mailbox(mailbox);
    const x = m.messages.get(id);
    if (!x) return;
    x.labelIds = labelIds;
    m.historyId += 1;
    m.history.push({ id: m.historyId, kind: 'labels', ref: { id, threadId: x.threadId }, labelIds });
  }

  /** Permanently deletes a message. */
  remove(mailbox: string, id: string): void {
    const m = this.mailbox(mailbox);
    const x = m.messages.get(id);
    if (!x) return;
    m.messages.delete(id);
    m.historyId += 1;
    m.history.push({ id: m.historyId, kind: 'removed', ref: { id, threadId: x.threadId } });
  }

  /** Gmail dropped the old history: a startHistoryId below the current one is answered `expired` (E218). */
  expireHistory(mailbox: string): void {
    const m = this.mailbox(mailbox);
    m.expiredBelow = m.historyId;
  }

  callCount(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}
