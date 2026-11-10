// Imported consent (R-CONSENT-3, R-IMPORT-10 consent part, R-IMPORT-13; E39, E40, E43).
//
// Imports never manufacture consent:
// - every positive indicator becomes a `grant` at exactly `imported_unverified` (the DB CHECK and
//   `validateConsentEventSpec` agree; the fold caps it again), with the verbatim provenance;
// - opt-out / unsubscribe indicators become full-strength `revoke`s dated at the COMMIT instant, so
//   they take effect at commit (an older source date would let a later grant outrank them);
// - do-not-contact becomes an `import_dnc` suppression on every channel;
// - a revert voids imported grants with `import_revert` and never touches a revocation or a DNC flag.
//
// The purposes below are the strictest reading available; they are policy, not law:
// VERIFY WITH COUNSEL.
import type { IdGenerator, Instant } from '../foundation/index.js';
import {
  type AddressKind,
  type Channel,
  type ConsentEventSpec,
  type ConsentEventType,
  type EventPurpose,
  validateConsentEventSpec,
} from '../compliance/index.js';
import { addressHint } from './text.js';
import type { FubConsentFields } from './types.js';

/** An imported opt-out applies to every purpose on its channel. VERIFY WITH COUNSEL. */
export const IMPORTED_REVOKE_PURPOSE: EventPurpose = 'all';
/** An imported grant is history only (capped level), recorded for the purpose the source stated: any. VERIFY WITH COUNSEL. */
export const IMPORTED_GRANT_PURPOSE: EventPurpose = 'all';

export type ImportSource = 'import_fub' | 'import_csv';

export interface ConsentMapContext {
  ids: IdGenerator;
  /** The commit instant (DB clock of the commit transaction). */
  now: Instant;
  /** Tenant HMAC (lower-case hex) of a normalized address; computed by the API, never in core. */
  hmac(kind: AddressKind, normalized: string): string;
  source: ImportSource;
  /** The local contact the record is linked to, when there is one (context only, R-CONSENT-1). */
  contactId: string | null;
  importRecordId: string;
}

/** Insert shape of an imported `suppressions` row (reason `import_dnc` ⇔ imported, DB CHECK). */
export interface ImportedSuppressionSpec {
  id: string;
  addressKind: AddressKind;
  addressHmac: string;
  addressHint: string;
  channel: 'all';
  reason: 'import_dnc';
  sourceRef: Record<string, unknown>;
  imported: true;
  importRecordId: string;
}

function channelFits(kind: AddressKind, c: Channel): boolean {
  return kind === 'email' ? c === 'email' : c !== 'email';
}

function assertValid(spec: ConsentEventSpec): ConsentEventSpec {
  const issues = validateConsentEventSpec(spec);
  // Every spec built here satisfies the consent_events CHECKs by construction; a violation is a bug.
  if (issues.length > 0) throw new Error(`core/import built an invalid consent event: ${issues.join(', ')}`);
  return spec;
}

/**
 * The consent events for one imported record. Grants are capped at `imported_unverified`; revokes
 * are full strength at `ctx.now`. A channel that is both granted and revoked yields only the revoke.
 */
export function mapImportedConsent(raw: FubConsentFields, provenance: Record<string, unknown>, ctx: ConsentMapContext): ConsentEventSpec[] {
  const out: ConsentEventSpec[] = [];
  const grantAt = raw.occurredAt !== null && raw.occurredAt < ctx.now ? raw.occurredAt : ctx.now;
  for (const a of raw.addresses) {
    const hmac = ctx.hmac(a.kind, a.address);
    const hint = addressHint(a.kind, a.address);
    const revokes = [...new Set(a.revokes)].filter((c) => channelFits(a.kind, c));
    const grants = [...new Set(a.grants)].filter((c) => channelFits(a.kind, c) && !revokes.includes(c));
    const base = {
      addressKind: a.kind,
      addressHmac: hmac,
      addressHint: hint,
      source: ctx.source,
      contactId: ctx.contactId,
      actor: { kind: 'system' } as const,
      disclosureId: null,
      evidenceObjectId: null,
      evidenceMessageId: null,
      evidenceCallId: null,
      evidenceCallOffsetMs: null,
      evidence: {},
      imported: true,
      importRecordId: ctx.importRecordId,
      originalProvenance: provenance,
      revertsEventId: null,
      expiresAt: null,
      needsReview: false,
    };
    for (const channel of grants) {
      out.push(assertValid({ ...base, id: ctx.ids.next<'ConsentEventId'>(), channel, purpose: IMPORTED_GRANT_PURPOSE, eventType: 'grant', level: 'imported_unverified', occurredAt: grantAt }));
    }
    for (const channel of revokes) {
      out.push(assertValid({ ...base, id: ctx.ids.next<'ConsentEventId'>(), channel, purpose: IMPORTED_REVOKE_PURPOSE, eventType: 'revoke', level: 'none', occurredAt: ctx.now }));
    }
  }
  return out;
}

