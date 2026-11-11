// Follow Up Boss normalization (BUILD_PLAN module 6; R-IMPORT-1, R-IMPORT-7, R-IMPORT-8 (core part),
// R-IMPORT-12 (labels), R-CONSENT-3, E40).
//
// Input is one raw object from the encrypted snapshot (never live FUB, R-IMPORT-1): a person, note,
// text message, email or call as the FUB REST API returns it. The schemas below are deliberately
// tolerant (unknown keys pass through, ids may be numbers or strings): FUB adds fields over time and
// a migration must not fail on them. The field names follow the public FUB API (people, notes,
// textMessages, emails, calls, users); the consent-indicator fields (`smsOptIn`, `doNotText`, …)
// and the point `status` vocabulary are assumptions that MUST be checked against a real account's
// export before go-live (reported as a gap; the golden fixtures pin today's assumptions).
//
// What goes where:
// - typed columns: names, phones, emails, addresses, tags, stage (mapped), source label;
// - `imported_fields` (display-only): every `custom*` field, the original FUB stage, source URL,
//   background, price — nothing from there is ever used for logic (ARCHITECTURE §18);
// - consent indicators: only through the consent stage (`mapImportedConsent` caps every grant);
// - assignment: only through the ownership stage, with a complete user mapping (R-IMPORT-8).
import { z } from 'zod';
import { type Instant, instantFromIso } from '../foundation/index.js';
import type { Channel } from '../compliance/index.js';
import { collectEmails, collectPhones, collectTags, finish, mapStage, putImportedField } from './csv.js';
import { cleanBody, lineField } from './text.js';
import type {
  Category,
  FubConsentFields,
  ImportTarget,
  ImportedAddressConsent,
  Issue,
  NormalizedAddress,
  NormalizedCall,
  NormalizedConsent,
  NormalizedContact,
  NormalizedMessage,
  NormalizedNote,
  NormalizedOwnership,
  NormalizedRecord,
  PointLabel,
  PointStatus,
  RecordOutcome,
  UserMapping,
} from './types.js';

// ---- raw schemas ----------------------------------------------------------------------------------

const Id = z.union([z.string().trim().min(1).max(200), z.number().int().nonnegative()]).transform((v) => String(v));
const Str = z.string().nullish();
const Flag = z.union([z.boolean(), z.number(), z.string()]).nullish();

const FubPoint = z.looseObject({ value: z.string(), type: Str, status: Str, isPrimary: Flag });
const FubAddress = z.looseObject({ type: Str, street: Str, city: Str, state: Str, code: Str, country: Str });

export const FubPersonSchema = z.looseObject({
  id: Id,
  created: Str,
  updated: Str,
  name: Str,
  firstName: Str,
  lastName: Str,
  stage: Str,
  source: Str,
  sourceUrl: Str,
  type: Str,
  background: Str,
  price: z.union([z.number(), z.string()]).nullish(),
  assignedUserId: Id.nullish(),
  assignedTo: Str,
  assignedPondId: Id.nullish(),
  tags: z.array(z.string()).nullish(),
  emails: z.array(FubPoint).nullish(),
  phones: z.array(FubPoint).nullish(),
  addresses: z.array(FubAddress).nullish(),
  // Consent indicators (assumed names; VERIFY against a real FUB export).
  smsOptIn: Flag,
  textOptIn: Flag,
  emailOptIn: Flag,
  callOptIn: Flag,
  unsubscribed: Flag,
  doNotContact: Flag,
  doNotCall: Flag,
  doNotText: Flag,
  doNotEmail: Flag,
});
export type FubPerson = z.infer<typeof FubPersonSchema>;

export const FubNoteSchema = z.looseObject({
  id: Id,
  personId: Id,
  subject: Str,
  body: Str,
  isHtml: Flag,
  created: z.string(),
  createdById: Id.nullish(),
});

export const FubTextMessageSchema = z.looseObject({
  id: Id,
  personId: Id,
  created: z.string(),
  isIncoming: Flag,
  message: z.string(),
  status: Str,
  userId: Id.nullish(),
});

export const FubEmailSchema = z.looseObject({
  id: Id,
  personId: Id,
  created: z.string(),
  isIncoming: Flag,
  subject: Str,
  body: z.string(),
  isHtml: Flag,
  status: Str,
  userId: Id.nullish(),
});

