// Website chat (module 22; PHASE2_3_PLAN §5.4 #22; DATA_MODEL R-INBOX-1/2/5/7, R-TEN-12, R-CHAN-3; E77, E137, E138,
// E154, E155).
//
// Visitors are not principals (R-TEN-12). Every public request resolves its tenant ONLY through a 0042 definer
// (the widget key: app.resolve_webchat_widget; the session token: app.webchat_session; reads: app.webchat_poll), then
// writes as the system actor of THAT tenant. Nothing in a request body ever names a tenant, a contact or an address.
//
//   start      after the visitor saw the widget's current disclosure (its lead source's consent disclosure) and typed
//              a name, a phone or email and a first message:
//              spam (content checks; the rate limits run before) ⇒ a session with NO contact, purged after 30 days;
//              nothing is created, offered or notified (E137, R-INBOX-5)
//              otherwise ⇒ a NEW contact through intake with the widget's lead source, holding ONLY the session's own
//              chat identity wc:<random hex> (R-INBOX-1); the typed phone/email is stored on the session as an
//              unverified claim (webchat_sessions.claimed_*), never a contact point, so nothing automated ever goes
//              to it (E154); a typed address matching an existing person never attaches the chat to them: it raises
//              a duplicate suggestion "typed in chat, not verified" for that person's agent (E138); the opening
//              message is stored in the one conversation (and opt-out-classified: "stop contacting me" marks only
//              this session's own new contact, E155); routing and the 60-second first response are intake's
//   messages   a visitor's message: the Phase 1 ingestion transaction (comms/inbound.ts ingestChannelInbound): pause,
//              cancel queued assistant messages and scheduled trigger runs, one handback, the same feed card as a text
//   poll       that session's delivered replies only (app.webchat_poll), oldest first, with a cursor; nothing once the
//              session ended (open: false)
// A widget that is not connected answers CHANNEL_NOT_CONNECTED (R-INBOX-7); a closed or idle session (30 min, E77)
// takes no visitor message (WEBCHAT_SESSION_CLOSED) and no reply (dispatch: CHANNEL_NOT_CONNECTED).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ContactId, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { normalizeEmail, normalizePhone } from '@realty/core/foundation';
import { type Tx, lockContacts, withTenantTx } from '@realty/db';
import { enforceLimits, type Limit } from '../auth/rateLimit.js';
import { ingestChannelInbound, ingestChannelInboundInTx } from '../comms/inbound.js';
import { tenantFacts } from '../comms/repos/gate.js';
import { notifyUser } from '../comms/repos/notify.js';
import type { CommsDeps } from '../comms/types.js';
import { SYSTEM_NOTICE } from '../comms/types.js';
import { AppError } from '../errors.js';
import { ingestInquiryInTx } from '../leads/intake.js';
import { addDuplicateCandidate } from '../leads/repos/contacts.js';
import { systemActor } from '../worker/systemActor.js';
import * as repo from './repos/webchat.js';

