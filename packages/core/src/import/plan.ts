// The staged per-category plan: dry run, review + commit plan, resumable commit chunks, revert
// (BUILD_PLAN module 6; R-IMPORT-4, R-IMPORT-7, R-IMPORT-9, R-IMPORT-10, R-OWN-21, R-OWN-25;
// E39, E41, E42, E43, E44).
//
// Matching (contacts stage), in this order:
//   1. the same source ref twice in the snapshot           → rejected SOURCE_REF_DUPLICATE
//   2. an earlier row of this snapshot with the same external id, phone or email
//                                                          → duplicate IN_FILE_DUPLICATE
//   3. external_refs knows the external id (a re-run, E44) → update only what is still empty, or
//                                                            duplicate ALREADY_IMPORTED when nothing is new
//   4. an exact phone/email match (R-OWN-25, core/ownership `matchContacts`)
//                                                          → attach: fill fields only where empty (E41);
//                                                            a contact owned by an agent is flagged for review;
//                                                            ownership never changes (R-IMPORT-7, R-OWN-21)
//   5. a name-only match                                   → create + duplicate candidate, never merged (R-IMPORT-7)
//   6. otherwise                                           → create
// Soft-deleted and merged-away contacts never absorb an import (E39): a deleted match means a new
// contact, and every opt-out on its addresses still applies through the HMAC ("will stay opted out").
import { canonicalJson, sha256Hex, type AddressKind, type Channel } from '../compliance/index.js';
import type { ContactId, IdGenerator, Instant } from '../foundation/index.js';
import { type DuplicateReason, type ExistingMatch, matchContacts, resolveMergeRedirect } from '../ownership/index.js';
import { personRefOf, statusOf } from './csv.js';
import { type ImportedConsentEventRow, plannedConsentKeys, revertImportedGrant } from './consent.js';
import { nameKey } from './text.js';
import type {
  Category,
  ConsentSummary,
  ContactFill,
  ContactRef,
  ContactsStagePlan,
  Counts,
  DryRunOutcome,
  DuplicateCandidate,
  ExistingContact,
  ExistingIndex,
  ExternalEntityType,
  FubConsentFields,
  ImportErrorCode,
  ImportTarget,
  Issue,
  NormalizedContact,
  NormalizedRecord,
  PlanAction,
  PlannedRecord,
  RecordOutcome,
  StageCounts,
  StageDryRun,
} from './types.js';
import type { ConsentEventSpec } from '../compliance/index.js';

// ---- index ----------------------------------------------------------------------------------------

/** external_refs lookup key. */
export function refKey(entityType: ExternalEntityType, externalId: string): string {
  return `${entityType}:${externalId}`;
}

export interface ExistingIndexInput {
  batchId: string;
  keyOf(kind: AddressKind, normalized: string): string;
  contacts: readonly ExistingContact[];
  externalRefs?: readonly { entityType: ExternalEntityType; externalId: string; entityId: string }[];
  contactsStage?: ReadonlyMap<string, ContactsStagePlan>;
  /** Address keys (HMACs) with the channels revoked or suppressed now. */
  optedOut?: readonly { key: string; channel: Channel }[];
  /** `importedConsentKey(...)` of imported events already recorded. */
  importedConsent?: readonly string[];
}

/** Builds the lookup maps of an `ExistingIndex` (O(n) over the tenant's contacts). */
export function buildExistingIndex(i: ExistingIndexInput): ExistingIndex {
  const contacts = new Map<string, ExistingContact>();
  const byAddress = new Map<string, ContactId[]>();
  const byName = new Map<string, ContactId[]>();
  const push = (m: Map<string, ContactId[]>, k: string, id: ContactId) => {
    const l = m.get(k);
    if (l) {
      if (!l.includes(id)) l.push(id);
    } else m.set(k, [id]);
  };
  for (const c of i.contacts) {
    contacts.set(c.contactId, c);
    for (const p of c.phones) push(byAddress, i.keyOf('phone', p), c.contactId);
    for (const e of c.emails) push(byAddress, i.keyOf('email', e), c.contactId);
    const nk = nameKey(c.displayName);
    if (nk !== '') push(byName, nk, c.contactId);
  }
  const optedOut = new Map<string, Channel[]>();
  for (const o of i.optedOut ?? []) {
    const l = optedOut.get(o.key);
    if (l) {
      if (!l.includes(o.channel)) l.push(o.channel);
    } else optedOut.set(o.key, [o.channel]);
  }
  return {
    batchId: i.batchId,
    keyOf: i.keyOf,
    contacts,
    byAddress,
    byName,
    externalRefs: new Map((i.externalRefs ?? []).map((r) => [refKey(r.entityType, r.externalId), r.entityId])),
    contactsStage: i.contactsStage ?? new Map(),
    optedOut,
    importedConsent: new Set(i.importedConsent ?? []),
  };
}

function isGone(c: ExistingContact): boolean {
  return c.ownershipState === 'closed' && (c.closedReason === 'deleted' || c.closedReason === 'merged');
}

/** Follows merge redirects (R-OWN-24) to the surviving contact; null when it cannot be resolved. */
function live(existing: ExistingIndex, id: string): ExistingContact | null {
  const r = resolveMergeRedirect(id as ContactId, (x) => existing.contacts.get(x)?.mergedIntoContactId ?? null);
  if (!r.ok) return null;
  return existing.contacts.get(r.contactId) ?? null;
}