export const FubCallSchema = z.looseObject({
  id: Id,
  personId: Id,
  created: z.string(),
  isIncoming: Flag,
  duration: z.union([z.number(), z.string()]).nullish(),
  outcome: Str,
  note: Str,
  userId: Id.nullish(),
  recordingUrl: Str,
});

// ---- helpers ----------------------------------------------------------------------------------------

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'yes', 'y', '1'].includes(v.trim().toLowerCase());
  return false;
}

function rejected<T>(sourceRef: string, issues: Issue[]): RecordOutcome<T> {
  return { sourceRef, status: 'rejected', record: null, issues };
}

const outcome = finish;

/** Source refs (import_records.source_ref, UQ per stage): the FUB collection and id. */
export function fubSourceRef(collection: 'people' | 'notes' | 'textMessages' | 'emails' | 'calls', id: string): string {
  return `fub:${collection}/${id}`;
}

function rawId(raw: unknown): string {
  if (raw !== null && typeof raw === 'object') {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id).slice(0, 200);
  }
  return 'unknown';
}

function parseTime(s: string | null | undefined, field: string, issues: Issue[]): Instant | null {
  if (s === null || s === undefined || s.trim() === '') return null;
  const t = instantFromIso(s.trim());
  if (t === null) issues.push({ code: 'TIMESTAMP_INVALID', severity: 'error', field });
  return t;
}

function pointLabel(type: string | null | undefined): PointLabel {
  const t = (type ?? '').toLowerCase();
  if (/mobile|cell/.test(t)) return 'mobile';
  if (/home/.test(t)) return 'home';
  if (/work|office|business/.test(t)) return 'work';
  return 'other';
}

const OPT_OUT_STATUS = /opt(ed)?[\s_-]*out|unsubscrib|do[\s_-]*not|stop/i;
const INVALID_STATUS = /^(not[\s_-]*valid|invalid|bad|wrong)/i;

function pointStatus(kind: 'phone' | 'email', status: string | null | undefined): PointStatus {
  const s = (status ?? '').trim();
  if (INVALID_STATUS.test(s)) return /wrong/i.test(s) ? 'wrong_number' : 'invalid';
  if (kind === 'email' && /bounc/i.test(s)) return 'bouncing';
  return 'active';
}

/** FUB HTML bodies → plain text (tags removed, line breaks kept, common entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}

export const MAX_BODY = 20_000;

function body(raw: string, isHtml: boolean, field: string, issues: Issue[]): string | null {
  let b = cleanBody(isHtml ? htmlToText(raw) : raw);
  if (b === '') {
    issues.push({ code: 'BODY_EMPTY', severity: 'error' });
    return null;
  }
  if (b.length > MAX_BODY) {
    b = b.slice(0, MAX_BODY);
    issues.push({ code: 'BODY_TOO_LONG', severity: 'review', field });
  }
  return b;
}

/** The local user for a FUB user id, when the mapping sends it to a user (authors, call agents). */
function userFor(id: string | null | undefined, users: UserMapping): NormalizedNote['authorUserId'] {
  if (id === null || id === undefined) return null;
  const t = users.users.get(id);
  return t !== undefined && t !== 'unassigned' && 'userId' in t ? t.userId : null;
}

function primaryFirst<T extends { isPrimary?: unknown }>(points: readonly T[]): T[] {
  return [...points].sort((a, b) => Number(truthy(b.isPrimary)) - Number(truthy(a.isPrimary)));
}

// ---- per category ---------------------------------------------------------------------------------

function mapPerson(raw: unknown): { person: FubPerson } | { fail: RecordOutcome<never> } {
  const p = FubPersonSchema.safeParse(raw);
  if (!p.success) return { fail: rejected(fubSourceRef('people', rawId(raw)), [{ code: 'RECORD_MALFORMED', severity: 'error' }]) };
  return { person: p.data };
}

