// What the dry run matches against (core/import ExistingIndexInput): the tenant's contacts with their
// normalized points, external_refs, current opt-outs and imported consent keys. Read as the system
// actor (tenant-wide) inside the dry-run transaction. Address keys are the stored tenant HMACs (hex);
// plaintext addresses are only used to match the snapshot's own normalized addresses.
import type { Channel } from '@realty/core/compliance';
import type { ContactId, UserId } from '@realty/core/foundation';
import type { ExistingContact, ExternalEntityType } from '@realty/core/import';
import { instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface ExistingSnapshot {
  contacts: ExistingContact[];
  /** `${kind}:${normalized}` → HMAC hex, for every stored point */
  hmacs: Map<string, string>;
}

/**
 * The dry run reads the whole book (every contact and point, each through RLS) in one bulk-job
 * transaction. At 250k contacts that is longer than the pool's 30 s per-statement safety net, which made
 * the job fail every time (lane scale-250k); this transaction gets a bulk-sized limit instead.
 */
export const BULK_STATEMENT_TIMEOUT = '10min';

export async function loadContacts(tx: Tx, only?: readonly string[]): Promise<ExistingSnapshot> {
  if (!only) await sql`SELECT set_config('statement_timeout', ${BULK_STATEMENT_TIMEOUT}, true)`.execute(tx);
  const filter = only ? sql`AND c.id = ANY (${[...only]}::uuid[])` : sql``;
  const rows = await sql<{
    id: string;
    created_at: Date;
    ownership_state: ExistingContact['ownershipState'];
    closed_reason: string | null;
    owner_user_id: string | null;
    merged_into_contact_id: string | null;
    import_batch_id: string | null;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    intent: ExistingContact['intent'];
    tags: string[];
    keys: string[] | null;
    has_address: boolean;
  }>`
    SELECT c.id, c.created_at, c.ownership_state, c.closed_reason, c.owner_user_id, c.merged_into_contact_id, c.import_batch_id,
           c.display_name, c.first_name, c.last_name, c.intent, c.tags,
           (SELECT array_agg(k) FROM jsonb_object_keys(c.imported_fields) k) AS keys,
           EXISTS (SELECT 1 FROM contact_addresses a WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id) AS has_address
      FROM contacts c WHERE c.tenant_id = app.tenant_id() ${filter}`.execute(tx);
  const pts = await sql<{ contact_id: string; kind: 'phone' | 'email'; address: string; hmac: string }>`
    SELECT p.contact_id, p.kind, p.address, encode(p.address_hmac, 'hex') AS hmac FROM contact_points p
     WHERE p.tenant_id = app.tenant_id() AND p.status <> 'removed' ${only ? sql`AND p.contact_id = ANY (${[...only]}::uuid[])` : sql``}`.execute(tx);
  const phones = new Map<string, string[]>();
  const emails = new Map<string, string[]>();
  const hmacs = new Map<string, string>();
  for (const p of pts.rows) {
    const m = p.kind === 'phone' ? phones : emails;
    const l = m.get(p.contact_id) ?? [];
    l.push(p.address);
    m.set(p.contact_id, l);
    hmacs.set(`${p.kind}:${p.address}`, p.hmac);
  }
  const contacts: ExistingContact[] = rows.rows.map((c) => ({
    contactId: c.id as ContactId,
    createdAt: instantFromDate(c.created_at),
    ownershipState: c.ownership_state,
    closedReason: c.closed_reason,
    ownerUserId: c.owner_user_id as UserId | null,
    mergedIntoContactId: c.merged_into_contact_id as ContactId | null,
    importBatchId: c.import_batch_id,
    displayName: c.display_name,
    firstName: c.first_name,
    lastName: c.last_name,
    intent: c.intent,
    phones: phones.get(c.id) ?? [],
    emails: emails.get(c.id) ?? [],
    tags: c.tags,
    importedFieldKeys: c.keys ?? [],
    hasAddress: c.has_address,
  }));
  return { contacts, hmacs };
}

export async function loadExternalRefs(tx: Tx, system: 'fub' | 'csv'): Promise<{ entityType: ExternalEntityType; externalId: string; entityId: string }[]> {
  const r = await sql<{ entity_type: ExternalEntityType; external_id: string; entity_id: string }>`
    SELECT entity_type, external_id, entity_id FROM external_refs WHERE tenant_id = app.tenant_id() AND system = ${system}`.execute(tx);
  return r.rows.map((x) => ({ entityType: x.entity_type, externalId: x.external_id, entityId: x.entity_id }));
}

const ALL: Channel[] = ['sms', 'voice', 'email'];

/** Address HMAC (hex) → channels revoked (consent_state) or suppressed (active suppressions) now. */
export async function loadOptedOut(tx: Tx): Promise<{ key: string; channel: Channel }[]> {
  const out: { key: string; channel: Channel }[] = [];
  const cs = await sql<{ key: string; channel: Channel }>`
    SELECT DISTINCT encode(address_hmac, 'hex') AS key, channel FROM consent_state WHERE tenant_id = app.tenant_id() AND status = 'revoked'`.execute(tx);
  out.push(...cs.rows);
  const sp = await sql<{ key: string; channel: Channel | 'all' }>`
    SELECT DISTINCT encode(address_hmac, 'hex') AS key, channel FROM suppressions WHERE tenant_id = app.tenant_id() AND lifted_at IS NULL`.execute(tx);
  for (const s of sp.rows) {
    if (s.channel === 'all') for (const c of ALL) out.push({ key: s.key, channel: c });
    else out.push({ key: s.key, channel: s.channel });
  }
  return out;
}

/**
 * Imported consent already in the ledger (core `importedConsentKey`): imported grants not voided by an
 * import_revert, imported revokes, and active import_dnc suppressions (R-IMPORT-9 for the consent stage).
 */
export async function loadImportedConsentKeys(tx: Tx): Promise<string[]> {
  const ev = await sql<{ k: string }>`
    SELECT DISTINCT e.event_type || ':' || e.channel || ':' || encode(e.address_hmac, 'hex') AS k
      FROM consent_events e
     WHERE e.tenant_id = app.tenant_id() AND e.imported AND e.event_type IN ('grant','revoke')
       AND NOT EXISTS (SELECT 1 FROM consent_events v WHERE v.tenant_id = e.tenant_id AND v.reverts_event_id = e.id)`.execute(tx);
  const dnc = await sql<{ k: string }>`
    SELECT DISTINCT 'dnc:' || CASE address_kind WHEN 'email' THEN 'email' ELSE 'sms' END || ':' || encode(address_hmac, 'hex') AS k
      FROM suppressions WHERE tenant_id = app.tenant_id() AND reason = 'import_dnc' AND lifted_at IS NULL`.execute(tx);
  return [...ev.rows.map((r) => r.k), ...dnc.rows.map((r) => r.k)];
}
