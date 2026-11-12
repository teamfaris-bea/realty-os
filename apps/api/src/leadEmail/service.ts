// Lead-email intake (module 22's lead-email slice, pulled forward 2026-11-11; DATA_MODEL R-INBOX-9, R-LEM-1..8).
//
// receiveLeadEmail, in ONE transaction as the system actor of the tenant the inbox KEY resolved to (R-TEN-3: never
// from the body, never through app.resolve_channel_account):
//   1 lock the per-inbox message key, then refuse a message already received (replay; the DB's UNIQUE (tenant,
//     message key) also holds after webhook_events is purged)
//   2 trust (trust.ts): DKIM pass (the receiving provider's verdict) aligned with the From domain under one of the
//     inbox's allowlisted sender domains
//   3 parse (parse/): Zillow, Realtor.com or the generic labelled format; spans for every field
//   4 trusted AND parsed AND at least one valid phone or email ⇒ the existing intake (ingestInquiryInTx): dedupe by
//     address, inquiry with the lead source, routing through the ownership engine (offer, SLA timers, feed card),
//     and the 60-second first response job (to the LEAD's own points: the portal's From address is never a
//     contact point; opted-out addresses are never auto-messaged, D1, decided at send time by the gate)
//     anything else ⇒ held in "Needs review" with the reason; nothing is created, routed or sent (E153). A held
//     email keeps the tenant-HMACs of the addresses it names (point_hmacs, keyed as intake keys a contact's
//     points; never an address): erasing a person purges every held email naming one of their addresses, and the
//     retention sweep expires held content after 30 days (batch 5 review F2, migration 0041, R-DATA-4, R-DATA-3).
// acceptReview / discardReview: an Owner/Admin/Team Lead (role re-read under the system actor) decides a held email.
// Accepting goes through the same intake, audited, WITHOUT an autonomous first response (R-INBOX-9).
//
// Personal mailboxes and forwarding (R-LEM-11, R-LEM-12):
//   - mail From a consumer mailbox domain (a lead forwarded by hand) is held PERSONAL_MAILBOX and only its forwarded
//     block is read (forwardedOnly), so the reviewer can accept it without retyping;
//   - Gmail's forwarding confirmation (google.com, aligned DKIM pass, its subject) is held FORWARDING_CONFIRMATION,
//     never parsed and never accepted (Discard only); its content is kept encrypted so the reviewer can read the code;
//   - the team's own addresses never become a lead's point: before the auto-create path and on accept, the PARSED
//     points drop the email's From address, every active member's account email and alert phone, and the tenant's
//     live numbers (compared by tenant HMAC). Points a reviewer types are kept.
import { createHash, randomBytes } from 'node:crypto';
import type { IdGenerator, Instant, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { normalizeEmail, normalizePhone } from '@realty/core/foundation';
import { type Database, type Tx, lockAddresses, withTenantTx } from '@realty/db';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { type IngestResult, identifiersOf, ingestInquiryInTx } from '../leads/intake.js';
import { systemActor } from '../worker/systemActor.js';
import { type LeadEmailInbound, inboundAddress, keyFromRecipients } from './formats.js';
import { type ParseInput, type ParseResult, type ParsedLead, normalizeBody, parseLeadEmail } from './parse/index.js';
import * as repo from './repos/leadEmail.js';
import { type PortalId, PORTAL_CATALOG, SUGGESTED_SENDER_DOMAINS, decideTrust, holdSentence, ignoredSenderDomains, isForwardingConfirmation, normalizeDomain, senderDomainProblem } from './trust.js';

export interface LeadEmailDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  /** LEAD_EMAIL_INBOUND_DOMAIN; null: lead email is not set up on this deployment */
  inboundDomain: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** Stored (encrypted) review content is capped well below the parser's input cap. */
export const STORED_TEXT_CHARS = 20_000;
export const MAX_SENDER_DOMAINS = 10;

// ---- receiving ------------------------------------------------------------------------------------------

export type ReceiveOutcome = 'lead_created' | 'needs_review' | 'duplicate' | 'unrouted';

/** The inbox an inbound email is addressed to (pre-tenant), or null (unknown, rotated, disconnected, wrong domain). */
export async function resolveInbox(deps: LeadEmailDeps, n: LeadEmailInbound): Promise<{ tenantId: string; connectionId: string; leadSourceId: string } | null> {
  const key = keyFromRecipients(n.recipients, deps.inboundDomain);
  return key ? repo.resolveKey(deps.db, sha256(key)) : null;
}

/** The per-inbox message key: a replay to the same inbox is the same message; another tenant's id never collides. */
export function messageKey(connectionId: string, n: Pick<LeadEmailInbound, 'format' | 'messageId'>): Buffer {
  return sha256(`lead-email\n${connectionId}\n${n.format}\n${n.messageId}`);
}

/** Valid, normalized contact points of a parse (invalid or injected values never survive normalization). */
export function contactPointsOf(lead: Pick<ParsedLead, 'phones' | 'emails'> | null): { phones: string[]; emails: string[] } {
  const phones: string[] = [];
  const emails: string[] = [];
  for (const p of lead?.phones ?? []) {
    const n = normalizePhone(p.value, 'US');
    if (n.ok && !phones.includes(n.e164)) phones.push(n.e164);
  }
  for (const e of lead?.emails ?? []) {
    if (/[\r\n]/.test(e.value)) continue;
    const n = normalizeEmail(e.value);
    if (n.ok && !emails.includes(n.email)) emails.push(n.email);
  }
  return { phones: phones.slice(0, 5), emails: emails.slice(0, 5) };
}

function evidenceOf(lead: ParsedLead): Record<string, unknown> {
  const span = (f: { span: { start: number; end: number } } | null) => (f ? { start: f.span.start, end: f.span.end } : null);
  return {
    format: lead.format,
    name: span(lead.name),
    phones: lead.phones.map(span),
    emails: lead.emails.map(span),
    message: span(lead.message),
    property: span(lead.property),
    listing_id: span(lead.listingId),
  };
}

function inquiryOf(lead: ParsedLead, points: { phones: string[]; emails: string[] }, leadSourceId: string, externalId: string, overrides: AcceptOverrides = {}) {
  const fullName = (overrides.name ?? lead.name?.value ?? '').trim().slice(0, 120);
  return {
    leadSourceId,
    externalId,
    inquiryType: lead.leadType,
    ...(fullName ? { fullName } : {}),
    phones: points.phones,
    emails: points.emails,
    ...(lead.message ? { message: lead.message.value.slice(0, 4000) } : {}),
    ...(lead.property ? { propertyText: lead.property.value.slice(0, 500) } : {}),
    ...(lead.postalCode && /^[0-9]{5}$/.test(lead.postalCode) ? { postalCode: lead.postalCode } : {}),
    sourceDetail: { channel: 'lead_email', format: lead.format, ...(lead.listingId ? { listing_id: lead.listingId.value.slice(0, 64) } : {}) },
  };
}

const emptyLead = (): ParsedLead => ({ format: 'generic', name: null, phones: [], emails: [], message: null, property: null, listingId: null, postalCode: null, leadType: 'general' });

/** Steps 1-4 for a resolved inbox. Throws only for unexpected failures (the webhook marks the event failed). */
export async function receiveLeadEmail(deps: LeadEmailDeps, resolved: { tenantId: string; connectionId: string; leadSourceId: string }, n: LeadEmailInbound): Promise<{ outcome: ReceiveOutcome; contactId: string | null }> {
  const actor = systemActor(resolved.tenantId, 'provider');
  return withTenantTx(actor, (tx, now) => receiveInTx(tx, actor, deps, resolved, n, now), { db: deps.db, retries: 3 });
}

async function receiveInTx(tx: Tx, actor: SystemActor, deps: LeadEmailDeps, resolved: { connectionId: string; leadSourceId: string }, n: LeadEmailInbound, now: Instant): Promise<{ outcome: ReceiveOutcome; contactId: string | null }> {
  const inbox = await repo.inboxById(tx, resolved.connectionId);
  if (!inbox || (inbox.status !== 'connected' && inbox.status !== 'degraded') || inbox.lead_source_id !== resolved.leadSourceId) return { outcome: 'unrouted', contactId: null };
  const key = messageKey(inbox.id, n);
  await lockAddresses(tx, [key.toString('hex')]);
  if (await repo.messageExists(tx, key)) return { outcome: 'duplicate', contactId: null };

  // R-LEM-12: Gmail's forwarding confirmation is never parsed into an inquiry (a forged copy gets the ordinary hold)
  const confirmation = isForwardingConfirmation(n.from, n.dkim, n.subject);
  const trust = decideTrust(n.from, n.dkim, inbox.allowed_sender_domains);
  const input: ParseInput = { subject: n.subject, text: n.text, html: n.html, senderDomain: trust.fromDomain, ...(!trust.trusted && trust.code === 'PERSONAL_MAILBOX' ? { forwardedOnly: true } : {}) };
  const parsed: ParseResult = confirmation ? { ok: false, text: normalizeBody(input), reason: 'UNKNOWN_FORMAT', partial: null } : parseLeadEmail(input);
  const parsedLead = parsed.ok ? parsed.lead : parsed.partial;
  const lead = parsedLead ? await withoutTeamPoints(tx, deps, actor.tenantId, parsedLead, n.from) : null;
  const points = contactPointsOf(lead);
  const hold = confirmation ? 'FORWARDING_CONFIRMATION' : !trust.trusted ? trust.code : !parsed.ok ? parsed.reason : points.phones.length + points.emails.length === 0 ? 'NO_CONTACT_POINT' : null;
  const id = deps.ids.next<'LeadEmailMessageId'>();
  const base = {
    id,
    connectionId: inbox.id,
    leadSourceId: inbox.lead_source_id,
    messageKey: key,
    providerFormat: n.format,
    parserKind: lead && (parsed.ok || parsed.partial) ? lead.format : null,
    senderDomain: trust.fromDomain,
    dkimPassDomains: [...new Set(n.dkim.filter((v) => v.result === 'pass').map((v) => v.domain))].slice(0, 10),
  };

  if (hold === null && parsed.ok && lead) {
    const res: IngestResult = await ingestInquiryInTx(tx, actor, inquiryOf(lead, points, inbox.lead_source_id, `lead-email:${key.toString('hex').slice(0, 40)}`), now, { envelope: deps.envelope, ids: deps.ids }, { parse: { status: 'parsed', evidence: evidenceOf(lead) } });
    await repo.claimMessage(tx, { ...base, status: 'lead_created', holdCode: null, parserKind: lead.format, contentEnc: null, parsedEnc: null, pointHmacs: [], contactId: res.contactId, inquiryId: res.inquiryId });
    return { outcome: 'lead_created', contactId: res.contactId };
  }

  const env = deps.envelope.inTx(tx, actor.tenantId);
  const content = { subject: (n.subject ?? '').slice(0, 998), text: parsed.text.slice(0, STORED_TEXT_CHARS) };
  const contentEnc = await env.encrypt(actor.tenantId, { table: 'lead_email_messages', column: 'content_enc', rowId: id }, Buffer.from(JSON.stringify(content)));
  const parsedEnc = lead ? await env.encrypt(actor.tenantId, { table: 'lead_email_messages', column: 'parsed_enc', rowId: id }, Buffer.from(JSON.stringify(lead))) : null;
  const pointHmacs = await addressKeys(tx, deps.envelope, actor.tenantId, points);
  await repo.claimMessage(tx, { ...base, status: 'needs_review', holdCode: hold ?? 'UNKNOWN_FORMAT', contentEnc, parsedEnc, pointHmacs, contactId: null, inquiryId: null });
  return { outcome: 'needs_review', contactId: null };
}

/**
 * The tenant-HMACs of the team's own addresses (R-LEM-11 E590): every active member's account email and alert phone
 * (VERIFY 16: whether other member addresses, e.g. an email identity, belong here too), the tenant's live numbers, and
 * the email's own From address. Read as the system actor of the tenant (RLS: memberships and their users are readable
 * tenant-wide).
 */
async function teamPointKeys(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, from: string | null): Promise<Set<string>> {
  const team = await repo.teamAddresses(tx);
  const ids = await identifiersOf(tx, envelope, tenantId, team.phones, from ? [...team.emails, from] : team.emails);
  return new Set([...ids.phones, ...ids.emails].map((x) => x.hmac));
}

/** The parsed lead without the team's own points (a parse never makes the forwarder or the team a lead's point). */
async function withoutTeamPoints(tx: Tx, deps: LeadEmailDeps, tenantId: TenantId, lead: ParsedLead, from: string | null): Promise<ParsedLead> {
  if (lead.phones.length + lead.emails.length === 0) return lead;
  const team = await teamPointKeys(tx, deps.envelope, tenantId, from);
  const isTeam = async (phones: string[], emails: string[]) => {
    const ids = await identifiersOf(tx, deps.envelope, tenantId, phones, emails);
    return [...ids.phones, ...ids.emails].some((x) => team.has(x.hmac));
  };
  const phones: ParsedLead['phones'] = [];
  const emails: ParsedLead['emails'] = [];
  for (const p of lead.phones) if (!(await isTeam([p.value], []))) phones.push(p);
  for (const e of lead.emails) if (/[\r\n]/.test(e.value) || !(await isTeam([], [e.value]))) emails.push(e);
  return { ...lead, phones, emails };
}

/**
 * The tenant-HMACs of a held email's valid addresses, exactly as intake keys a contact's points (identifiersOf), so
 * that erasing a person finds the held emails naming them (app.purge_contact_internal, migration 0041).
 */
async function addressKeys(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, points: { phones: string[]; emails: string[] }): Promise<Buffer[]> {
  const ids = await identifiersOf(tx, envelope, tenantId, points.phones, points.emails);
  return [...ids.phones, ...ids.emails].map((x) => Buffer.from(x.hmac, 'hex'));
}

// ---- inbox settings (Owner/Admin) -------------------------------------------------------------------------

export interface InboxView {
  leadSourceId: string;
  enabled: boolean;
  connectionId: string | null;
  status: string | null;
  address: string | null;
  addressCreatedAt: string | null;
  allowedSenderDomains: string[];
  suggestedSenderDomains: { domain: string; label: string }[];
  /** saved entries the trust rule ignores (consumer mailbox domains saved before R-LEM-11) */
  ignoredSenderDomains: string[];
  /** every portal we know of; only the pre-ticked ones are suggestedSenderDomains */
  portalCatalog: { portal: PortalId; domain: string; label: string; preTicked: boolean }[];
  inboundDomainConfigured: boolean;
}

async function requireRole(tx: Tx, userId: string, roles: readonly string[]): Promise<void> {
  const role = await repo.activeRole(tx, userId);
  if (!role || !roles.includes(role)) throw new AppError('NOT_FOUND');
}

const MANAGERS = ['owner', 'admin'] as const;
const REVIEWERS = ['owner', 'admin', 'team_lead'] as const;
const asSystem = <T>(deps: LeadEmailDeps, actor: UserActor, fn: (tx: Tx, sys: SystemActor, now: Instant) => Promise<T>) => {
  const sys = systemActor(actor.tenantId, 'provider');
  return withTenantTx(sys, (tx, now) => fn(tx, sys, now), { db: deps.db, retries: 2 });
};

async function inboxView(tx: Tx, deps: LeadEmailDeps, tenantId: TenantId, leadSourceId: string): Promise<InboxView> {
  const inbox = await repo.inboxOfSource(tx, leadSourceId);
  const k = inbox ? await repo.currentKey(tx, inbox.id) : null;
  let address: string | null = null;
  if (k && deps.inboundDomain) {
    const key = Buffer.from(await deps.envelope.inTx(tx, tenantId).decrypt(tenantId, { table: 'lead_email_inbox_keys', column: 'key_enc', rowId: k.id }, k.key_enc)).toString('utf8');
    address = inboundAddress(key, deps.inboundDomain);
  }
  return {
    leadSourceId,
    enabled: inbox !== null,
    connectionId: inbox?.id ?? null,
    status: inbox?.status ?? null,
    address,
    addressCreatedAt: k ? k.created_at.toISOString() : null,
    allowedSenderDomains: inbox?.allowed_sender_domains ?? [],
    suggestedSenderDomains: SUGGESTED_SENDER_DOMAINS.map((d) => ({ ...d })),
    ignoredSenderDomains: ignoredSenderDomains(inbox?.allowed_sender_domains ?? []),
    portalCatalog: PORTAL_CATALOG.map((p) => ({ ...p })),
    inboundDomainConfigured: deps.inboundDomain !== null,
  };
}

/** GET (Owner/Admin, as the system after re-reading the role: the key is decrypted for display). */
export async function getInbox(deps: LeadEmailDeps, actor: UserActor, leadSourceId: string): Promise<InboxView> {
  return asSystem(deps, actor, async (tx, sys) => {
    await requireRole(tx, actor.userId, MANAGERS);
    if (!(await repo.leadSourceRow(tx, leadSourceId))) throw new AppError('NOT_FOUND');
    return inboxView(tx, deps, sys.tenantId, leadSourceId);
  });
}

function cleanDomains(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of raw) {
    const n = normalizeDomain(d);
    const problem = senderDomainProblem(n);
    // R-LEM-11 E327: a consumer mailbox domain (anyone can send from it) is refused with its own reason
    if (problem) throw new AppError('LEAD_EMAIL_DOMAIN_INVALID', { domain: n.slice(0, 253), ...(problem === 'consumer_mailbox' ? { reason: 'consumer_mailbox' } : {}) });
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_SENDER_DOMAINS) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/domains', code: 'too_many' }] });
  return out;
}

