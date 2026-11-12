// Lead intake (BUILD_PLAN module 11; R-OWN-19…21, R-OWN-25, R-AST-16, A7d attribution, E8, E18–E20).
//
//   POST /intake/:sourceToken      a lead source posts one inquiry (signed: X-Realty-Signature, 'lead')
//   GET  /lead-sources             Owner/Admin
//   POST /lead-sources             Owner/Admin: a source and its ingest token (shown once; only sha256 stored)
//
// ingestInquiry, in ONE transaction as the system actor of the token's tenant (R-TEN-3: the tenant
// comes from app.resolve_lead_source, never from the body):
//   1 normalize phones/emails (core), HMAC them with the tenant key (no plaintext leaves the row)
//   2 app.lock_address for every identifier HMAC, the inquiry fingerprint and (source, external id),
//     sorted (global lock order step 1): two simultaneous inquiries for one new person serialize, so
//     the second sees the first's contact (E20) and a portal re-post sees the first post (E19)
//   3 inquiry duplicates (core inquiryDuplicate): same (source, external id) ⇒ the stored outcome,
//     nothing written; same fingerprint within 10 min ⇒ a `duplicate_ignored` inquiry row only
//   4 dedup (core matchContacts): exact phone/email ⇒ attach (earliest contact; the others become
//     duplicate candidates); name similarity ≥ 0.8 ⇒ candidates only, never an automatic merge
//   5 new person ⇒ ownership command `create via intake` (routing as the system actor: the offer, its
//     timer, the offer notification and its delivery rows commit in THIS transaction); the contact's
//     first-touch attribution (original_*) is copied from this inquiry and is immutable afterwards
//     attach ⇒ the contact lock (global lock order step 2), the inquiry row, then `reinquiry` where core's
//     reinquiryOutcome says the engine acts on it (R-OWN-20: an owned lead never changes owner; a pond lead
//     follows its pond setting; closed stays closed; an unassigned lead with no route due, which an import left
//     so and nothing would ever route, is routed like a returning lead: owner decision D8, 2026-11-12); on offer,
//     or unassigned awaiting the router, the inquiry is only attached and the router routes it once; so is one
//     from a person still in an import's creation state whose owners are to come (review D8-R1), which the import
//     replays once they are in (imports/replay.ts). A merge that landed after the match is followed (D8-R5).
//   6 the 60-second first response job (R-AST-16) is enqueued in this transaction for a new contact;
//     api/assistant's handler decides at send time whether anything may go out (approved playbook,
//     speed_to_lead_reply enabled, the lead has not opted out) and never counts as a touch (R-AST-15).
//   7 E38 / R-CONSENT-4: the consent language the person saw (the body's `consentDisclosure`, else the
//     source's configured disclosure) is stored and cited by the inquiry, and its grants are recorded
//     in the consent ledger (intakeConsent.ts) for new_contact / attached / reinquiry, never for a
//     duplicate. History only since D1: it changes nobody's sendability and never lifts an opt-out.
import { createHash, randomBytes } from 'node:crypto';
import { sha256Hex } from '@realty/core/compliance';
import type { ContactId, IdGenerator, Instant, LeadSourceId, SystemActor, TenantId } from '@realty/core/foundation';
import { MINUTE_MS, instantFromDate as instantOf, normalizeEmail, normalizePhone, toIso } from '@realty/core/foundation';
import {
  type DedupOutcome,
  type ExistingMatch,
  FINGERPRINT_WINDOW_MS,
  FUZZY_NAME_THRESHOLD,
  type InquiryType,
  MERGE_REDIRECT_MAX_DEPTH,
  addressLockOrder,
  inquiryDuplicate,
  inquiryFingerprint,
  matchContacts,
  reinquiryOutcome,
} from '@realty/core/ownership';
import { type Database, type Tx, applyOwnershipCommandInTx, derivedCommandId, enqueueJob, importOwnersPending, lockAddresses, lockContact, withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { systemActor } from '../worker/systemActor.js';
import { leadsTx, platformOf } from './common.js';
import * as contacts from './repos/contacts.js';
import * as repo from './repos/intake.js';
import { disclosureSourceKind, recordInquiryConsent, storeDisclosure } from './intakeConsent.js';
import { ConsentDisclosureInput, IntakeBody, IntakeResponse, LeadSourceCreatedResponse, LeadSourcesResponse } from './schemas.js';

export type InquiryOutcome = 'new_contact' | 'attached' | 'reinquiry' | 'duplicate_ignored';

/** One inquiry as a lead source sent it, plus the source the URL token resolved to. */
export type InquiryInput = z.input<typeof IntakeBody> & { leadSourceId: string };

export interface IntakeDeps {
  envelope: EnvelopeService;
  ids: IdGenerator;
  db?: Database;
}

export interface IngestResult {
  contactId: ContactId;
  outcome: InquiryOutcome;
  inquiryId: string | null;
}

/** The first-response job (R-AST-16). api/assistant registers its handler (`sendFirstResponse`). */
export const FIRST_RESPONSE_JOB = {
  kind: 'assistant.first_response',
  queue: 'realtime' as const,
  priority: 20,
  dedupeKey: (contactId: string) => `assistant.first_response:${contactId}`,
};

const INTENT: Record<InquiryType, 'buyer' | 'seller' | 'renter' | null> = { buy: 'buyer', sell: 'seller', rent: 'renter', value: 'seller', general: null };
const TYPE_LABEL: Record<InquiryType, string> = { buy: 'Buying', sell: 'Selling', rent: 'Renting', value: 'Home value', general: 'General inquiry' };

function money(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(d % 1_000_000 === 0 ? 0 : 1)}M`;
  if (d >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}

/**
 * The card narrative (contacts.pond_summary, ≤ 200 chars): the only text a pond or offer viewer
 * sees (R-PERM-6). Built from structured fields only (type, ZIP, price band), never from the free
 * text of the inquiry, which may carry names, numbers or addresses.
 */
export function cardSummary(i: { inquiryType: InquiryType; postalCode?: string | null; priceMinCents?: number | null; priceMaxCents?: number | null }): string {
  const parts = [TYPE_LABEL[i.inquiryType]];
  if (i.postalCode) parts.push(i.postalCode.slice(0, 5));
  const lo = i.priceMinCents ?? null;
  const hi = i.priceMaxCents ?? null;
  if (lo !== null && hi !== null) parts.push(lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`);
  else if (lo !== null) parts.push(`from ${money(lo)}`);
  else if (hi !== null) parts.push(`up to ${money(hi)}`);
  return parts.join(' · ').slice(0, 200);
}