// ---- snapshot digest (R-IMPORT-4, E42) ------------------------------------------------------------

/** sha256 over the canonical normalized records of a stage, in snapshot order. */
export function snapshotDigest(category: Category, records: readonly RecordOutcome<NormalizedRecord>[]): string {
  return sha256Hex(canonicalJson({ category, records: records.map((r) => ({ sourceRef: r.sourceRef, status: r.status, record: r.record, issues: r.issues })) }));
}

// ---- contacts ---------------------------------------------------------------------------------------

function lowerSet(xs: readonly string[]): Set<string> {
  return new Set(xs.map((x) => x.toLowerCase()));
}

/** E41: what an import may add to an existing contact: only empty fields, new points, new tags, new keys. */
export function computeFill(rec: NormalizedContact, c: ExistingContact): ContactFill {
  const havePhones = new Set(c.phones);
  const haveEmails = new Set(c.emails);
  const haveTags = lowerSet(c.tags);
  const haveKeys = new Set(c.importedFieldKeys);
  const addPhones = rec.phones.filter((p) => !havePhones.has(p.e164)).map((p, i) => ({ ...p, isPrimary: c.phones.length === 0 && i === 0 }));
  const addEmails = rec.emails.filter((e) => !haveEmails.has(e.email)).map((e, i) => ({ ...e, isPrimary: c.emails.length === 0 && i === 0 }));
  const addImportedFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec.importedFields)) if (!haveKeys.has(k)) addImportedFields[k] = v;
  return {
    ...(c.firstName === null && rec.firstName !== null ? { firstName: rec.firstName } : {}),
    ...(c.lastName === null && rec.lastName !== null ? { lastName: rec.lastName } : {}),
    ...(c.intent === null && rec.intent !== null ? { intent: rec.intent } : {}),
    addPhones,
    addEmails,
    addAddresses: c.hasAddress ? [] : rec.addresses,
    addTags: rec.tags.filter((t) => !haveTags.has(t.toLowerCase())),
    addImportedFields,
  };
}

export function fillIsEmpty(f: ContactFill): boolean {
  return (
    f.firstName === undefined &&
    f.lastName === undefined &&
    f.intent === undefined &&
    f.addPhones.length === 0 &&
    f.addEmails.length === 0 &&
    f.addAddresses.length === 0 &&
    f.addTags.length === 0 &&
    Object.keys(f.addImportedFields).length === 0
  );
}

function addressKeys(rec: NormalizedContact, existing: ExistingIndex): { phone: string[]; email: string[] } {
  return { phone: rec.phones.map((p) => existing.keyOf('phone', p.e164)), email: rec.emails.map((e) => existing.keyOf('email', e.email)) };
}

function settle(issues: Issue[], fallback: 'will_import'): DryRunOutcome {
  const s = statusOf(issues);
  return s === 'rejected' ? 'rejected' : s === 'needs_review' ? 'needs_review' : fallback;
}

/** contact_duplicate_candidates.match_reason for a dedup suggestion (fuzzy reasons are recorded as `import`). */
const CANDIDATE_REASON: Record<DuplicateReason, DuplicateCandidate['reason']> = {
  shared_phone: 'shared_phone',
  shared_email: 'shared_email',
  phone_email_split: 'phone_email_split',
  name_postal: 'import',
  trigram_name: 'import',
};