export interface WebChatDeps {
  comms: CommsDeps;
  /** keys the rate-limit counters and the IP hash (never stored in plain text) */
  secret: Uint8Array;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Public widget keys are server-generated: `wk_` + 40 hex. Anything else is never looked up. */
export const WIDGET_KEY_RE = /^wk_[0-9a-f]{40}$/;
/** Session tokens: 32 random bytes, base64url (43 characters). */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const NAME_MAX = 120;
export const MESSAGE_MAX = 2000;
const PURGE_DAYS = 30;

export function newWidgetKey(): string {
  return `wk_${randomBytes(20).toString('hex')}`;
}

export const widgetKeyHash = (key: string): Buffer => sha256(`webchat-widget\n${key}`);
export const sessionTokenHash = (token: string): Buffer => sha256(`webchat-session\n${token}`);

// ---- deterministic checks (pure; property-tested) ---------------------------------------------------------

export type SpamReason = 'LINKS' | 'NAME_NOT_A_NAME' | 'REPEATED' | 'EMPTY';

const URL_PATTERN = String.raw`\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|ru|xyz|top|info|biz|io|co|me|ly|cn)\b`;
const urlCount = (s: string): number => (s.match(new RegExp(URL_PATTERN, 'giu')) ?? []).length;

/**
 * Content spam checks on the opening message (R-INBOX-5). Conservative: a real lead writes a sentence and a name.
 * Rate limits (per widget, per IP) run before and cap volume (E137).
 */
export function chatSpamReason(i: { name: string; message: string }): SpamReason | null {
  const name = i.name.trim();
  const message = i.message.trim();
  if (name === '' || message === '') return 'EMPTY';
  if (urlCount(message) > 2) return 'LINKS';
  if (urlCount(name) > 0 || name.includes('@') || (name.match(/\d/g) ?? []).length > 3) return 'NAME_NOT_A_NAME';
  if (/(.)\1{29,}/su.test(message)) return 'REPEATED';
  return null;
}

/** The typed contact detail, normalized; null = invalid (a 422 for the visitor). */
export function claimOf(i: { phone?: string | undefined; email?: string | undefined }): { kind: 'phone' | 'email'; address: string } | null {
  if (i.phone !== undefined && i.email !== undefined) return null;
  if (i.phone !== undefined) {
    const n = normalizePhone(i.phone, 'US');
    return n.ok ? { kind: 'phone', address: n.e164 } : null;
  }
  if (i.email !== undefined) {
    if (/[\r\n]/.test(i.email)) return null;
    const n = normalizeEmail(i.email);
    return n.ok && n.email.length <= 320 ? { kind: 'email', address: n.email } : null;
  }
  return null;
}

/** An Origin header as `scheme://host[:port]` (lowercase), or null. */
export function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw || raw.length > 300 || raw === 'null') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** A widget with allowed origins runs only there; one without any accepts every origin (the key is public). */
export function originAllowed(allowed: readonly string[], origin: string | null): boolean {
  if (allowed.length === 0) return true;
  return origin !== null && allowed.map((o) => o.toLowerCase()).includes(origin);
}

// ---- rate limits (auth.rate_limit_hit; DB-backed, shared by every API process) -------------------------------

export const START_LIMITS = (widget: string, ip: string): Limit[] => [
  { kind: 'webchat_start_ip', parts: [ip], max: 5, windowSeconds: 60 },
  { kind: 'webchat_start_ip_hour', parts: [ip], max: 20, windowSeconds: 3600 },
  { kind: 'webchat_start_widget', parts: [widget], max: 60, windowSeconds: 60 },
];
export const MESSAGE_LIMITS = (widget: string, session: string, ip: string): Limit[] => [
  { kind: 'webchat_msg_session', parts: [session], max: 20, windowSeconds: 60 },
  { kind: 'webchat_msg_ip', parts: [ip], max: 60, windowSeconds: 60 },
  { kind: 'webchat_msg_widget', parts: [widget], max: 600, windowSeconds: 60 },
];
export const POLL_LIMITS = (session: string, ip: string): Limit[] => [
  { kind: 'webchat_poll_session', parts: [session], max: 90, windowSeconds: 60 },
  { kind: 'webchat_poll_ip', parts: [ip], max: 600, windowSeconds: 60 },
];

// ---- public operations -----------------------------------------------------------------------------------

async function liveWidget(deps: WebChatDeps, widgetKey: string, origin: string | null): Promise<{ tenantId: string; connectionId: string; leadSourceId: string }> {
  if (!WIDGET_KEY_RE.test(widgetKey)) throw new AppError('NOT_FOUND');
  const w = await repo.resolveWidget(deps.comms.db, widgetKeyHash(widgetKey));
  if (!w) throw new AppError('NOT_FOUND');
  if (!w.live || !w.tenantId || !w.connectionId || !w.leadSourceId) throw new AppError('CHANNEL_NOT_CONNECTED');
  // another website embedding someone's public key: the widget does not exist there
  if (!originAllowed(w.allowedOrigins, origin)) throw new AppError('NOT_FOUND');
  return { tenantId: w.tenantId, connectionId: w.connectionId, leadSourceId: w.leadSourceId };
}