interface Identifiers {
  phones: { e164: string; hmac: string }[];
  emails: { email: string; hmac: string }[];
  invalidPhones: number;
  invalidEmails: number;
}

/** Normalizes and HMAC-keys the identifiers (invalid ones are dropped and counted). */
export async function identifiersOf(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, phones: readonly string[], emails: readonly string[]): Promise<Identifiers> {
  const env = envelope.inTx(tx, tenantId);
  const out: Identifiers = { phones: [], emails: [], invalidPhones: 0, invalidEmails: 0 };
  const seen = new Set<string>();
  for (const raw of phones) {
    const n = normalizePhone(raw, 'US');
    if (!n.ok) {
      out.invalidPhones++;
      continue;
    }
    if (seen.has(n.e164)) continue;
    seen.add(n.e164);
    out.phones.push({ e164: n.e164, hmac: Buffer.from(await env.hmacAddress(tenantId, n.e164)).toString('hex') });
  }
  for (const raw of emails) {
    const n = normalizeEmail(raw);
    if (!n.ok) {
      out.invalidEmails++;
      continue;
    }
    if (seen.has(n.email)) continue;
    seen.add(n.email);
    out.emails.push({ email: n.email, hmac: Buffer.from(await env.hmacAddress(tenantId, n.email)).toString('hex') });
  }
  return out;
}