function planContact(rec: NormalizedContact, inIssues: Issue[], existing: ExistingIndex, seen: { keys: Map<string, string>; ext: Map<string, string> }): PlannedRecord {
  const issues = [...inIssues];
  const keys = addressKeys(rec, existing);
  const allKeys = [...keys.phone, ...keys.email];
  const staysOptedOut = [...new Set(allKeys.flatMap((k) => existing.optedOut.get(k) ?? []))].sort();
  if (staysOptedOut.length > 0) issues.push({ code: 'ADDRESS_OPTED_OUT', severity: 'info' });
  const base = { sourceRef: rec.sourceRef, normalized: rec, staysOptedOut };

  // 2. in-file duplicates
  const dupOf = (rec.externalId !== null ? seen.ext.get(rec.externalId) : undefined) ?? allKeys.map((k) => seen.keys.get(k)).find((x) => x !== undefined);
  if (dupOf !== undefined) {
    return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: dupOf }, issues: [...issues, { code: 'IN_FILE_DUPLICATE', severity: 'info' }], matchContactId: null };
  }
  if (rec.externalId !== null) seen.ext.set(rec.externalId, rec.sourceRef);
  // No key of this record was seen before (else it is an in-file duplicate above).
  for (const k of allKeys) seen.keys.set(k, rec.sourceRef);

  // 3. re-run through external_refs (R-IMPORT-9, E44)
  if (rec.externalId !== null) {
    const linked = existing.externalRefs.get(refKey('contact', rec.externalId));
    if (linked !== undefined) {
      const c = live(existing, linked);
      if (c === null || isGone(c)) {
        issues.push({ code: 'MATCH_DELETED_CONTACT', severity: 'review' });
        return { ...base, outcome: settle(issues, 'will_import'), action: { kind: 'create_contact', duplicateCandidates: [] }, issues, matchContactId: null };
      }
      const fill = computeFill(rec, c);
      if (fillIsEmpty(fill)) {
        return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: c.contactId }, issues: [...issues, { code: 'ALREADY_IMPORTED', severity: 'info' }], matchContactId: c.contactId };
      }
      return { ...base, outcome: settle(issues, 'will_import'), action: { kind: 'update_contact', contactId: c.contactId, fill }, issues, matchContactId: c.contactId };
    }
  }

  // 4. exact phone/email (R-OWN-25)
  const matches = new Map<string, ExistingMatch>();
  let sawGone = false;
  for (const k of allKeys) {
    for (const id of existing.byAddress.get(k) ?? []) {
      const raw = existing.contacts.get(id);
      const c = live(existing, id);
      if (raw && isGone(raw) && raw.closedReason === 'deleted') sawGone = true;
      if (c === null || isGone(c)) continue;
      const prev = matches.get(c.contactId);
      matches.set(c.contactId, {
        contactId: c.contactId,
        createdAt: c.createdAt,
        ownershipState: c.ownershipState,
        closedReason: c.closedReason,
        matchedHmacs: [...(prev?.matchedHmacs ?? []), k],
      });
    }
  }
  const dedup = matchContacts({ phoneHmacs: keys.phone, emailHmacs: keys.email }, [...matches.values()]);
  if (dedup.kind === 'attach') {
    const c = existing.contacts.get(dedup.contactId) as ExistingContact;
    const duplicateCandidates: DuplicateCandidate[] = dedup.duplicates.map((d) => ({ contactId: d.contactId, reason: CANDIDATE_REASON[d.reason] }));
    if (duplicateCandidates.length > 0) issues.push({ code: 'MATCH_MULTIPLE', severity: 'info' });
    // Owned by an agent, or on offer to one right now: an agent's lead either way.
    const owned = c.ownershipState === 'owned' || c.ownershipState === 'offered';
    const fill = computeFill(rec, c);
    if (fillIsEmpty(fill) && duplicateCandidates.length === 0) {
      if (owned) issues.push({ code: 'MATCH_OWNED_CONTACT', severity: 'info' });
      return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: c.contactId }, issues, matchContactId: c.contactId };
    }
    // E41: an agent's contact is changed only after a human looks (fields fill only where empty).
    if (owned) issues.push({ code: 'MATCH_OWNED_CONTACT', severity: 'review' });
    return { ...base, outcome: settle(issues, 'will_import'), action: { kind: 'attach_contact', contactId: c.contactId, fill, duplicateCandidates }, issues, matchContactId: c.contactId };
  }

  // 5. name-only (R-IMPORT-7): a candidate, never a merge
  const nk = nameKey(rec.displayName);
  const nameMatches = (nk === '' ? [] : existing.byName.get(nk) ?? [])
    .map((id) => live(existing, id))
    .filter((c): c is ExistingContact => c !== null && !isGone(c));
  const duplicateCandidates: DuplicateCandidate[] = [...new Map(nameMatches.map((c) => [c.contactId, { contactId: c.contactId, reason: 'import' as const }])).values()];
  if (duplicateCandidates.length > 0) issues.push({ code: 'NAME_ONLY_MATCH', severity: 'info' });
  if (sawGone) issues.push({ code: 'MATCH_DELETED_CONTACT', severity: 'info' });
  return { ...base, outcome: settle(issues, 'will_import'), action: { kind: 'create_contact', duplicateCandidates }, issues, matchContactId: null };
}

// ---- later stages -----------------------------------------------------------------------------------

type ParentResolution = (
  | { kind: 'linked'; contact: ExistingContact }
  | { kind: 'pending'; plan: 'create' | 'attach'; personRef: string }
  | { kind: 'undecided' }
  | { kind: 'rejected' }
  | { kind: 'missing' }
) & {
  /** B6: the record's person was skipped as a duplicate, and this is what the skip points at */
  viaDuplicate?: true;
};

function linkedOrMissing(existing: ExistingIndex, contactId: string): ParentResolution {
  const c = live(existing, contactId);
  return c === null || isGone(c) ? { kind: 'missing' } : { kind: 'linked', contact: c };
}

function resolveParent(personRef: string, existing: ExistingIndex, depth = 0): ParentResolution {
  const linked = existing.externalRefs.get(refKey('contact', personRef));
  if (linked !== undefined) return linkedOrMissing(existing, linked);
  const plan = existing.contactsStage.get(personRef);
  if (typeof plan === 'object') {
    // B6 (R-IMPORT-4): a person skipped as a duplicate is the person its skip points at, exactly as the commit
    // finds it. The earlier row is never an in-file duplicate itself (a duplicate claims no key), so this is at
    // most two steps: duplicate → earlier row → the existing contact that row matched.
    if (depth >= 2) return { kind: 'missing', viaDuplicate: true };
    const to = 'contactId' in plan.sameAs ? linkedOrMissing(existing, plan.sameAs.contactId) : resolveParent(plan.sameAs.pendingPersonRef, existing, depth + 1);
    return { ...to, viaDuplicate: true };
  }
  if (plan === 'create' || plan === 'attach') return { kind: 'pending', plan, personRef };
  if (plan === 'needs_review') return { kind: 'undecided' };
  if (plan === 'rejected') return { kind: 'rejected' };
  return { kind: 'missing' };
}

function parentRef(p: ParentResolution): ContactRef | null {
  if (p.kind === 'linked') return { contactId: p.contact.contactId };
  if (p.kind === 'pending') return { pendingPersonRef: p.personRef };
  return null;
}