const asWidget = <T>(deps: WebChatDeps, tenantId: string, fn: (tx: Tx, sys: SystemActor, now: Instant) => Promise<T>) => {
  const sys = systemActor(tenantId, 'provider');
  return withTenantTx(sys, (tx, now) => fn(tx, sys, now), { db: deps.comms.db, retries: 2 });
};

export interface WidgetConfig {
  teamName: string;
  disclosure: { id: string; text: string } | null;
  assistantNotice: string;
}

/** What the widget shows before the visitor writes: the disclosure they must see first (R-INBOX-5). */
export async function widgetConfig(deps: WebChatDeps, widgetKey: string, origin: string | null): Promise<WidgetConfig> {
  const w = await liveWidget(deps, widgetKey, origin);
  return asWidget(deps, w.tenantId, async (tx) => {
    const source = await repo.leadSourceOf(tx, w.leadSourceId);
    if (!source || !source.active) throw new AppError('CHANNEL_NOT_CONNECTED');
    const d = source.consent_disclosure_id ? await repo.disclosureBody(tx, source.consent_disclosure_id) : null;
    const t = await tenantNames(tx);
    return {
      teamName: t.teamName ?? t.brokerage,
      disclosure: d ? { id: d.id, text: d.body } : null,
      // the assistant never passes as a human (product values); its replies are labelled in the poll too
      assistantNotice: `Replies may come from ${t.teamName ?? t.brokerage}'s automated assistant or from a person on the team.`,
    };
  });
}

async function tenantNames(tx: Tx): Promise<{ teamName: string | null; brokerage: string }> {
  const t = await tenantFacts(tx);
  return { teamName: t.teamName, brokerage: t.brokerageLegalName };
}

export interface StartInput {
  name: string;
  phone?: string | undefined;
  email?: string | undefined;
  message: string;
  disclosureId: string;
}

export interface StartResult {
  sessionToken: string;
  /** what the widget may say; never whether a contact was created (a spammer learns nothing) */
  status: 'open';
}

export async function startChat(deps: WebChatDeps, widgetKey: string, origin: string | null, ip: string, input: StartInput): Promise<StartResult> {
  const claim = claimOf(input);
  if (!claim) throw new AppError('VALIDATION_FAILED', { issues: [{ path: input.phone !== undefined && input.email !== undefined ? '/' : input.phone !== undefined ? '/phone' : '/email', code: 'invalid' }] });
  const ipKey = ipHash(deps.secret, ip).toString('hex');
  // E137: the counters run before anything is resolved in a tenant (and keep counting while blocked)
  await enforceLimits(deps.comms.db, deps.secret, START_LIMITS(sha256(widgetKey).toString('hex'), ipKey));
  const w = await liveWidget(deps, widgetKey, origin);
  const token = randomBytes(32).toString('base64url');
  await asWidget(deps, w.tenantId, async (tx, sys, now) => {
    const widget = await repo.widgetRow(tx, w.connectionId);
    if (!widget || (widget.status !== 'connected' && widget.status !== 'degraded')) throw new AppError('CHANNEL_NOT_CONNECTED');
    const source = await repo.leadSourceOf(tx, w.leadSourceId);
    if (!source || !source.active) throw new AppError('CHANNEL_NOT_CONNECTED');
    // R-INBOX-5: the chat starts only after the visitor saw the widget's CURRENT disclosure
    if (!source.consent_disclosure_id || source.consent_disclosure_id !== input.disclosureId) throw new AppError('WEBCHAT_DISCLOSURE_STALE');
    const sessionId = deps.comms.ids.next<'WebchatSessionId'>();
    const base = { id: sessionId, connectionId: w.connectionId, tokenHash: sessionTokenHash(token), origin: origin ?? 'none', ipHash: ipHash(deps.secret, ip) };
    if (chatSpamReason(input) !== null) {
      // E137: no contact, no offer, no notification; the session itself is purged after 30 days
      await repo.insertSession(tx, { ...base, contactId: null, contactPointId: null, claimedKind: null, claimedAddress: null, purgeAfterDays: PURGE_DAYS });
      return;
    }
    const address = `wc:${randomBytes(16).toString('hex')}`;
    const env = deps.comms.envelope.inTx(tx, sys.tenantId as TenantId);
    const hmac = Buffer.from(await env.hmacAddress(sys.tenantId as TenantId, address)).toString('hex');
    const pointId = deps.comms.ids.next<'ContactPointId'>();
    const res = await ingestInquiryInTx(
      tx,
      sys,
      {
        leadSourceId: source.id,
        externalId: `webchat:${sessionId}`,
        fullName: input.name.trim().slice(0, NAME_MAX),
        message: input.message.trim().slice(0, MESSAGE_MAX),
        sourceDetail: { channel: 'web_chat', widget_connection_id: w.connectionId, disclosure_id: source.consent_disclosure_id },
      },
      now,
      { envelope: deps.comms.envelope, ids: deps.comms.ids },
      { webChat: { address, hmac, pointId } },
    );
    await repo.insertSession(tx, { ...base, contactId: res.contactId, contactPointId: pointId, claimedKind: claim.kind, claimedAddress: claim.address, purgeAfterDays: null });
    await ingestChannelInboundInTx(tx, sys, { kind: 'web_chat', providerRef: `webchat:${sessionId}:opening`, from: address, connectionId: w.connectionId, body: input.message.trim().slice(0, MESSAGE_MAX) }, now, deps.comms, { opening: true });
    await typedClaimSuggestion(tx, deps, sys, res.contactId, claim, now);
  });
  return { sessionToken: token, status: 'open' };
}