function personName(i: InquiryInput): { displayName: string | null; firstName: string | null; lastName: string | null } {
  const first = i.firstName?.trim() || null;
  const last = i.lastName?.trim() || null;
  const full = i.fullName?.trim() || null;
  if (first || last) return { displayName: full ?? [first, last].filter(Boolean).join(' '), firstName: first, lastName: last };
  if (full) {
    const parts = full.split(/\s+/);
    return { displayName: full, firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : full, lastName: parts.length > 1 ? parts[parts.length - 1]! : null };
  }
  return { displayName: null, firstName: null, lastName: null };
}

/** The receivedAt a source claims, if plausible (≤ 7 days old, ≤ 5 min ahead); else the DB clock. */
function receivedAtOf(claimed: string | undefined, now: Instant): Instant {
  if (!claimed) return now;
  const t = Date.parse(claimed);
  if (!Number.isFinite(t) || t > now + 5 * MINUTE_MS || t < now - 7 * 24 * 60 * MINUTE_MS) return now;
  return t as Instant;
}

/**
 * BUILD_PLAN interface: ingests one inquiry for the actor's tenant (one transaction, retried on
 * serialization failure / deadlock). Idempotent by (source, external id) and by fingerprint.
 */
export async function ingestInquiry(actor: SystemActor, input: InquiryInput, deps: IntakeDeps): Promise<IngestResult> {
  const parsed = IntakeBody.parse(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'leadSourceId')));
  const i: InquiryInput = { ...parsed, leadSourceId: input.leadSourceId };
  return withTenantTx(actor, (tx, now) => ingestInTx(tx, actor, i, now, deps), { retries: 3, ...(deps.db ? { db: deps.db } : {}) });
}

/** How a caller inside its own transaction (lead-email intake, module 22) shapes one inquiry. */
export interface IngestOptions {
  /**
   * false: no autonomous first response for a new contact. Used when a person accepted a held lead email
   * (R-INBOX-9: an email that was not verified never gets an autonomous reply; the agent replies themselves).
   */
  firstResponse?: boolean;
  /** a parsed lead email: lead_inquiries.parse_status 'parsed' with each field's source span (R-INBOX-9) */
  parse?: { status: 'parsed'; evidence: Record<string, unknown> };
  /**
   * Module 22 web chat (R-INBOX-1, E138): the session's own new chat identity (wc:<hex>, its tenant HMAC and the
   * point id to give it). The inquiry then carries no phone or email (what the visitor typed is only a claim on the
   * session), the fingerprint is the identity's HMAC (so two visitors who type the same name never collapse into one
   * contact), and the contact is always NEW: nothing matches an unseen identity, and a name match only suggests a
   * duplicate. The identity is the contact's only point.
   */
  webChat?: { address: string; hmac: string; pointId: string };
  /**
   * Module 22 tracked numbers (R-TRK-2): a new contact made from an unknown caller or texter is named and summarized
   * as today's unknown-caller path names it ("Unknown (415) 555-0100", "Called in"), and its phone point is labelled
   * 'mobile'. Used only when a new contact is created.
   */
  unknownCaller?: { displayName: string; pondSummary: string };
  /**
   * 'none' (module 22 tracked numbers, a Google form that does not show the source's text): the person saw no consent
   * text, so the inquiry cites none (consent_disclosure_id NULL) and no grant is recorded (R-CONSENT-4; history only, D1).
   */
  disclosure?: 'none';
  /**
   * Module 22 tracked numbers, matched path (R-TRK-3; b9 review ownership-data/F2): the contact the inbound call or text
   * was threaded on (conversation affinity among the records sharing the caller's phone). The inquiry attaches to
   * exactly that contact, never to the earliest exact match, so the record the gate checked (in a pond / unassigned) is
   * the record credited and routed. The caller already holds its address lock; the intake takes its contact lock.
   */
  attachTo?: string;
  /**
   * Module 22 tracked numbers (b9 review ownership-data/F6, R-PERM-6): the inquiry carries no structured facts (a
   * call or a text to a tracking number), so an attach keeps the contact's existing pond_summary instead of
   * replacing it with "General inquiry".
   */
  keepPondSummary?: boolean;
}

/**
 * The same intake, inside the caller's transaction, as the system actor of the caller's resolved tenant (lead email:
 * the inbox key resolver). Identical dedupe, routing (ownership engine), consent history and first response.
 */
