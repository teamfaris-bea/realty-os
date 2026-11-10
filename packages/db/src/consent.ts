// Consent persistence (R-CONSENT-1, R-CONSENT-2, R-CONSENT-6).
//
//   recordConsentEvent(tx, spec)
//     app.lock_address(hmac) → INSERT consent_events → re-read the key's ledger →
//     core.projectConsent(events, now) → upsert consent_state with ledger_event_count
//
// - Keyed by (channel, purpose, address HMAC), never by contact (R-CONSENT-1).
// - The projection is written in the SAME transaction as the event; the DB guard
//   (consent_state_guard) rejects a row whose ledger_event_count differs from the ledger, so a
//   projection computed from a stale read can never be stored (CONSENT_PROJECTION_STALE).
// - The address lock serializes concurrent writers of one key, so the re-read sees every committed
//   event and the count always matches.
import { type ConsentEvent, type ConsentEventSpec, type ConsentStateRow, PURPOSES, projectConsent, validateConsentEventSpec } from '@realty/core/compliance';
import type { Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { sql } from 'kysely';
import { hmacBytes, lockAddress } from './locks.js';
import { dbNow, type Tx } from './tenantTx.js';

/**
 * The caller cannot read the ledger of the address it just wrote to (consent_events SELECT needs a
 * tenant-wide actor or a visible contact point with that HMAC), so the projection cannot be rebuilt
 * in this transaction. Fail closed: storing the event without its consent_state row would leave a
 * stale projection that the gate reads (R-CONSENT-6). Record it as the system actor, or on a contact
 * point the caller can see.
 */
export class ConsentLedgerNotVisibleError extends Error {
  override readonly name = 'ConsentLedgerNotVisibleError';
}

export class ConsentSpecError extends TypeError {
  override readonly name = 'ConsentSpecError';
  constructor(readonly issues: string[]) {
    super(`invalid consent event: ${issues.join(', ')}`);
  }
}

interface ConsentEventRow {
  id: string;
  channel: ConsentEvent['channel'];
  purpose: ConsentEvent['purpose'];
  address_hmac: Buffer;
  event_type: ConsentEvent['eventType'];
  consent_level: ConsentEvent['level'];
  source: ConsentEvent['source'];
  occurred_at: Date;
  imported: boolean;
  actor_kind: 'user' | 'system';
  disclosure_id: string | null;
  evidence_object_id: string | null;
  reverts_event_id: string | null;
  expires_at: Date | null;
  evidence: Record<string, unknown>;
}

function toEvent(r: ConsentEventRow): ConsentEvent {
  return {
    id: r.id,
    channel: r.channel,
    purpose: r.purpose,
    addressHmac: r.address_hmac.toString('hex'),
    eventType: r.event_type,
    level: r.consent_level,
    source: r.source,
    occurredAt: instantFromDate(r.occurred_at),
    imported: r.imported,
    actorKind: r.actor_kind,
    disclosureId: r.disclosure_id,
    evidenceObjectId: r.evidence_object_id,
    revertsEventId: r.reverts_event_id,
    expiresAt: r.expires_at ? instantFromDate(r.expires_at) : null,
    evidence: r.evidence,
  };
}

/** Every ledger event for (channel, address) in the current tenant (visible under the caller's RLS). */
export async function loadConsentEvents(tx: Tx, channel: ConsentEvent['channel'], addressHmacHex: string): Promise<ConsentEvent[]> {
  const r = await sql<ConsentEventRow>`
    SELECT id, channel, purpose, address_hmac, event_type, consent_level, source, occurred_at, imported, actor_kind,
           disclosure_id, evidence_object_id, reverts_event_id, expires_at, evidence
      FROM consent_events
     WHERE tenant_id = app.tenant_id() AND channel = ${channel} AND address_hmac = ${hmacBytes(addressHmacHex)}
     ORDER BY occurred_at, id`.execute(tx);
  return r.rows.map(toEvent);
}

/** Writes consent_state rows exactly as core projected them (guarded by ledger_event_count). */
export async function upsertConsentState(tx: Tx, rows: readonly ConsentStateRow[], now: Instant): Promise<void> {
  for (const row of rows) {
    await sql`
      INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id,
                                 expires_at, ledger_event_count, computed_at)
      VALUES (app.tenant_id(), ${row.channel}, ${row.purpose}, ${hmacBytes(row.addressHmac)}, ${row.status}, ${row.level},
              ${row.basisEventId}, ${row.expiresAt === null ? null : toIso(row.expiresAt)}::timestamptz,
              ${row.ledgerEventCount}, ${toIso(now)}::timestamptz)
      ON CONFLICT (tenant_id, channel, purpose, address_hmac) DO UPDATE SET
        status = EXCLUDED.status, consent_level = EXCLUDED.consent_level, basis_event_id = EXCLUDED.basis_event_id,
        expires_at = EXCLUDED.expires_at, ledger_event_count = EXCLUDED.ledger_event_count,
        computed_at = EXCLUDED.computed_at`.execute(tx);
  }
}

/**
 * Appends one consent event and rewrites the projection of every key it belongs to (purpose `all`
 * → both purposes). Returns the projected rows of those keys. Runs in the caller's transaction.
 */
export async function recordConsentEvent(tx: Tx, e: ConsentEventSpec): Promise<ConsentStateRow[]> {
  const issues = validateConsentEventSpec(e);
  if (issues.length > 0) throw new ConsentSpecError(issues);
  const hmac = hmacBytes(e.addressHmac);
  await lockAddress(tx, e.addressHmac);
  const actorUserId = e.actor.kind === 'user' ? e.actor.userId : null;
  await sql`
    INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type,
      consent_level, source, occurred_at, contact_id, actor_kind, actor_user_id, disclosure_id, evidence_object_id,
      evidence_message_id, evidence_call_id, evidence_call_offset_ms, evidence, imported, import_record_id,
      original_provenance, reverts_event_id, expires_at, needs_review)
    VALUES (app.tenant_id(), ${e.id}, ${e.addressKind}, ${hmac}, ${e.addressHint}, ${e.channel}, ${e.purpose}, ${e.eventType},
      ${e.level}, ${e.source}, ${toIso(e.occurredAt)}::timestamptz, ${e.contactId}, ${e.actor.kind}, ${actorUserId},
      ${e.disclosureId}, ${e.evidenceObjectId}, ${e.evidenceMessageId}, ${e.evidenceCallId}, ${e.evidenceCallOffsetMs},
      ${JSON.stringify(e.evidence)}::jsonb, ${e.imported}, ${e.importRecordId},
      ${e.originalProvenance === null ? null : JSON.stringify(e.originalProvenance)}::jsonb, ${e.revertsEventId},
      ${e.expiresAt === null ? null : toIso(e.expiresAt)}::timestamptz, ${e.needsReview})`.execute(tx);
  const now = await dbNow(tx);
  const events = await loadConsentEvents(tx, e.channel, e.addressHmac);
  if (!events.some((x) => x.id === e.id)) {
    throw new ConsentLedgerNotVisibleError('consent event written but its address ledger is not visible to this actor: projection cannot be rebuilt');
  }
  const projected = projectConsent(events, now);
  const purposes = e.purpose === 'all' ? PURPOSES : [e.purpose];
  const rows = [...projected.values()].filter((r) => purposes.includes(r.purpose));
  await upsertConsentState(tx, rows, now);
  return rows;
}