/**
 * E138 / R-INBOX-1: a typed phone or email that matches an existing person never attaches the chat to them. It
 * raises a duplicate suggestion (merging is a human decision, R-OWN-24) and tells that person's agent, content-free,
 * that it was typed in chat and is not verified.
 */
async function typedClaimSuggestion(tx: Tx, deps: WebChatDeps, sys: SystemActor, chatContactId: string, claim: { kind: 'phone' | 'email'; address: string }, now: Instant): Promise<void> {
  const env = deps.comms.envelope.inTx(tx, sys.tenantId as TenantId);
  const h = Buffer.from(await env.hmacAddress(sys.tenantId as TenantId, claim.address));
  // a person with that point, and (UXA-5) an earlier chat lead who typed the same thing: a returning visitor
  const found = [...(await repo.contactsWithHmac(tx, h)), ...(await repo.contactsWithClaim(tx, claim.kind, claim.address))];
  const matches = [...new Map(found.filter((m) => m.contact_id !== chatContactId).map((m) => [m.contact_id, m])).values()];
  if (matches.length === 0) return;
  await lockContacts(tx, [...new Set([chatContactId, ...matches.map((m) => m.contact_id)])].sort() as ContactId[]);
  for (const m of matches) {
    await addDuplicateCandidate(tx, deps.comms.ids.next(), chatContactId, m.contact_id, claim.kind === 'phone' ? 'shared_phone' : 'shared_email');
    if (m.owner_user_id) {
      await notifyUser(
        tx,
        deps.comms.ids,
        {
          userId: m.owner_user_id,
          kind: SYSTEM_NOTICE,
          priority: 'normal',
          title: `A website chat visitor typed your contact's ${claim.kind === 'phone' ? 'phone number' : 'email'}`,
          body: 'Typed in chat, not verified. The chat stays a separate contact; merge them only if you know it is the same person.',
          subjectType: 'contact',
          subjectId: m.contact_id,
          dedupeKey: `webchat_claim:${chatContactId}:${m.contact_id}`,
        },
        now,
      );
    }
  }
}

export interface MessageInput {
  message: string;
  /** the widget's own id for this message: a retried POST is the same message */
  clientMessageId?: string | undefined;
}