/** A parent problem as an issue (null when the parent is usable). */
function parentIssue(p: ParentResolution): Issue | null {
  if (p.kind === 'missing') return { code: 'PARENT_NOT_FOUND', severity: 'error' };
  if (p.kind === 'rejected') return { code: 'PARENT_REJECTED', severity: 'error' };
  if (p.kind === 'undecided') return { code: 'PARENT_NOT_LINKED', severity: 'review' };
  return null;
}

/**
 * The engine's own test (core/ownership decideImport): only a contact the contacts stage created that is still in that
 * imported creation state (unassigned, ledger seq 1, never routed) takes an import assignment. Anything a person did to
 * it since (a merge either way, an assign, a close, a release) has left that state for good.
 */
function inImportCreationState(c: ExistingContact): boolean {
  return c.ownershipState === 'unassigned' && c.ownershipSeq === 1 && c.routeDueAt === null;
}

function sameTarget(c: ExistingContact, t: ImportTarget): boolean {
  if (t === 'unassigned') return c.ownershipState === 'unassigned';
  if ('userId' in t) return c.ownershipState === 'owned' && c.ownerUserId === t.userId;
  return c.ownershipState === 'in_pond';
}

function planOwnership(rec: Extract<NormalizedRecord, { category: 'ownership' }>, inIssues: Issue[], existing: ExistingIndex): PlannedRecord {
  const issues = [...inIssues];
  const base = { sourceRef: rec.sourceRef, normalized: rec, staysOptedOut: [] as Channel[] };
  const p = resolveParent(rec.personRef, existing);
  // R-IMPORT-7 / R-OWN-21 / E41: an import never changes the owner of a contact it did not create,
  // and a re-run never re-assigns one it did. A person skipped as a duplicate (B6) is the earlier row's
  // person or a contact already here: that record decides the owner, never the duplicate's assignment.
  if (p.viaDuplicate) {
    return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: rec.personRef }, issues: [...issues, { code: 'OWNER_KEPT', severity: 'info' }], matchContactId: null };
  }
  const pi = parentIssue(p);
  if (pi) {
    issues.push(pi);
    const outcome = settle(issues, 'will_import');
    return { ...base, outcome, action: outcome === 'rejected' ? null : { kind: 'assign', contact: { pendingPersonRef: rec.personRef }, target: rec.target }, issues, matchContactId: null };
  }
  if (p.kind === 'pending' && p.plan === 'attach') {
    return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: rec.personRef }, issues: [...issues, { code: 'OWNER_KEPT', severity: 'info' }], matchContactId: null };
  }
  if (p.kind === 'linked') {
    const c = p.contact;
    const createdHere = c.importBatchId === existing.batchId;
    // Review R4: a person FUB holds unassigned had no assignment to make, so whatever a person did to them since the
    // contacts stage (closed, released, routed, merged) changed nothing the import would have done: already imported,
    // never a "came in unassigned" outcome. Someone gave them an owner: kept, below.
    const nothingToGive = rec.target === 'unassigned' && c.ownershipState !== 'owned';
    if (createdHere && (sameTarget(c, rec.target) || nothingToGive)) {
      return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: c.contactId }, issues: [...issues, { code: 'ALREADY_IMPORTED', severity: 'info' }], matchContactId: c.contactId };
    }
    // Only a contact this batch created, still in its imported `unassigned` creation state, takes
    // the mapped assignment; everything else keeps its owner.
    if (!createdHere || c.ownershipState === 'owned') {
      return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: c.contactId }, issues: [...issues, { code: 'OWNER_KEPT', severity: 'info' }], matchContactId: c.contactId };
    }
    // Batch 6 review F3: created here, but a person has merged or changed it since the contacts stage, and nobody holds
    // it: the engine makes no assignment, so it comes in unassigned (not imported, for that reason), and the ownership
    // report lists it with "Assign these people" (E231). Followed a merge to get here, or another person was merged
    // into it: merged.
    if (!inImportCreationState(c)) {
      const merged = c.mergedIn === true || existing.externalRefs.get(refKey('contact', rec.personRef)) !== c.contactId;
      return { ...base, outcome: 'rejected', action: null, issues: [...issues, { code: merged ? 'PERSON_MERGED' : 'PERSON_CHANGED', severity: 'info' }], matchContactId: c.contactId };
    }
  }
  return {
    ...base,
    outcome: settle(issues, 'will_import'),
    action: { kind: 'assign', contact: parentRef(p) as ContactRef, target: rec.target },
    issues,
    matchContactId: p.kind === 'linked' ? p.contact.contactId : null,
  };
}

const HISTORY_ENTITY: Record<'notes' | 'messages' | 'call_recordings', ExternalEntityType> = { notes: 'note', messages: 'message', call_recordings: 'call' };

function planHistory(rec: Extract<NormalizedRecord, { category: 'notes' | 'messages' | 'call_recordings' }>, inIssues: Issue[], existing: ExistingIndex): PlannedRecord {
  const issues = [...inIssues];
  const base = { sourceRef: rec.sourceRef, normalized: rec, staysOptedOut: [] as Channel[] };
  const done = existing.externalRefs.get(refKey(HISTORY_ENTITY[rec.category], rec.externalId));
  if (done !== undefined) {
    return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: done }, issues: [...issues, { code: 'ALREADY_IMPORTED', severity: 'info' }], matchContactId: null };
  }
  const p = resolveParent(rec.personRef, existing);
  // B6 (R-IMPORT-4): the record goes on the contact its skipped-duplicate person is the same as, and says so
  if (p.viaDuplicate) issues.push({ code: 'PARENT_DUPLICATE', severity: 'info' });
  const pi = parentIssue(p);
  if (pi) issues.push(pi);
  const outcome = settle(issues, 'will_import');
  return {
    ...base,
    outcome,
    action: outcome === 'rejected' ? null : { kind: 'insert_history', contact: parentRef(p) ?? { pendingPersonRef: rec.personRef } },
    issues,
    matchContactId: p.kind === 'linked' ? p.contact.contactId : null,
  };
}

