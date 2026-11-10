// Reads of the drift verifiers (system actor, one tenant). Ledgers hold ids, codes and instants only;
// no contact name, phone or email is selected.
import type { ConsentEvent } from '@realty/core/compliance';
import type { ContactId, Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { OwnershipEvent, OwnershipProjection } from '@realty/core/ownership';
import { type Tx, eventOf, projectionOf } from '@realty/db';
import { sql } from 'kysely';

type ContactRow = Parameters<typeof projectionOf>[0];
type LedgerRow = Parameters<typeof eventOf>[0];

/** Contacts with ledger events since `since`, plus a `samplePct` random sample of all contacts (≤ max). */
export async function driftCandidates(tx: Tx, since: Instant, samplePct: number, max: number): Promise<ContactId[]> {
  const r = await sql<{ id: string }>`
    (SELECT DISTINCT e.contact_id AS id FROM lead_ownership_events e
      WHERE e.tenant_id = app.tenant_id() AND e.occurred_at >= ${toIso(since)}::timestamptz)
    UNION
    (SELECT c.id FROM contacts c WHERE c.tenant_id = app.tenant_id() AND random() < ${samplePct / 100})
    LIMIT ${max}`.execute(tx);
  return r.rows.map((x) => x.id as ContactId).sort();
}

/** Stored projections and full ledgers of `ids`. */
export async function projectionsAndLedgers(tx: Tx, ids: readonly ContactId[]): Promise<Map<ContactId, { stored: OwnershipProjection; events: OwnershipEvent[] }>> {
  const out = new Map<ContactId, { stored: OwnershipProjection; events: OwnershipEvent[] }>();
  if (ids.length === 0) return out;
  const c = await sql<ContactRow>`
    SELECT id, ownership_state, owner_user_id, pond_id, offer_id, offered_to_user_id, offer_expires_at, offer_round,
           routing_rule_id, owned_at, first_touch_due_at, first_touch_at, first_touch_breached_at, release_due_at,
           ownership_period_seq, route_due_at, closed_reason, ownership_seq, ownership_command_id, ownership_actor_user_id,
           stage, timezone, last_human_touch_at, inactivity_warn_at, inactivity_release_at, deleted_at, merged_into_contact_id
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  for (const row of c.rows) out.set(row.id as ContactId, { stored: projectionOf(row), events: [] });
  const l = await sql<LedgerRow>`
    SELECT * FROM lead_ownership_events WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[])
     ORDER BY contact_id, seq`.execute(tx);
  for (const row of l.rows) out.get(row.contact_id as ContactId)?.events.push(eventOf(row));
  return out;
}

export interface StoredConsentRow {
  channel: ConsentEvent['channel'];
  purpose: 'marketing' | 'informational';
  addressHmacHex: string;
  status: string;
  level: string;
  basisEventId: string | null;
  expiresAt: Instant | null;
  ledgerEventCount: number;
  computedAt: Instant;
}

/** consent_state rows computed since `since`, plus a `samplePct` random sample (≤ max). */
export async function consentCandidates(tx: Tx, since: Instant, samplePct: number, max: number): Promise<StoredConsentRow[]> {
  const r = await sql<{
    channel: ConsentEvent['channel'];
    purpose: StoredConsentRow['purpose'];
    address_hmac: Buffer;
    status: string;
    consent_level: string;
    basis_event_id: string | null;
    expires_at: Date | null;
    ledger_event_count: number;
    computed_at: Date;
  }>`
    SELECT channel, purpose, address_hmac, status, consent_level, basis_event_id, expires_at, ledger_event_count, computed_at
      FROM consent_state
     WHERE tenant_id = app.tenant_id() AND (computed_at >= ${toIso(since)}::timestamptz OR random() < ${samplePct / 100})
     ORDER BY channel, purpose, address_hmac
     LIMIT ${max}`.execute(tx);
  return r.rows.map((x) => ({
    channel: x.channel,
    purpose: x.purpose,
    addressHmacHex: x.address_hmac.toString('hex'),
    status: x.status,
    level: x.consent_level,
    basisEventId: x.basis_event_id,
    expiresAt: x.expires_at ? instantFromDate(x.expires_at) : null,
    ledgerEventCount: x.ledger_event_count,
    computedAt: instantFromDate(x.computed_at),
  }));
}