export async function postVisitorMessage(deps: WebChatDeps, token: string, ip: string, input: MessageInput): Promise<{ accepted: true }> {
  if (!SESSION_TOKEN_RE.test(token)) throw new AppError('NOT_FOUND');
  const s = await repo.resolveSession(deps.comms.db, sessionTokenHash(token));
  if (!s) throw new AppError('NOT_FOUND');
  await enforceLimits(deps.comms.db, deps.secret, MESSAGE_LIMITS(s.connectionId, s.sessionId, ipHash(deps.secret, ip).toString('hex')));
  if (!s.widgetLive) throw new AppError('CHANNEL_NOT_CONNECTED');
  if (!s.open) throw new AppError('WEBCHAT_SESSION_CLOSED');
  // a session that never got a contact (spam) stores nothing: nothing is created, offered or notified (E137)
  if (!s.contactId || !s.contactPointId) return { accepted: true };
  const actor = systemActor(s.tenantId, 'provider');
  const address = await withTenantTx(actor, async (tx) => {
    await repo.touchSession(tx, s.sessionId);
    return repo.pointAddress(tx, s.contactPointId!);
  }, { db: deps.comms.db, retries: 2 });
  if (!address) return { accepted: true };
  const ref = input.clientMessageId ? `webchat:${s.sessionId}:${input.clientMessageId}` : `webchat:${s.sessionId}:${randomBytes(12).toString('hex')}`;
  await ingestChannelInbound(actor, { kind: 'web_chat', providerRef: ref, from: address, connectionId: s.connectionId, body: input.message.trim().slice(0, MESSAGE_MAX) }, deps.comms);
  return { accepted: true };
}

export interface PollResult {
  messages: { id: string; body: string; sentAt: string; from: 'team' | 'assistant' }[];
  /** pass back as ?after= */
  cursor: string | null;
  open: boolean;
}

/** `after`: `<microseconds>.<message uuid>` as a previous poll returned it. */
export function parseCursor(after: string | undefined): { us: string; id: string } | null | 'invalid' {
  if (after === undefined || after === '') return null;
  const m = /^(\d{1,19})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(after);
  return m ? { us: m[1]!, id: m[2]! } : 'invalid';
}

export async function pollSession(deps: WebChatDeps, token: string, ip: string, after: string | undefined): Promise<PollResult> {
  if (!SESSION_TOKEN_RE.test(token)) throw new AppError('NOT_FOUND');
  const cursor = parseCursor(after);
  if (cursor === 'invalid') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/after', code: 'invalid' }] });
  const hash = sessionTokenHash(token);
  const s = await repo.resolveSession(deps.comms.db, hash);
  if (!s) throw new AppError('NOT_FOUND');
  await enforceLimits(deps.comms.db, deps.secret, POLL_LIMITS(s.sessionId, ipHash(deps.secret, ip).toString('hex')));
  if (!s.widgetLive) throw new AppError('CHANNEL_NOT_CONNECTED');
  // An ended session (closed, or idle 30 minutes: E77) reads nothing more (finding chat-ended-session-readable): no
  // reply can be sent to it any more, and its token must not stay a read key for the conversation for as long as the
  // widget is connected (a token left in a shared tab, or copied from anywhere). The widget polls at least once a
  // minute while its page is open, so it has already shown every reply sent before the end; its cursor comes back
  // unchanged.
  if (!s.open) return { messages: [], cursor: after ?? null, open: false };
  const rows = await repo.poll(deps.comms.db, hash, cursor, 50);
  if (s.contactId) await withTenantTx(systemActor(s.tenantId, 'provider'), (tx) => repo.touchSession(tx, s.sessionId), { db: deps.comms.db, retries: 2 });
  const last = rows[rows.length - 1];
  return {
    messages: rows.map((r) => ({ id: r.id, body: r.body, sentAt: r.sentAt.toISOString(), from: r.author })),
    cursor: last ? `${last.sentAtUs}.${last.id}` : (after ?? null),
    open: s.open,
  };
}

function ipHash(secret: Uint8Array, ip: string): Buffer {
  return createHmac('sha256', secret).update(`webchat-ip:${ip}`).digest();
}