/** The part of a record's consent fields that is not in the ledger yet (re-run idempotency). */
function newConsentFields(fields: FubConsentFields, existing: ExistingIndex): FubConsentFields {
  const has = (kind: AddressKind, address: string, c: Channel, t: 'grant' | 'revoke' | 'dnc') =>
    existing.importedConsent.has(`${t}:${c}:${existing.keyOf(kind, address)}`);
  const addresses = fields.addresses
    .map((a) => ({
      ...a,
      grants: a.grants.filter((c) => !has(a.kind, a.address, c, 'grant')),
      revokes: a.revokes.filter((c) => !has(a.kind, a.address, c, 'revoke')),
      doNotContact: a.doNotContact && !has(a.kind, a.address, a.kind === 'email' ? 'email' : 'sms', 'dnc'),
    }))
    .filter((a) => a.grants.length > 0 || a.revokes.length > 0 || a.doNotContact);
  return { addresses, occurredAt: fields.occurredAt };
}

function planConsent(rec: Extract<NormalizedRecord, { category: 'consent' }>, inIssues: Issue[], existing: ExistingIndex): PlannedRecord {
  const issues = [...inIssues];
  const keys = plannedConsentKeys(rec.fields, existing.keyOf);
  // E39: a grant never lifts an opt-out that is already on file; say so in the preview.
  const staysOptedOut = [...new Set(rec.fields.addresses.flatMap((a) => existing.optedOut.get(existing.keyOf(a.kind, a.address)) ?? []))].sort();
  if (staysOptedOut.length > 0) issues.push({ code: 'ADDRESS_OPTED_OUT', severity: 'info' });
  const base = { sourceRef: rec.sourceRef, normalized: rec, staysOptedOut };
  if (keys.length === 0) {
    if (!issues.some((i) => i.code === 'NO_CONSENT_DATA')) issues.push({ code: 'NO_CONSENT_DATA', severity: 'info' });
    // Nothing to record. A record with an unreadable consent value still goes to a human (who can
    // only confirm there is nothing to record); otherwise it is counted with the no-ops.
    const outcome = settle(issues, 'will_import') === 'needs_review' ? 'needs_review' : 'duplicate';
    return { ...base, outcome, action: { kind: 'skip', existingId: rec.personRef }, issues, matchContactId: null };
  }
  const fresh = newConsentFields(rec.fields, existing);
  if (fresh.addresses.length === 0) {
    return { ...base, outcome: 'duplicate', action: { kind: 'skip', existingId: rec.personRef }, issues: [...issues, { code: 'ALREADY_IMPORTED', severity: 'info' }], matchContactId: null };
  }
  // Consent is keyed by address, not contact (R-CONSENT-1): a missing contact never blocks an opt-out. A
  // skipped duplicate's consent names the contact that person is the same as (B6), for context only.
  const p = resolveParent(rec.personRef, existing);
  const contact = parentRef(p);
  const outcome = settle(issues, 'will_import');
  return {
    ...base,
    outcome,
    action:
      outcome === 'rejected'
        ? null
        : {
            kind: 'record_consent',
            contact,
            fields: fresh,
            grants: fresh.addresses.reduce((n, a) => n + a.grants.length, 0),
            revokes: fresh.addresses.reduce((n, a) => n + a.revokes.length, 0),
            doNotContact: fresh.addresses.filter((a) => a.doNotContact).length,
          },
    issues,
    matchContactId: p.kind === 'linked' ? p.contact.contactId : null,
  };
}

function consentSummary(records: readonly PlannedRecord[]): ConsentSummary {
  const s: ConsentSummary = { textingPermission: 0, emailPermission: 0, optedOut: 0, doNotContact: 0 };
  for (const r of records) {
    if (r.outcome === 'rejected' || r.normalized?.category !== 'consent') continue;
    const a = r.normalized.fields.addresses;
    if (a.some((x) => x.grants.includes('sms'))) s.textingPermission += 1;
    if (a.some((x) => x.grants.includes('email'))) s.emailPermission += 1;
    if (a.some((x) => x.revokes.length > 0)) s.optedOut += 1;
    if (a.some((x) => x.doNotContact)) s.doNotContact += 1;
  }
  return s;
}

function countsOf(records: readonly PlannedRecord[]): StageCounts {
  const c: StageCounts = { source: records.length, will_import: 0, needs_review: 0, rejected: 0, duplicate: 0 };
  for (const r of records) c[r.outcome] += 1;
  return c;
}

/**
 * The dry run of one stage: per-record outcome, planned action and issues, the counts
 * (source = will_import + needs_review + rejected + duplicate, always), stage blockers and the
 * snapshot digest a commit must present. Pure; nothing is written.
 */