export async function ingestInquiryInTx(tx: Tx, actor: SystemActor, input: InquiryInput, now: Instant, deps: IntakeDeps, opts: IngestOptions = {}): Promise<IngestResult> {
  const parsed = IntakeBody.parse(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'leadSourceId')));
  return ingestInTx(tx, actor, { ...parsed, leadSourceId: input.leadSourceId }, now, deps, opts);
}

interface IntakeKeys {
  inquiryType: InquiryType;
  idents: Identifiers;
  name: ReturnType<typeof personName>;
  person: { phoneHmacs: string[]; emailHmacs: string[]; displayName: string | null; postalCode: string | null };
  fingerprint: string;
  externalId: string | null;
  /** exactly the hex list ingestion passes to lockAddresses (global lock order step 1) */
  lockKeys: string[];
}

async function intakeKeys(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, leadSourceId: string, i: InquiryInput, opts: IngestOptions): Promise<IntakeKeys> {
  const inquiryType = (i.inquiryType ?? 'general') as InquiryType;
  const idents = await identifiersOf(tx, envelope, tenantId, i.phones ?? [], i.emails ?? []);
  const name = personName(i);
  const person = { phoneHmacs: idents.phones.map((p) => p.hmac), emailHmacs: idents.emails.map((e) => e.hmac), displayName: name.displayName, postalCode: i.postalCode ?? null };
  // E19: with no phone or email the fingerprint must still tell people apart, or every name-only
  // inquiry of one source and type inside 10 minutes would be "the same lead". The name (+ ZIP)
  // stands in, keyed with the tenant HMAC like an address so the stored fingerprint is not a plain
  // hash of a name.
  const fingerprintIds = [...person.phoneHmacs, ...person.emailHmacs, ...(opts.webChat ? [opts.webChat.hmac] : [])];
  if (fingerprintIds.length === 0 && name.displayName) {
    const key = `intake-name:${name.displayName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}|${(i.postalCode ?? '').slice(0, 5)}`;
    fingerprintIds.push(Buffer.from(await envelope.inTx(tx, tenantId).hmacAddress(tenantId, key)).toString('hex'));
  }
  const fingerprint = inquiryFingerprint({ leadSourceId, identifierHmacs: fingerprintIds, inquiryType });
  const externalId = i.externalId ?? null;
  const externalKey = externalId ? sha256Hex(`intake.external:${leadSourceId}:${externalId}`) : null;
  // Global lock order step 1 (sorted): identifiers, the fingerprint and the external id share one order.
  const lockKeys = [...addressLockOrder(person), fingerprint, ...(externalKey ? [externalKey] : [])];
  return { inquiryType, idents, name, person, fingerprint, externalId, lockKeys };
}

/**
 * Module 22 tracked numbers (R-TRK-2, E323/E324): the address-lock keys an inquiry's ingestion takes (identifier HMACs,
 * the fingerprint, the external key), so the inbound transaction takes them in ONE sorted lockAddresses call with the
 * caller's own address lock, before matching. Equal to what ingestInquiryInTx locks (intake.tracking test).
 */
export async function intakeLockKeys(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, input: InquiryInput, opts: IngestOptions = {}): Promise<string[]> {
  const parsed = IntakeBody.parse(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'leadSourceId')));
  const source = await repo.leadSource(tx, input.leadSourceId);
  return (await intakeKeys(tx, envelope, tenantId, source?.id ?? input.leadSourceId, { ...parsed, leadSourceId: input.leadSourceId }, opts)).lockKeys;
}