function mapContact(person: FubPerson): RecordOutcome<NormalizedContact> {
  const sourceRef = fubSourceRef('people', person.id);
  const issues: Issue[] = [];
  const firstName = lineField(person.firstName, 'firstName', 200, issues);
  const lastName = lineField(person.lastName, 'lastName', 200, issues);
  const name = lineField(person.name, 'name', 200, issues);
  const phones = collectPhones(
    primaryFirst(person.phones ?? []).map((p) => ({ raw: p.value, label: pointLabel(p.type), field: 'phones', status: pointStatus('phone', p.status) })),
    'US',
    issues,
  );
  const emails = collectEmails(
    primaryFirst(person.emails ?? []).map((e) => ({ raw: e.value, label: pointLabel(e.type), field: 'emails', status: pointStatus('email', e.status) })),
    issues,
  );

  const tags = collectTags(person.tags ?? [], issues);
  const stageLabel = lineField(person.stage, 'stage', 200, issues);
  const stage = mapStage(stageLabel, issues, 'stage');

  const importedFields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (stageLabel !== null) putImportedField(importedFields, 'FUB stage', stageLabel, issues);
  if (person.source) putImportedField(importedFields, 'FUB source', person.source, issues);
  if (person.sourceUrl) putImportedField(importedFields, 'FUB source URL', person.sourceUrl, issues);
  if (person.type) putImportedField(importedFields, 'FUB type', person.type, issues);
  if (person.background) putImportedField(importedFields, 'FUB background', person.background, issues);
  if (person.price !== null && person.price !== undefined) putImportedField(importedFields, 'FUB price', String(person.price), issues);
  if (person.assignedTo) putImportedField(importedFields, 'FUB assigned to', person.assignedTo, issues);
  const customFields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(person)) {
    if (!/^custom[A-Z0-9_]/.test(k) || v === null || v === undefined) continue;
    const text = Array.isArray(v) ? v.filter((x) => typeof x !== 'object').join(', ') : typeof v === 'object' ? '' : String(v);
    if (text !== '') {
      putImportedField(importedFields, k, text, issues);
      if (Object.keys(customFields).length < 100) customFields[k] = text.trim().slice(0, 2000);
    }
  }

  const addresses: NormalizedAddress[] = [];
  for (const a of person.addresses ?? []) {
    const line1 = lineField(a.street, 'addresses', 500, issues);
    const city = lineField(a.city, 'addresses', 200, issues);
    const regionRaw = lineField(a.state, 'addresses', 100, issues);
    const region = regionRaw !== null && /^[a-z]{2}$/i.test(regionRaw) ? regionRaw.toUpperCase() : regionRaw;
    const code = lineField(a.code, 'addresses', 20, issues);
    const zip = code === null ? null : /^\d{5}(-\d{4})?$/.test(code) ? code : /^\d{4}$/.test(code) ? `0${code}` : null;
    if (code !== null && zip === null) issues.push({ code: 'POSTAL_INVALID', severity: 'error', field: 'addresses' });
    if (line1 === null && city === null && region === null && zip === null) continue;
    const country = (a.country ?? '').trim();
    addresses.push({
      kind: /mail/i.test(a.type ?? '') ? 'mailing' : /prop|invest/i.test(a.type ?? '') ? 'property' : 'home',
      line1,
      line2: null,
      city,
      region,
      postalCode: zip,
      country: /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : 'US',
    });
  }

  const named = [firstName, lastName].filter((x): x is string => x !== null).join(' ');
  const displayName = (named !== '' ? named : null) ?? name ?? emails[0]?.email ?? phones[0]?.e164 ?? null;
  if (displayName === null) return rejected(sourceRef, [...issues, { code: 'NO_IDENTITY', severity: 'error' }]);
  if (named === '' && name === null) issues.push({ code: 'NAME_MISSING', severity: 'info' });
  const createdAt = parseTime(person.created, 'created', issues);

  return outcome(sourceRef, {
    category: 'contacts',
    sourceRef,
    externalId: person.id,
    firstName: firstName ?? (named === '' && name !== null ? (name.split(' ')[0] as string) : null),
    lastName: lastName ?? (named === '' && name !== null && name.includes(' ') ? name.split(' ').slice(1).join(' ') : null),
    displayName,
    contactType: stage.type ?? 'lead',
    stage: stage.stage,
    intent: null,
    phones,
    emails,
    addresses,
    tags,
    importedFields: { ...importedFields },
    leadSourceLabel: person.source ? lineField(person.source, 'source', 500, []) : null,
    createdAt,
    ...(stageLabel !== null ? { stageLabel } : {}),
    ...(Object.keys(customFields).length > 0 ? { customFields: { ...customFields } } : {}),
  }, issues);
}