async function newKey(tx: Tx, deps: LeadEmailDeps, sys: SystemActor, connectionId: string, userId: string): Promise<void> {
  const key = randomBytes(20).toString('hex');
  const id = deps.ids.next<'LeadEmailKeyId'>();
  const keyEnc = await deps.envelope.inTx(tx, sys.tenantId).encrypt(sys.tenantId, { table: 'lead_email_inbox_keys', column: 'key_enc', rowId: id }, Buffer.from(key, 'utf8'));
  await repo.insertKey(tx, { id, connectionId, keyHash: sha256(key), keyEnc, userId });
}

/** Turns on the source's inbound address (idempotent: an existing inbox is returned as it is). */
export async function enableInbox(deps: LeadEmailDeps, actor: UserActor, leadSourceId: string, domains: readonly string[] | undefined): Promise<InboxView> {
  if (!deps.inboundDomain) throw new AppError('LEAD_EMAIL_NOT_CONFIGURED');
  const allowed = cleanDomains(domains ?? []);
  return asSystem(deps, actor, async (tx, sys) => {
    await requireRole(tx, actor.userId, MANAGERS);
    const source = await repo.leadSourceRow(tx, leadSourceId);
    if (!source || !source.active) throw new AppError('NOT_FOUND');
    await lockAddresses(tx, [sha256(`lead-email-inbox:${leadSourceId}`).toString('hex')]);
    if (!(await repo.inboxOfSource(tx, leadSourceId))) {
      const id = deps.ids.next<'IntegrationConnectionId'>();
      await repo.insertInbox(tx, { id, leadSourceId, displayName: `Lead email: ${source.name}`.slice(0, 120), domains: allowed, userId: actor.userId });
      await newKey(tx, deps, sys, id, actor.userId);
      await audit(tx, sys, {
        action: 'lead_email.inbox_enabled',
        entity: { type: 'integration_connection', id },
        changes: redactSnapshot({ kind: 'lead_email', status: 'connected', lead_source_id: leadSourceId, sender_domain_count: allowed.length, by_user_id: actor.userId }),
        reason: 'ENABLED',
      });
    }
    return inboxView(tx, deps, sys.tenantId, leadSourceId);
  });
}