/** Do-not-contact flags become `import_dnc` suppressions on every channel (never lifted by a revert). */
export function mapImportedSuppressions(raw: FubConsentFields, ctx: Omit<ConsentMapContext, 'now' | 'contactId'>): ImportedSuppressionSpec[] {
  return raw.addresses
    .filter((a) => a.doNotContact)
    .map((a) => ({
      id: ctx.ids.next<'SuppressionId'>(),
      addressKind: a.kind,
      addressHmac: ctx.hmac(a.kind, a.address),
      addressHint: addressHint(a.kind, a.address),
      channel: 'all',
      reason: 'import_dnc',
      sourceRef: { source: ctx.source, importRecordId: ctx.importRecordId },
      imported: true,
      importRecordId: ctx.importRecordId,
    }));
}

/** What a stored imported consent event must provide to be reverted. */
export interface ImportedConsentEventRow {
  id: string;
  eventType: ConsentEventType;
  imported: boolean;
  channel: Channel;
  purpose: EventPurpose;
  addressKind: AddressKind;
  addressHmac: string;
  addressHint: string;
  source: ConsentEventSpec['source'];
  contactId: string | null;
  importRecordId: string | null;
}

/**
 * R-IMPORT-10 / E43: the `import_revert` that voids one imported grant, or null when the row must
 * stay (a revocation, a non-imported event, or anything that is not a grant).
 */
export function revertImportedGrant(row: ImportedConsentEventRow, ctx: { ids: IdGenerator; now: Instant }): ConsentEventSpec | null {
  if (!row.imported || row.eventType !== 'grant' || row.importRecordId === null) return null;
  return assertValid({
    id: ctx.ids.next<'ConsentEventId'>(),
    addressKind: row.addressKind,
    addressHmac: row.addressHmac,
    addressHint: row.addressHint,
    channel: row.channel,
    purpose: row.purpose,
    eventType: 'import_revert',
    level: 'none',
    source: row.source,
    occurredAt: ctx.now,
    contactId: row.contactId,
    actor: { kind: 'system' },
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: null,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: {},
    imported: true,
    importRecordId: row.importRecordId,
    originalProvenance: { reverts: row.id },
    revertsEventId: row.id,
    expiresAt: null,
    needsReview: false,
  });
}

/** Re-run idempotency key of one imported consent event (R-IMPORT-9 for the consent stage). */
export function importedConsentKey(addressKey: string, channel: Channel, eventType: 'grant' | 'revoke' | 'dnc'): string {
  return `${eventType}:${channel}:${addressKey}`;
}

/** The idempotency keys a record would write (`dnc` keys use channel `sms` for phones, `email` for emails). */
export function plannedConsentKeys(raw: FubConsentFields, keyOf: (kind: AddressKind, normalized: string) => string): string[] {
  const keys: string[] = [];
  for (const a of raw.addresses) {
    const k = keyOf(a.kind, a.address);
    const revokes = new Set(a.revokes.filter((c) => channelFits(a.kind, c)));
    for (const c of new Set(a.grants)) if (channelFits(a.kind, c) && !revokes.has(c)) keys.push(importedConsentKey(k, c, 'grant'));
    for (const c of revokes) keys.push(importedConsentKey(k, c, 'revoke'));
    if (a.doNotContact) keys.push(importedConsentKey(k, a.kind === 'email' ? 'email' : 'sms', 'dnc'));
  }
  return keys;
}