/** R-IMPORT-8 (core part): the target of a person's FUB assignment through the user mapping. */
function mapOwnership(person: FubPerson, users: UserMapping): RecordOutcome<NormalizedOwnership> {
  const sourceRef = fubSourceRef('people', person.id);
  let target: ImportTarget | undefined;
  if (person.assignedUserId !== null && person.assignedUserId !== undefined) {
    target = users.users.get(person.assignedUserId);
    if (target === undefined) return rejected(sourceRef, [{ code: 'USER_UNMAPPED', severity: 'error' }]);
  } else if (person.assignedPondId !== null && person.assignedPondId !== undefined) {
    target = users.ponds?.get(person.assignedPondId);
    if (target === undefined) return rejected(sourceRef, [{ code: 'USER_UNMAPPED', severity: 'error' }]);
  } else target = 'unassigned';
  return outcome(sourceRef, { category: 'ownership', sourceRef, personRef: person.id, target }, []);
}

const TAG_DNC = /^(dnc|do[\s_-]*not[\s_-]*(contact|call))$/i;
const TAG_OPT_OUT = /^(opted[\s_-]*out|opt[\s_-]*out|stop)$/i;
const TAG_UNSUB = /^unsubscribed$/i;

// eslint-disable-next-line no-control-regex -- control characters are what gets removed
const OPT_OUT_STRIP_RE = /[\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f-\u009f]/gu;

/**
 * The texts an imported tag is tested as for the opt-out conversion: as written (trimmed), and folded the way
 * the tag catalog folds it (invisible and control characters out, NFKC, whitespace collapsed), so a tag that
 * shows as "DNC" is always honoured as DNC.
 */
export function optOutTagForms(raw: string): string[] {
  const t = String(raw).trim();
  const folded = t.normalize('NFKC').replace(OPT_OUT_STRIP_RE, '').replace(/\s+/gu, ' ').trim();
  return folded === t ? [t] : [t, folded];
}

/**
 * R-CONSENT-3 / E40: the person's consent indicators. Positive flags become grants (capped at
 * `imported_unverified` by `mapImportedConsent`); point statuses and flags that say opted out,
 * unsubscribed or do-not-contact become revocations / suppressions; a tag that plainly says "DNC",
 * "Opted out" or "Unsubscribed" is honoured too (strictest reading, flagged TAG_READ_AS_OPT_OUT).
 */