/** A new address; the old key is retired in the same transaction and routes nothing from then on. */
export async function rotateKey(deps: LeadEmailDeps, actor: UserActor, leadSourceId: string): Promise<InboxView> {
  return asSystem(deps, actor, async (tx, sys) => {
    await requireRole(tx, actor.userId, MANAGERS);
    const inbox = await repo.inboxOfSource(tx, leadSourceId, { forUpdate: true });
    if (!inbox) throw new AppError('NOT_FOUND');
    const retired = await repo.retireKeys(tx, inbox.id);
    await newKey(tx, deps, sys, inbox.id, actor.userId);
    await audit(tx, sys, { action: 'lead_email.key_rotated', entity: { type: 'integration_connection', id: inbox.id }, changes: redactSnapshot({ retired_count: retired, by_user_id: actor.userId }), reason: 'ROTATED' });
    return inboxView(tx, deps, sys.tenantId, leadSourceId);
  });
}

export async function setSenderDomains(deps: LeadEmailDeps, actor: UserActor, leadSourceId: string, domains: readonly string[]): Promise<InboxView> {
  const allowed = cleanDomains(domains);
  return asSystem(deps, actor, async (tx, sys) => {
    await requireRole(tx, actor.userId, MANAGERS);
    const inbox = await repo.inboxOfSource(tx, leadSourceId, { forUpdate: true });
    if (!inbox) throw new AppError('NOT_FOUND');
    await repo.setDomains(tx, inbox.id, allowed);
    // sender domains are configuration, not PII: audited as from/to
    await audit(tx, sys, {
      action: 'lead_email.sender_domains_changed',
      entity: { type: 'integration_connection', id: inbox.id },
      changes: redactDiff({ allowed_sender_domains_count: inbox.allowed_sender_domains.length }, { allowed_sender_domains_count: allowed.length, by_user_id: actor.userId }),
      reason: 'SENDER_DOMAINS_CHANGED',
    });
    return inboxView(tx, deps, sys.tenantId, leadSourceId);
  });
}