async function ingestInTx(tx: Tx, actor: SystemActor, i: InquiryInput, now: Instant, deps: IntakeDeps, opts: IngestOptions = {}): Promise<IngestResult> {
  const { ids, envelope } = deps;
  const source = await repo.leadSource(tx, i.leadSourceId);
  if (!source || !source.active) throw new AppError('NOT_FOUND');
  if (opts.webChat && ((i.phones ?? []).length > 0 || (i.emails ?? []).length > 0)) throw new AppError('INTERNAL_ERROR');
  const { inquiryType, idents, name, person, fingerprint, externalId, lockKeys } = await intakeKeys(tx, envelope, actor.tenantId, source.id, i, opts);
  if (!name.displayName && idents.phones.length === 0 && idents.emails.length === 0) throw new AppError('INQUIRY_EMPTY');
  if (i.priceMinCents !== undefined && i.priceMaxCents !== undefined && i.priceMinCents > i.priceMaxCents) {
    throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/priceMinCents', code: 'price_band' }] });
  }
  await lockAddresses(tx, lockKeys);
  const at = await dbNowAfterLocks(tx, now);
  const receivedAt = receivedAtOf(i.receivedAt, at);

  // 3 inquiry-level duplicates (E19)
  const prior = await repo.priorInquiries(tx, source.id, externalId, fingerprint, toIso((receivedAt - FINGERPRINT_WINDOW_MS) as Instant), toIso((receivedAt + FINGERPRINT_WINDOW_MS) as Instant));
  const dup = inquiryDuplicate(
    { leadSourceId: source.id, externalId, fingerprint, receivedAt },
    prior.map((p) => ({ leadSourceId: p.lead_source_id, externalId: p.external_id, fingerprint: p.fingerprint, receivedAt: instantOf(p.received_at) })),
  );
  if (dup === 'EXTERNAL_ID') {
    const first = prior.find((p) => p.external_id === externalId && p.lead_source_id === source.id)!;
    return { contactId: first.contact_id as ContactId, outcome: 'duplicate_ignored', inquiryId: first.id };
  }
  const rawPayloadEnc = async (inquiryId: string) =>
    envelope.inTx(tx, actor.tenantId).encrypt(actor.tenantId, { table: 'lead_inquiries', column: 'raw_payload_enc', rowId: inquiryId }, Buffer.from(JSON.stringify({ ...i, leadSourceId: undefined })));
  const noDisclosure = opts.disclosure === 'none';
  const inquiryRow = async (inquiryId: string, contactId: string, outcome: repo.InquiryInsert['outcome'], consentDisclosureId: string | null = noDisclosure ? null : source.consent_disclosure_id): Promise<repo.InquiryInsert> => ({
    id: inquiryId,
    contactId,
    leadSourceId: source.id,
    externalId,
    receivedAt: toIso(receivedAt),
    inquiryType,
    message: i.message ?? null,
    propertyText: i.propertyText ?? null,
    postalCode: i.postalCode ?? null,
    priceMinCents: i.priceMinCents ?? null,
    priceMaxCents: i.priceMaxCents ?? null,
    campaignRef: i.campaignRef ?? null,
    adRef: i.adRef ?? null,
    sourceDetail: i.sourceDetail ?? {},
    consentDisclosureId,
    rawPayloadEnc: await rawPayloadEnc(inquiryId),
    fingerprint,
    outcome,
    ...(opts.parse ? { parseStatus: opts.parse.status, parseEvidence: opts.parse.evidence } : {}),
  });
  if (dup === 'FINGERPRINT') {
    const first = prior.find((p) => p.fingerprint === fingerprint)!;
    const inquiryId = ids.next<'LeadInquiryId'>();
    await repo.insertInquiry(tx, await inquiryRow(inquiryId, first.contact_id, 'duplicate_ignored'));
    return { contactId: first.contact_id as ContactId, outcome: 'duplicate_ignored', inquiryId };
  }

  // 4 dedup (R-OWN-25)
  const existing: ExistingMatch[] = [];
  const byContact = new Map<string, ExistingMatch>();
  for (const m of await repo.exactMatches(tx, [...person.phoneHmacs, ...person.emailHmacs])) {
    const prev = byContact.get(m.contact_id);
    if (prev) (prev.matchedHmacs as string[]).push(m.hmac);
    else byContact.set(m.contact_id, { contactId: m.contact_id as ContactId, createdAt: instantOf(m.created_at), ownershipState: m.ownership_state, closedReason: m.closed_reason, matchedHmacs: [m.hmac] });
  }
  existing.push(...byContact.values());
  if (name.displayName) {
    for (const f of await repo.fuzzyMatches(tx, name.displayName, i.postalCode ?? null, FUZZY_NAME_THRESHOLD)) {
      existing.push({ contactId: f.contact_id as ContactId, createdAt: instantOf(f.created_at), ownershipState: f.ownership_state, closedReason: f.closed_reason, matchedHmacs: [], nameSimilarity: f.sim, samePostal: f.same_postal });
    }
  }
  const matched: DedupOutcome = matchContacts(person, existing);
  // web chat: an unseen identity never attaches (a name match is only a suggestion, R-INBOX-1)
  const decision: DedupOutcome = opts.webChat && matched.kind !== 'create'
    ? { kind: 'create', duplicates: matched.duplicates }
    : opts.attachTo
      ? { kind: 'attach', contactId: opts.attachTo as ContactId, matchedBy: ['phone'], duplicates: [] }
      : matched;

  let isNewCaller = false;
  const addPoints = async (contactId: string) => {
    if (opts.webChat) await contacts.addPoint(tx, { id: opts.webChat.pointId, contactId, kind: 'web_chat', address: opts.webChat.address, hmacHex: opts.webChat.hmac });
    for (const p of idents.phones) await contacts.addPoint(tx, { id: ids.next(), contactId, kind: 'phone', address: p.e164, hmacHex: p.hmac, ...(isNewCaller ? { label: 'mobile' } : {}) });
    for (const e of idents.emails) await contacts.addPoint(tx, { id: ids.next(), contactId, kind: 'email', address: e.email, hmacHex: e.hmac });
  };
  const addCandidates = async (contactId: string) => {
    // (a merge followed under the lock may have made one of them the record attached to)
    for (const d of decision.duplicates) if (d.contactId !== contactId) await contacts.addDuplicateCandidate(tx, ids.next(), contactId, d.contactId, d.reason);
  };
  // 7 E38: the disclosure this inquiry carries (stored once per text), and its ledger grants
  const disclosure = noDisclosure
    ? null
    : i.consentDisclosure
    ? await storeDisclosure(tx, ids, i.consentDisclosure, disclosureSourceKind(source.kind))
    : source.consent_disclosure_id
      ? await repo.disclosureById(tx, source.consent_disclosure_id)
      : null;
  const recordConsent = async (contactId: string, inquiryId: string) => {
    if (!disclosure) return;
    // the person acted when they submitted; never a future instant (a future grant would not count yet)
    const occurredAt = Math.min(receivedAt, at) as Instant;
    await recordInquiryConsent(tx, { ids, disclosure, occurredAt, contactId, inquiryId, leadSourceId: source.id, phones: idents.phones, emails: idents.emails });
  };
  const summary = cardSummary({ inquiryType, postalCode: i.postalCode ?? null, priceMinCents: i.priceMinCents ?? null, priceMaxCents: i.priceMaxCents ?? null });

  if (decision.kind === 'create') {
    // 5 a new person: create via intake (system routing inside this transaction)
    const contactId = ids.next<'ContactId'>();
    const inquiryId = ids.next<'LeadInquiryId'>();
    isNewCaller = opts.unknownCaller !== undefined;
    const res = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'create', via: 'intake' }, {
      commandId: derivedCommandId('intake.create', inquiryId),
      ids,
      newContact: {
        displayName: name.displayName ?? opts.unknownCaller?.displayName ?? 'New lead',
        firstName: name.firstName,
        lastName: name.lastName,
        intent: INTENT[inquiryType],
        pondSummary: opts.unknownCaller?.pondSummary ?? summary,
        originalLeadSourceId: source.id,
        originalCampaignRef: i.campaignRef ?? null,
        originalAdRef: i.adRef ?? null,
        originalSourceDetail: i.sourceDetail ?? {},
      },
      inquiry: { inquiryId, leadSourceId: source.id as LeadSourceId, inquiryType, postalCode: i.postalCode ?? null, priceMinCents: i.priceMinCents ?? null, priceMaxCents: i.priceMaxCents ?? null },
    });
    if (!res.outcome.ok) throw new AppError('INTERNAL_ERROR');
    await addPoints(contactId);
    await repo.insertInquiry(tx, await inquiryRow(inquiryId, contactId, 'new_contact', disclosure?.id ?? null));
    await recordConsent(contactId, inquiryId);
    await addCandidates(contactId);
    // 6 R-AST-16: the first response job, in the intake transaction (ids only in the payload)
    if (opts.firstResponse !== false) {
      await enqueueJob(tx, { queue: FIRST_RESPONSE_JOB.queue, kind: FIRST_RESPONSE_JOB.kind, priority: FIRST_RESPONSE_JOB.priority, payload: { contactId }, dedupeKey: FIRST_RESPONSE_JOB.dedupeKey(contactId) });
    }
    return { contactId, outcome: 'new_contact', inquiryId };
  }

  // attach to the earliest exact match (E18). The contact lock first (global lock order step 2, after the addresses):
  // every ownership change takes it, so the state read here is the one the engine decides on below, and a second
  // inquiry of the same person by another address waits here and sees what this one did (E342)
  let contactId = decision.contactId;
  await lockContact(tx, contactId);
  let st = await repo.contactState(tx, contactId);
  // The match was read before that lock. A merge that committed in between closed the matched record as merged: the
  // inquiry follows the person to the record they live on now (R-OWN-20's merge redirect, at most
  // MERGE_REDIRECT_MAX_DEPTH hops), under that record's lock (review D8-R5)
  for (let hops = 0; st !== null && st.closed_reason === 'merged' && st.merged_into_contact_id !== null && hops < MERGE_REDIRECT_MAX_DEPTH; hops++) {
    contactId = st.merged_into_contact_id as ContactId;
    await lockContact(tx, contactId);
    st = await repo.contactState(tx, contactId);
  }
  if (!st || st.closed_reason === 'merged') throw new AppError('INTERNAL_ERROR'); // a redirect chain past R-OWN-20's limit
  // R-OWN-20 / owner decision D8: core says whether the engine acts on it or the inquiry is only attached; a person
  // still in an import's creation state whose owners are to come waits for them (review D8-R1: the import replays it)
  const seq = Number(st.ownership_seq);
  const routeDueAt = st.route_due_at === null ? null : instantOf(st.route_due_at);
  const ownersPending = st.ownership_state === 'unassigned' && routeDueAt === null && seq === 1 && (await importOwnersPending(tx, contactId));
  const outcome = reinquiryOutcome({ state: st.ownership_state, routeDueAt, seq }, { ownersPending });
  const reinquiry = outcome === 'reinquiry';
  const inquiryId = ids.next<'LeadInquiryId'>();
  await addPoints(contactId);
  await repo.insertInquiry(tx, await inquiryRow(inquiryId, contactId, outcome, disclosure?.id ?? null));
  await recordConsent(contactId, inquiryId);
  await addCandidates(contactId);
  if (st.ownership_state !== 'owned' && st.ownership_state !== 'closed' && !opts.keepPondSummary) await repo.setPondSummary(tx, contactId, summary);
  else if (st.ownership_state !== 'owned' && st.ownership_state !== 'closed') await repo.setPondSummary(tx, contactId, summary, { onlyIfEmpty: true });
  if (reinquiry) {
    // routing (a pond re-route, an unassigned lead with no route due) matches the rules on this inquiry's row
    const r = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'reinquiry', inquiryId }, { commandId: derivedCommandId('intake.reinquiry', inquiryId), ids });
    // decided on the row read above under this contact's lock, a live record (merges were followed): a refusal is a bug
    if (!r.outcome.ok) throw new AppError('INTERNAL_ERROR');
  }
  return { contactId, outcome, inquiryId };
}