function mapConsent(person: FubPerson): RecordOutcome<NormalizedConsent> {
  const sourceRef = fubSourceRef('people', person.id);
  const issues: Issue[] = [];
  // each tag both as written and as the catalog will store it (security review: "D\u200BNC" or full-width
  // "ＤＮＣ" lands in the catalog as "DNC", so it must also be honoured as DNC)
  const tags = (person.tags ?? []).flatMap((t) => optOutTagForms(t));
  const dncTag = tags.some((t) => TAG_DNC.test(t));
  const optOutTag = tags.some((t) => TAG_OPT_OUT.test(t));
  const unsubTag = tags.some((t) => TAG_UNSUB.test(t));
  if (dncTag || optOutTag || unsubTag) issues.push({ code: 'TAG_READ_AS_OPT_OUT', severity: 'info', field: 'tags' });
  const dnc = truthy(person.doNotContact) || dncTag;
  const smsGrant = truthy(person.smsOptIn) || truthy(person.textOptIn);
  const voiceGrant = truthy(person.callOptIn);
  const emailGrant = truthy(person.emailOptIn);

  const addresses: ImportedAddressConsent[] = [];
  const pointEvidence: { kind: 'phone' | 'email'; type: string | null; status: string | null }[] = [];
  for (const p of person.phones ?? []) {
    const n = collectPhones([{ raw: p.value, label: 'other', field: 'phones' }], 'US', []);
    const e164 = n[0]?.e164;
    if (e164 === undefined || addresses.some((a) => a.address === e164)) continue;
    pointEvidence.push({ kind: 'phone', type: p.type ?? null, status: p.status ?? null });
    const statusOptOut = OPT_OUT_STATUS.test(p.status ?? '');
    const revokes = new Set<Channel>();
    if (statusOptOut || truthy(person.doNotText) || optOutTag) revokes.add('sms');
    if (truthy(person.doNotCall) || optOutTag) revokes.add('voice');
    const grants = ([smsGrant ? 'sms' : null, voiceGrant ? 'voice' : null] as (Channel | null)[]).filter((c): c is Channel => c !== null && !revokes.has(c));
    if (grants.length < (smsGrant ? 1 : 0) + (voiceGrant ? 1 : 0)) issues.push({ code: 'CONSENT_CONFLICT', severity: 'info' });
    addresses.push({ kind: 'phone', address: e164, grants, revokes: [...revokes], doNotContact: dnc });
  }
  for (const e of person.emails ?? []) {
    const n = collectEmails([{ raw: e.value, label: 'other', field: 'emails' }], []);
    const email = n[0]?.email;
    if (email === undefined || addresses.some((a) => a.address === email)) continue;
    pointEvidence.push({ kind: 'email', type: e.type ?? null, status: e.status ?? null });
    const revoke = OPT_OUT_STATUS.test(e.status ?? '') || truthy(person.unsubscribed) || truthy(person.doNotEmail) || unsubTag || optOutTag;
    if (revoke && emailGrant) issues.push({ code: 'CONSENT_CONFLICT', severity: 'info' });
    addresses.push({ kind: 'email', address: email, grants: emailGrant && !revoke ? ['email'] : [], revokes: revoke ? ['email'] : [], doNotContact: dnc });
  }
  const relevant = addresses.filter((a) => a.grants.length > 0 || a.revokes.length > 0 || a.doNotContact);
  if (relevant.length === 0) issues.push({ code: 'NO_CONSENT_DATA', severity: 'info' });
  const t = parseTime(person.updated ?? person.created, person.updated ? 'updated' : 'created', []);
  const fields: FubConsentFields = { addresses: relevant, occurredAt: t };
  const flags: Record<string, unknown> = {};
  for (const k of ['smsOptIn', 'textOptIn', 'emailOptIn', 'callOptIn', 'unsubscribed', 'doNotContact', 'doNotCall', 'doNotText', 'doNotEmail'] as const) {
    if (person[k] !== null && person[k] !== undefined) flags[k] = person[k];
  }
  const provenance: Record<string, unknown> = {
    source: 'fub',
    personId: person.id,
    flags,
    points: pointEvidence,
    tags: tags.filter((x) => TAG_DNC.test(x) || TAG_OPT_OUT.test(x) || TAG_UNSUB.test(x)),
    updated: person.updated ?? null,
  };
  return outcome(sourceRef, { category: 'consent', sourceRef, personRef: person.id, fields, provenance }, issues);
}

function mapNote(raw: unknown, users: UserMapping): RecordOutcome<NormalizedNote> {
  const p = FubNoteSchema.safeParse(raw);
  if (!p.success) return rejected(fubSourceRef('notes', rawId(raw)), [{ code: 'RECORD_MALFORMED', severity: 'error' }]);
  const n = p.data;
  const sourceRef = fubSourceRef('notes', n.id);
  const issues: Issue[] = [];
  const occurredAt = parseTime(n.created, 'created', issues);
  const subject = n.subject ? cleanBody(n.subject) : '';
  const text = body([subject, n.body ?? ''].filter((s) => s !== '').join('\n\n'), truthy(n.isHtml), 'body', issues);
  if (occurredAt === null) issues.push({ code: 'RECORD_MALFORMED', severity: 'error' });
  if (text === null || occurredAt === null) return rejected(sourceRef, issues);
  return outcome(sourceRef, { category: 'notes', sourceRef, externalId: n.id, personRef: n.personId, body: text, authorUserId: userFor(n.createdById, users), occurredAt }, issues);
}

function outboundStatus(s: string | null | undefined): NormalizedMessage['status'] {
  const v = (s ?? '').toLowerCase();
  if (/undeliver/.test(v)) return 'undelivered';
  if (/deliver/.test(v)) return 'delivered';
  if (/bounc/.test(v)) return 'bounced';
  if (/fail|error/.test(v)) return 'failed';
  return 'sent';
}