// ---- Needs review (Owner/Admin/Team Lead) -------------------------------------------------------------------

export interface FieldView {
  value: string;
  span: { start: number; end: number };
}

export interface ReviewView {
  id: string;
  receivedAt: string;
  leadSourceId: string;
  leadSourceName: string;
  status: 'needs_review' | 'accepted' | 'discarded';
  holdCode: string;
  holdSentence: string;
  senderDomain: string | null;
  dkimPassDomains: string[];
  parserKind: string | null;
  subject: string | null;
  text: string | null;
  fields: { name: FieldView | null; phones: FieldView[]; emails: FieldView[]; message: FieldView | null; property: FieldView | null; listingId: FieldView | null; leadType: string } | null;
  canAccept: boolean;
  contactId: string | null;
  decidedAt: string | null;
}

async function reviewView(tx: Tx, deps: LeadEmailDeps, tenantId: TenantId, m: repo.MessageRow): Promise<ReviewView> {
  const env = deps.envelope.inTx(tx, tenantId);
  const content = m.content_enc
    ? (JSON.parse(Buffer.from(await env.decrypt(tenantId, { table: 'lead_email_messages', column: 'content_enc', rowId: m.id }, m.content_enc)).toString('utf8')) as { subject: string; text: string })
    : null;
  const lead = m.parsed_enc ? (JSON.parse(Buffer.from(await env.decrypt(tenantId, { table: 'lead_email_messages', column: 'parsed_enc', rowId: m.id }, m.parsed_enc)).toString('utf8')) as ParsedLead) : null;
  const f = (x: { value: string; span: { start: number; end: number } } | null) => (x ? { value: x.value, span: { start: x.span.start, end: x.span.end } } : null);
  return {
    id: m.id,
    receivedAt: m.received_at.toISOString(),
    leadSourceId: m.lead_source_id,
    leadSourceName: m.lead_source_name,
    status: m.status === 'lead_created' ? 'accepted' : m.status,
    holdCode: m.hold_code ?? 'UNKNOWN_FORMAT',
    holdSentence: holdSentence(m.hold_code, content?.subject ?? null),
    senderDomain: m.sender_domain,
    dkimPassDomains: m.dkim_pass_domains,
    parserKind: m.parser_kind,
    subject: content ? content.subject || null : null,
    text: content ? content.text : null,
    fields: lead
      ? { name: f(lead.name), phones: lead.phones.map((x) => f(x)!), emails: lead.emails.map((x) => f(x)!), message: f(lead.message), property: f(lead.property), listingId: f(lead.listingId), leadType: lead.leadType }
      : null,
    // R-LEM-12: a forwarding confirmation is never a lead (Discard only)
    canAccept: m.status === 'needs_review' && m.hold_code !== 'FORWARDING_CONFIRMATION' && (() => {
      const p = contactPointsOf(lead);
      return p.phones.length + p.emails.length > 0;
    })(),
    contactId: m.contact_id,
    decidedAt: m.decided_at ? m.decided_at.toISOString() : null,
  };
}