async function dbNowAfterLocks(tx: Tx, fallback: Instant): Promise<Instant> {
  const r = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
  return r.rows[0] ? instantOf(r.rows[0].now) : fallback;
}

// ---- routes ------------------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** app.resolve_lead_source (pre-tenant definer): token → tenant + source, or null (unknown / inactive). */
async function resolveSource(db: Database, token: string): Promise<{ tenantId: string; leadSourceId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return withPreTenant(
    async (tx) => {
      const r = await sql<{ tenant_id: string; lead_source_id: string }>`SELECT * FROM app.resolve_lead_source(${sha256(token)})`.execute(tx);
      const row = r.rows[0];
      return row ? { tenantId: row.tenant_id, leadSourceId: row.lead_source_id } : null;
    },
    { db },
  );
}

async function recordUnrouted(db: Database, ids: IdGenerator, now: Instant): Promise<void> {
  const id = ids.next<'WebhookEventId'>();
  await withPreTenant(
    async (tx) => {
      await sql`SELECT app.record_webhook_event(${id}::uuid, 'lead', ${`unrouted:${id}`}, NULL, true, NULL, ${toIso(now)}::timestamptz)`.execute(tx);
    },
    { db },
  );
}

const SOURCE_KINDS = ['portal', 'website', 'referral', 'sphere', 'open_house', 'ads', 'sign_call', 'manual', 'other'] as const;