export function dryRun(category: Category, records: readonly RecordOutcome<NormalizedRecord>[], existing: ExistingIndex): StageDryRun {
  const planned: PlannedRecord[] = [];
  const refs = new Set<string>();
  const seen = { keys: new Map<string, string>(), ext: new Map<string, string>() };
  for (const r of records) {
    if (refs.has(r.sourceRef)) {
      planned.push({ sourceRef: r.sourceRef, outcome: 'rejected', action: null, issues: [...r.issues, { code: 'SOURCE_REF_DUPLICATE', severity: 'error' }], matchContactId: null, normalized: null, staysOptedOut: [] });
      continue;
    }
    refs.add(r.sourceRef);
    if (r.status === 'rejected' || r.record === null) {
      planned.push({ sourceRef: r.sourceRef, outcome: 'rejected', action: null, issues: r.issues, matchContactId: null, normalized: null, staysOptedOut: [] });
      continue;
    }
    const rec = r.record;
    if (rec.category !== category) {
      planned.push({ sourceRef: r.sourceRef, outcome: 'rejected', action: null, issues: [...r.issues, { code: 'RECORD_MALFORMED', severity: 'error' }], matchContactId: null, normalized: null, staysOptedOut: [] });
      continue;
    }
    switch (rec.category) {
      case 'contacts':
        planned.push(planContact(rec, r.issues, existing, seen));
        break;
      case 'ownership':
        planned.push(planOwnership(rec, r.issues, existing));
        break;
      case 'notes':
      case 'messages':
      case 'call_recordings':
        planned.push(planHistory(rec, r.issues, existing));
        break;
      case 'consent':
        planned.push(planConsent(rec, r.issues, existing));
        break;
    }
  }
  const blockers: Issue[] =
    category === 'ownership' && planned.some((p) => p.issues.some((i) => i.code === 'USER_UNMAPPED')) ? [{ code: 'USER_MAPPING_INCOMPLETE', severity: 'error' }] : [];
  return {
    category,
    counts: countsOf(planned),
    records: planned,
    blockers,
    snapshotSha256: snapshotDigest(category, records),
    consentSummary: category === 'consent' ? consentSummary(planned) : null,
  };
}

/**
 * B6 (R-IMPORT-4): the person a contacts record skipped as a duplicate is the same as, for the later stages: the
 * earlier row's person for an in-file duplicate (the skip's `existingId` is that row's source ref), else the
 * existing contact it matched (`existingId` is a contact id: nothing new to fill, or already imported). Null for
 * any other record, and for an earlier row that is not in the stage. The API's contactsStageMap and
 * contactsStagePlan both use it, so the dry run and the commit agree.
 */
export function skippedDuplicateOf(r: { action: PlanAction | null; issues: readonly Issue[] }, personRefOfSource: (sourceRef: string) => string | undefined): ContactRef | null {
  if (r.action?.kind !== 'skip') return null;
  if (r.issues.some((i) => i.code === 'IN_FILE_DUPLICATE')) {
    const ref = personRefOfSource(r.action.existingId);
    return ref === undefined ? null : { pendingPersonRef: ref };
  }
  return { contactId: r.action.existingId as ContactId };
}

/**
 * Adds the skipped duplicates to a contacts-stage plan. A duplicate never replaces the plan of a person a record
 * of its own decides (a second row with the same id is that person), and never points at itself.
 */
export function addSkippedDuplicates(out: Map<string, ContactsStagePlan>, skips: readonly { personRef: string; sameAs: ContactRef | null }[]): void {
  for (const s of skips) {
    if (s.sameAs === null || out.has(s.personRef)) continue;
    if ('pendingPersonRef' in s.sameAs && s.sameAs.pendingPersonRef === s.personRef) continue;
    out.set(s.personRef, { sameAs: s.sameAs });
  }
}

/** The contacts-stage plan by person ref, for later stages dry-run before the contacts commit. */
export function contactsStagePlan(dry: StageDryRun): Map<string, ContactsStagePlan> {
  const out = new Map<string, ContactsStagePlan>();
  const refOf = new Map<string, string>();
  const skips: { personRef: string; sameAs: ContactRef | null }[] = [];
  for (const r of dry.records) if (r.normalized?.category === 'contacts') refOf.set(r.sourceRef, personRefOf(r.normalized));
  for (const r of dry.records) {
    if (r.normalized === null) {
      // A record rejected before normalization has no external id; FUB refs carry the person id.
      const fub = /^fub:people\/(.+)$/.exec(r.sourceRef);
      out.set(fub ? (fub[1] as string) : r.sourceRef, 'rejected');
      continue;
    }
    if (r.normalized.category !== 'contacts') continue;
    const ref = personRefOf(r.normalized);
    if (r.outcome === 'rejected') out.set(ref, 'rejected');
    else if (r.outcome === 'needs_review') out.set(ref, 'needs_review');
    else if (r.action?.kind === 'create_contact') out.set(ref, 'create');
    else if (r.action?.kind === 'skip') skips.push({ personRef: ref, sameAs: skippedDuplicateOf(r, (s) => refOf.get(s)) });
    else out.set(ref, 'attach');
  }
  addSkippedDuplicates(out, skips);
  return out;
}

// ---- review + commit plan (R-IMPORT-4, E42) --------------------------------------------------------

export type ReviewDecision = 'import' | 'merge' | 'reject';

export interface Review {
  sourceRef: string;
  decision: ReviewDecision;
  /** For `merge`: the existing contact to attach to (one of the record's match / duplicate candidates). */
  mergeIntoContactId?: ContactId;
}