/** The list, read as the person (RLS: Owner/Admin/Team Lead; support read-only). */
export async function listReviews(tx: Tx, deps: LeadEmailDeps, tenantId: TenantId, status: 'needs_review' | 'decided'): Promise<{ items: ReviewView[]; pendingCount: number }> {
  const rows = await repo.listMessages(tx, status, 100);
  const items: ReviewView[] = [];
  for (const m of rows) items.push(await reviewView(tx, deps, tenantId, m));
  return { items, pendingCount: await repo.countReview(tx) };
}

export interface AcceptOverrides {
  name?: string;
  phone?: string;
  email?: string;
}

export async function acceptReview(deps: LeadEmailDeps, actor: UserActor, id: string, overrides: AcceptOverrides): Promise<{ review: ReviewView; contactId: string; outcome: IngestResult['outcome'] }> {
  return asSystem(deps, actor, async (tx, sys, now) => {
    await requireRole(tx, actor.userId, REVIEWERS);
    const m = await repo.messageById(tx, id, { forUpdate: true });
    if (!m) throw new AppError('NOT_FOUND');
    if (m.status !== 'needs_review') throw new AppError('LEAD_EMAIL_NOT_PENDING', { review: await reviewView(tx, deps, sys.tenantId, m) });
    // R-LEM-12 E353: whatever the reviewer types
    if (m.hold_code === 'FORWARDING_CONFIRMATION') throw new AppError('LEAD_EMAIL_NOT_A_LEAD');
    const env = deps.envelope.inTx(tx, sys.tenantId);
    const stored = m.parsed_enc ? (JSON.parse(Buffer.from(await env.decrypt(sys.tenantId, { table: 'lead_email_messages', column: 'parsed_enc', rowId: m.id }, m.parsed_enc)).toString('utf8')) as ParsedLead) : null;
    // the parsed points drop the team's own again (membership may have changed since receipt); typed points are kept
    const parsedLead = stored ? await withoutTeamPoints(tx, deps, sys.tenantId, stored, null) : null;
    const lead: ParsedLead = parsedLead ?? emptyLead();
    // the reviewer may add what the parser could not read (typed by a person, never by the email)
    const extra = { phones: overrides.phone ? [{ value: overrides.phone, span: { start: 0, end: 0 } }] : [], emails: overrides.email ? [{ value: overrides.email, span: { start: 0, end: 0 } }] : [] };
    const points = contactPointsOf({ phones: [...extra.phones, ...lead.phones], emails: [...extra.emails, ...lead.emails] });
    if (points.phones.length + points.emails.length === 0) throw new AppError('LEAD_EMAIL_NO_CONTACT_POINT');
    const res = await ingestInquiryInTx(
      tx,
      sys,
      inquiryOf(lead, points, m.lead_source_id, `lead-email:${m.id}`, overrides),
      now,
      { envelope: deps.envelope, ids: deps.ids },
      // R-INBOX-9: an email that was not verified never gets an autonomous reply, even once a person accepted it
      { firstResponse: false, ...(parsedLead ? { parse: { status: 'parsed' as const, evidence: { ...evidenceOf(parsedLead), reviewed_by_user_id: actor.userId } } } : {}) },
    );
    await repo.decide(tx, m.id, { status: 'accepted', userId: actor.userId, contactId: res.contactId, inquiryId: res.inquiryId });
    await audit(tx, sys, {
      action: 'lead_email.review_accepted',
      entity: { type: 'lead_email_message', id: m.id },
      changes: redactSnapshot({ hold_code: m.hold_code, outcome: res.outcome, contact_id: res.contactId, by_user_id: actor.userId, edited: Boolean(overrides.name || overrides.phone || overrides.email) }),
      reason: 'ACCEPTED',
    });
    const after = (await repo.messageById(tx, m.id))!;
    return { review: await reviewView(tx, deps, sys.tenantId, after), contactId: res.contactId, outcome: res.outcome };
  });
}

export async function discardReview(deps: LeadEmailDeps, actor: UserActor, id: string): Promise<{ review: ReviewView }> {
  return asSystem(deps, actor, async (tx, sys) => {
    await requireRole(tx, actor.userId, REVIEWERS);
    const m = await repo.messageById(tx, id, { forUpdate: true });
    if (!m) throw new AppError('NOT_FOUND');
    if (m.status !== 'needs_review') throw new AppError('LEAD_EMAIL_NOT_PENDING', { review: await reviewView(tx, deps, sys.tenantId, m) });
    await repo.decide(tx, m.id, { status: 'discarded', userId: actor.userId, contactId: null, inquiryId: null });
    await audit(tx, sys, { action: 'lead_email.review_discarded', entity: { type: 'lead_email_message', id: m.id }, changes: redactSnapshot({ hold_code: m.hold_code, by_user_id: actor.userId }), reason: 'DISCARDED' });
    const after = (await repo.messageById(tx, m.id))!;
    return { review: await reviewView(tx, deps, sys.tenantId, after) };
  });
}