export async function registerIntakeRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/intake/:sourceToken',
    {
      // the source's own signing secret when it has one, else the deployment secret (R-LSRC-3; leads/webhookAuth.ts)
      config: { auth: 'webhook', webhookProvider: 'lead', webhookAuth: 'lead_source' },
      schema: { params: z.object({ sourceToken: z.string().max(200) }), body: IntakeBody, response: { 200: IntakeResponse, 201: IntakeResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const resolved = await resolveSource(p.db, req.params.sourceToken);
      if (!resolved) {
        // unknown or inactive source: an unrouted record for the platform, no tenant row (ARCHITECTURE §3)
        await recordUnrouted(p.db, p.ids, p.clock.now());
        throw new AppError('NOT_FOUND');
      }
      const actor = systemActor(resolved.tenantId, 'provider');
      const res = await ingestInquiry(actor, { ...req.body, leadSourceId: resolved.leadSourceId }, { envelope: p.envelope, ids: p.ids, db: p.db });
      reply.status(res.outcome === 'new_contact' ? 201 : 200);
      return { contactId: res.contactId, inquiryId: res.inquiryId, outcome: res.outcome };
    },
  );

  const auth = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };
  const view = (s: repo.LeadSourceRow & { has_token: boolean; created_at: Date }) => ({ id: s.id, name: s.name, kind: s.kind, active: s.active, hasToken: s.has_token, createdAt: s.created_at.toISOString() });

  r.get('/lead-sources', { ...auth, schema: { response: { 200: LeadSourcesResponse } } }, async (req) => leadsTx(req, async (tx) => ({ sources: (await repo.listLeadSources(tx)).map(view) })));

  r.post(
    '/lead-sources',
    {
      ...auth,
      schema: {
        // consentDisclosure: the consent text this source shows people (E38), recorded for its inquiries that carry none
        body: z.strictObject({ name: z.string().trim().min(1).max(80), kind: z.enum(SOURCE_KINDS), consentDisclosure: ConsentDisclosureInput.optional() }),
        response: { 201: LeadSourceCreatedResponse },
      },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const token = randomBytes(32).toString('base64url');
      const id = p.ids.next<'LeadSourceId'>();
      const created = await leadsTx(req, async (tx, _now, actor) => {
        const disclosureId = req.body.consentDisclosure ? (await storeDisclosure(tx, p.ids, req.body.consentDisclosure, disclosureSourceKind(req.body.kind))).id : null;
        try {
          await repo.insertLeadSource(tx, id, req.body.name, req.body.kind, sha256(token), disclosureId);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('VERSION_CONFLICT', { field: 'name' });
          throw e;
        }
        await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id }, changes: redactSnapshot({ kind: req.body.kind, active: true, consentDisclosureId: disclosureId }, { entity: 'lead_source' }), reason: 'LEAD_SOURCE_CREATED' });
        return (await repo.listLeadSources(tx)).find((s) => s.id === id)!;
      });
      reply.status(201);
      return { source: view(created), ingestToken: token, intakePath: `/api/intake/${token}` };
    },
  );
}