export interface CommitItem {
  sourceRef: string;
  action: PlanAction;
  normalized: NormalizedRecord;
  /** True when a review decision (not the dry run) put the record in the commit. */
  reviewed: boolean;
}

export type CommitPlan =
  | { ok: true; items: CommitItem[]; expected: Counts }
  | { ok: false; code: Extract<ImportErrorCode, 'SNAPSHOT_CHANGED' | 'STAGE_BLOCKED' | 'REVIEW_NOT_ALLOWED' | 'UNKNOWN_RECORD'>; sourceRefs: string[] };

/**
 * Exactly the records a commit applies: dry-run `will_import` records plus `needs_review` records a
 * reviewer decided to import or merge, minus anything a reviewer rejected. Refuses when the
 * snapshot digest differs from the dry run's (FUB changed: a delta needs a new snapshot + dry run,
 * E42), when the stage has blockers, or when a review names an unknown or non-reviewable record.
 * Needs-review records without a decision are not committed and stay `needs_review`.
 */
export function commitPlan(dry: StageDryRun, reviews: readonly Review[], presentedSnapshotSha256: string, existing: ExistingIndex): CommitPlan {
  if (presentedSnapshotSha256 !== dry.snapshotSha256) return { ok: false, code: 'SNAPSHOT_CHANGED', sourceRefs: [] };
  if (dry.blockers.length > 0) return { ok: false, code: 'STAGE_BLOCKED', sourceRefs: [] };
  const byRef = new Map(dry.records.map((r) => [r.sourceRef, r]));
  const decisions = new Map<string, Review>();
  const unknown: string[] = [];
  const notAllowed: string[] = [];
  for (const rv of reviews) {
    const r = byRef.get(rv.sourceRef);
    if (!r) {
      unknown.push(rv.sourceRef);
      continue;
    }
    const reviewable = r.outcome === 'needs_review' || (r.outcome === 'will_import' && rv.decision === 'reject');
    const mergeOk =
      rv.decision !== 'merge' ||
      (r.normalized?.category === 'contacts' &&
        rv.mergeIntoContactId !== undefined &&
        (r.matchContactId === rv.mergeIntoContactId ||
          ((r.action?.kind === 'create_contact' || r.action?.kind === 'attach_contact') && r.action.duplicateCandidates.some((d) => d.contactId === rv.mergeIntoContactId))) &&
        existing.contacts.has(rv.mergeIntoContactId));
    if (!reviewable || !mergeOk) notAllowed.push(rv.sourceRef);
    else decisions.set(rv.sourceRef, rv);
  }
  if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_RECORD', sourceRefs: unknown };
  if (notAllowed.length > 0) return { ok: false, code: 'REVIEW_NOT_ALLOWED', sourceRefs: notAllowed };

  const items: CommitItem[] = [];
  const expected: Counts = { source: dry.records.length, imported: 0, needs_review: 0, rejected: 0, duplicate: 0 };
  for (const r of dry.records) {
    const d = decisions.get(r.sourceRef);
    if (r.outcome === 'duplicate') {
      expected.duplicate += 1;
      continue;
    }
    if (r.outcome === 'rejected' || d?.decision === 'reject') {
      expected.rejected += 1;
      continue;
    }
    if (r.outcome === 'needs_review' && d === undefined) {
      expected.needs_review += 1;
      continue;
    }
    let action = r.action as PlanAction;
    if (action.kind === 'skip') {
      // A reviewed record with nothing to write (e.g. an unreadable consent value) is a no-op.
      expected.duplicate += 1;
      continue;
    }
    if (d?.decision === 'merge') {
      const target = existing.contacts.get(d.mergeIntoContactId as ContactId) as ExistingContact;
      action = { kind: 'attach_contact', contactId: target.contactId, fill: computeFill(r.normalized as NormalizedContact, target), duplicateCandidates: [] };
    }
    items.push({ sourceRef: r.sourceRef, action, normalized: r.normalized as NormalizedRecord, reviewed: d !== undefined });
    expected.imported += 1;
  }
  return { ok: true, items, expected };
}

/** Default and maximum records per commit transaction (R-IMPORT-4). */
export const COMMIT_CHUNK = 1_000;

/**
 * Resumable commit chunks (R-IMPORT-4): the items after `resumeAfter` (the last source ref a previous
 * transaction committed), in snapshot order, at most `size` (≤ 1,000) per transaction.
 */