function mapMessage(raw: unknown, users: UserMapping): RecordOutcome<NormalizedMessage> {
  const isEmail = raw !== null && typeof raw === 'object' && 'body' in raw && !('message' in raw);
  const collection = isEmail ? 'emails' : 'textMessages';
  let m: { id: string; personId: string; created: string; isIncoming?: unknown; status?: string | null; userId?: string | null; text: string; html: boolean; subject: string | null };
  if (isEmail) {
    const p = FubEmailSchema.safeParse(raw);
    if (!p.success) return rejected(fubSourceRef(collection, rawId(raw)), [{ code: 'RECORD_MALFORMED', severity: 'error' }]);
    m = { ...p.data, text: p.data.body, html: truthy(p.data.isHtml), subject: p.data.subject ?? null };
  } else {
    const p = FubTextMessageSchema.safeParse(raw);
    if (!p.success) return rejected(fubSourceRef(collection, rawId(raw)), [{ code: 'RECORD_MALFORMED', severity: 'error' }]);
    m = { ...p.data, text: p.data.message, html: false, subject: null };
  }
  const sourceRef = fubSourceRef(collection, m.id);
  const issues: Issue[] = [];
  const occurredAt = parseTime(m.created, 'created', issues);
  const text = body(m.text, m.html, 'body', issues);
  if (occurredAt === null) issues.push({ code: 'RECORD_MALFORMED', severity: 'error' });
  if (text === null || occurredAt === null) return rejected(sourceRef, issues);
  const inbound = truthy(m.isIncoming);
  return outcome(sourceRef, {
    category: 'messages',
    sourceRef,
    externalId: `${collection}/${m.id}`,
    personRef: m.personId,
    channel: isEmail ? 'email' : 'sms',
    direction: inbound ? 'inbound' : 'outbound',
    subject: isEmail ? lineField(m.subject, 'subject', 998, issues) : null,
    body: text,
    status: inbound ? 'received' : outboundStatus(m.status),
    userId: userFor(m.userId, users),
    occurredAt,
  }, issues);
}

function callShape(outcomeLabel: string, durationS: number | null): { status: NormalizedCall['status']; outcome: NormalizedCall['outcome'] } {
  const o = outcomeLabel.toLowerCase();
  if (/wrong/.test(o)) return { status: 'completed', outcome: 'wrong_number' };
  if (/bad|disconnected|invalid/.test(o)) return { status: 'failed', outcome: 'bad_number' };
  if (/voicemail|left.*message|message left/.test(o)) return { status: 'voicemail', outcome: 'left_voicemail' };
  if (/no.?answer/.test(o)) return { status: 'no_answer', outcome: 'no_answer' };
  if (/busy/.test(o)) return { status: 'busy', outcome: null };
  if (/do not call|dnc/.test(o)) return { status: 'completed', outcome: 'do_not_call_request' };
  if (/call ?back/.test(o)) return { status: 'completed', outcome: 'callback_requested' };
  if (/interested|talked|connected|spoke|conversation/.test(o)) return { status: 'completed', outcome: 'connected' };
  return { status: durationS !== null && durationS > 0 ? 'completed' : 'no_answer', outcome: null };
}

function mapCall(raw: unknown, users: UserMapping): RecordOutcome<NormalizedCall> {
  const p = FubCallSchema.safeParse(raw);
  if (!p.success) return rejected(fubSourceRef('calls', rawId(raw)), [{ code: 'RECORD_MALFORMED', severity: 'error' }]);
  const c = p.data;
  const sourceRef = fubSourceRef('calls', c.id);
  const issues: Issue[] = [];
  const startedAt = parseTime(c.created, 'created', issues);
  if (startedAt === null) return rejected(sourceRef, [...issues, { code: 'RECORD_MALFORMED', severity: 'error' }]);
  const d = c.duration === null || c.duration === undefined ? null : Number(c.duration);
  const durationS = d !== null && Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
  const outcomeLabel = lineField(c.outcome, 'outcome', 200, issues) ?? '';
  const shape = callShape(outcomeLabel, durationS);
  const noteParts = [outcomeLabel !== '' && shape.outcome === null ? `FUB outcome: ${outcomeLabel}` : '', c.note ? cleanBody(c.note) : ''].filter((s) => s !== '');
  const hasRecording = typeof c.recordingUrl === 'string' && c.recordingUrl.trim() !== '';
  if (hasRecording) issues.push({ code: 'RECORDING_NOTICE_UNKNOWN', severity: 'info' });
  return outcome(sourceRef, {
    category: 'call_recordings',
    sourceRef,
    externalId: c.id,
    personRef: c.personId,
    direction: truthy(c.isIncoming) ? 'inbound' : 'outbound',
    startedAt,
    durationS,
    status: shape.status,
    outcome: shape.outcome,
    agentUserId: userFor(c.userId, users),
    note: noteParts.length > 0 ? noteParts.join('\n').slice(0, MAX_BODY) : null,
    recording: hasRecording ? { consentBasis: 'unknown_imported', label: 'recording notice unknown', transcribe: false } : null,
  }, issues);
}

/**
 * Normalizes one raw FUB object for a stage. `contacts`, `ownership` and `consent` read a person;
 * `notes` a note; `messages` a text message or an email; `call_recordings` a call. Never throws.
 */
export function mapFub(category: Category, raw: unknown, users: UserMapping): RecordOutcome<NormalizedRecord> {
  switch (category) {
    case 'contacts':
    case 'ownership':
    case 'consent': {
      const r = mapPerson(raw);
      if ('fail' in r) return r.fail;
      return category === 'contacts' ? mapContact(r.person) : category === 'ownership' ? mapOwnership(r.person, users) : mapConsent(r.person);
    }
    case 'notes':
      return mapNote(raw, users);
    case 'messages':
      return mapMessage(raw, users);
    case 'call_recordings':
      return mapCall(raw, users);
  }
}

// ---- user mapping and connection test -------------------------------------------------------------

/**
 * R-IMPORT-8 (core part): FUB user and pond ids referenced by the snapshot's people that the mapping
 * does not cover. The ownership stage cannot be approved while this is non-empty.
 */
export function userMappingGaps(people: readonly unknown[], mapping: UserMapping): { users: string[]; ponds: string[] } {
  const users = new Set<string>();
  const ponds = new Set<string>();
  for (const raw of people) {
    const p = FubPersonSchema.safeParse(raw);
    if (!p.success) continue;
    const u = p.data.assignedUserId;
    const pond = p.data.assignedPondId;
    if (u !== null && u !== undefined) {
      if (!mapping.users.has(u)) users.add(u);
    } else if (pond !== null && pond !== undefined && !mapping.ponds?.has(pond)) ponds.add(pond);
  }
  return { users: [...users].sort(), ponds: [...ponds].sort() };
}

export type FubCollection = 'people' | 'notes' | 'textMessages' | 'emails' | 'calls' | 'users';

const Metadata = z.looseObject({ _metadata: z.looseObject({ total: z.number().int().nonnegative() }) });

/**
 * R-IMPORT-1: the connection/export test reads COUNTS ONLY: `_metadata.total` of a one-record page of
 * each collection. No record content is read and nothing is promised before this. Collections the
 * test could not count are `null`, never guessed. Ownership and consent come from people, so their
 * source count is the people count (people without indicators dry-run as `duplicate`: nothing to
 * record).
 */
export function fubConnectionCounts(pages: Partial<Record<FubCollection, unknown>>): {
  collections: Record<FubCollection, number | null>;
  categories: Record<Category, number | null>;
} {
  const total = (c: FubCollection): number | null => {
    const p = Metadata.safeParse(pages[c]);
    return p.success ? p.data._metadata.total : null;
  };
  const collections: Record<FubCollection, number | null> = {
    people: total('people'),
    notes: total('notes'),
    textMessages: total('textMessages'),
    emails: total('emails'),
    calls: total('calls'),
    users: total('users'),
  };
  const sum = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
  return {
    collections,
    categories: {
      contacts: collections.people,
      ownership: collections.people,
      notes: collections.notes,
      messages: sum(collections.textMessages, collections.emails),
      call_recordings: collections.calls,
      consent: collections.people,
    },
  };
}