export function commitChunks<T extends { sourceRef: string }>(items: readonly T[], opts: { size?: number; resumeAfter?: string | null } = {}): T[][] {
  const size = Math.max(1, Math.min(opts.size ?? COMMIT_CHUNK, COMMIT_CHUNK));
  let start = 0;
  if (opts.resumeAfter !== undefined && opts.resumeAfter !== null) {
    const i = items.findIndex((x) => x.sourceRef === opts.resumeAfter);
    start = i < 0 ? 0 : i + 1;
  }
  const out: T[][] = [];
  for (let i = start; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- revert (R-IMPORT-10, E43) --------------------------------------------------------------------

export type ImportedRow =
  | { table: 'contacts'; id: string; action: 'create' | 'attach' | 'update' }
  | { table: 'contact_points' | 'contact_addresses'; id: string; contactId: string }
  | { table: 'lead_ownership_events'; id: string; contactId: string }
  | { table: 'notes' | 'messages' | 'calls' | 'recordings'; id: string; contactId: string }
  | { table: 'consent_events'; id: string; event: ImportedConsentEventRow }
  | { table: 'suppressions'; id: string };

export type RevertReason =
  | 'TOUCHED' // edited, messaged or reassigned since import: a human decides
  | 'CMA_PREPARED' // a CMA was prepared for the person since import, or cites this address (D9): a human decides
  | 'PRE_EXISTING_CONTACT' // the import only filled an existing contact: never removed
  | 'REVOCATION_KEPT' // imported opt-outs stay (R-CONSENT-3)
  | 'DNC_KEPT' // imported do-not-contact flags stay
  | 'LEDGER_APPEND_ONLY' // ownership ledger rows are history (an untouched assignment is compensated: RevertPlan.unassign)
  | 'NOT_IN_STAGE'; // the row does not belong to the stage being reverted

const STAGE_TABLES: Record<Category, readonly ImportedRow['table'][]> = {
  // the contacts stage also applies the person's imported opt-outs (importedOptOuts): they stay on revert
  contacts: ['contacts', 'contact_points', 'contact_addresses', 'consent_events', 'suppressions'],
  ownership: ['lead_ownership_events'],
  notes: ['notes'],
  messages: ['messages'],
  // a FUB call's note is written by the calls stage as a notes row on the person (api/imports applyCall)
  call_recordings: ['calls', 'recordings', 'notes'],
  consent: ['consent_events', 'suppressions'],
};

export interface RevertPlan {
  /** Rows to remove (contacts: soft delete through the ownership engine; others: delete). */
  delete: string[];
  /** Compensating append-only rows: `import_revert` events voiding imported grants. */
  compensate: ConsentEventSpec[];
  /**
   * Ownership-stage rows whose contact nobody touched: the ledger row stays (append-only history) and the
   * assignment is compensated by an `import_unassign` command fenced on that row's seq (R-IMPORT-10).
   */
  unassign: { eventId: string; contactId: string }[];
  /** Rows listed for a human decision, never auto-deleted. */
  manual: string[];
  /** Rows that stay by rule (revocations, DNC, ledger history). */
  kept: string[];
  reasons: Record<string, RevertReason>;
}

/** Stages are reverted in reverse commit order (R-IMPORT-10). */
export function revertOrder(stages: readonly Category[]): Category[] {
  return [...stages].sort((a, b) => CATEGORY_INDEX[b] - CATEGORY_INDEX[a]);
}
const CATEGORY_INDEX: Record<Category, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6 };

/**
 * R-IMPORT-10 / E43: what reverting one stage does. Untouched rows are deleted (or compensated for
 * append-only tables); touched rows — or rows of a touched contact — are listed for a human; imported
 * grants are voided by `import_revert`; imported revocations and DNC flags stay.
 * `cma` (D9; batch 10 review ownership-data/F2): contacts a CMA was prepared for since the import, and addresses a
 * CMA cites. They and their rows are listed for a human with their own reason (CMA_PREPARED), never removed: the
 * soft delete would hide the person's CMA, and deleting the address would take the CMA's subject link.
 */
export function planRevert(
  stage: Category,
  imported: readonly ImportedRow[],
  touched: ReadonlySet<string>,
  ctx: { ids: IdGenerator; now: Instant },
  cma: ReadonlySet<string> = new Set(),
): RevertPlan {
  const plan: RevertPlan = { delete: [], compensate: [], unassign: [], manual: [], kept: [], reasons: {} };
  const manual = (id: string, reason: RevertReason) => {
    plan.manual.push(id);
    plan.reasons[id] = reason;
  };
  const keep = (id: string, reason: RevertReason) => {
    plan.kept.push(id);
    plan.reasons[id] = reason;
  };
  for (const row of imported) {
    if (!STAGE_TABLES[stage].includes(row.table)) {
      manual(row.id, 'NOT_IN_STAGE');
      continue;
    }
    switch (row.table) {
      case 'contacts':
        if (row.action !== 'create') manual(row.id, 'PRE_EXISTING_CONTACT');
        else if (cma.has(row.id)) manual(row.id, 'CMA_PREPARED');
        else if (touched.has(row.id)) manual(row.id, 'TOUCHED');
        else plan.delete.push(row.id);
        break;
      case 'contact_points':
      case 'contact_addresses':
      case 'notes':
      case 'messages':
      case 'calls':
      case 'recordings':
        if (cma.has(row.id) || cma.has(row.contactId)) manual(row.id, 'CMA_PREPARED');
        else if (touched.has(row.id) || touched.has(row.contactId)) manual(row.id, 'TOUCHED');
        else plan.delete.push(row.id);
        break;
      case 'lead_ownership_events':
        // the ledger is append-only: an untouched assignment is undone by a compensating event, not a delete
        if (cma.has(row.contactId)) manual(row.id, 'CMA_PREPARED');
        else if (touched.has(row.contactId)) manual(row.id, 'TOUCHED');
        else plan.unassign.push({ eventId: row.id, contactId: row.contactId });
        break;
      case 'consent_events': {
        const v = revertImportedGrant(row.event, ctx);
        if (v) plan.compensate.push(v);
        else keep(row.id, 'REVOCATION_KEPT');
        break;
      }
      case 'suppressions':
        keep(row.id, 'DNC_KEPT');
        break;
    }
  }
  return plan;
}
