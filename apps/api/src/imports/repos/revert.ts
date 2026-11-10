// Queries for reverting an import stage (R-IMPORT-10, E43). "Touched since import" means a human or
// the system did something the import did not: an ownership event not written by the import, a
// non-imported message/call/note, work attached to the contact (task, appointment, deal, saved search,
// enrollment, share, attribute, listing/showing link, a point or address the import did not add, a
// non-imported consent event), or an edit (the editable fields' fingerprint moved past what the import
// left; a history row updated after the stage committed). Touched rows are listed for a human, never deleted.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface ContactBaseline {
  /** fingerprint of the editable fields the import left (null: unknown, never counts as an edit) */
  fp: string | null;
  /** ledger head when the import wrote the contact (1 for a contact the import created) */
  seq: number;
}

/**
 * Contacts touched since the import: an ownership event after the import's baseline that the import
 * did not write, a non-imported message/call/note created since `since` (the stage approval: earlier
 * history of a pre-existing contact is not "since import"), or an edit (the editable fields differ from
 * what the import left).
 */
export async function touchedContacts(tx: Tx, batchId: string, baseline: ReadonlyMap<string, ContactBaseline>, since: Date): Promise<Set<string>> {
  const ids = [...baseline.keys()];
  if (ids.length === 0) return new Set();
  const out = new Set<string>();
  const base = JSON.stringify(ids.map((id) => ({ id, seq: baseline.get(id)!.seq })));
  const ledger = await sql<{ id: string }>`
    SELECT DISTINCT e.contact_id::text AS id
      FROM lead_ownership_events e JOIN jsonb_to_recordset(${base}::jsonb) AS b(id uuid, seq bigint) ON b.id = e.contact_id
     WHERE e.tenant_id = app.tenant_id() AND e.seq > b.seq AND e.actor_kind <> 'import'`.execute(tx);
  for (const r of ledger.rows) out.add(r.id);
  const activity = await sql<{ id: string }>`
    SELECT contact_id::text AS id FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${ids}::uuid[]) AND NOT imported AND created_at > ${since}
    UNION SELECT contact_id::text FROM calls WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${ids}::uuid[]) AND NOT imported AND created_at > ${since}
    UNION SELECT contact_id::text FROM notes WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${ids}::uuid[]) AND NOT imported AND created_at > ${since}`.execute(tx);
  for (const r of activity.rows) out.add(r.id);
  // Work a person (or the assistant on their behalf) attached to the contact since the import: a task,
  // an appointment, a deal, a saved search, an enrollment, a share, a phone/email/address the import
  // did not add, a staff-recorded consent, a listing or showing link, an attribute. Soft-deleting the
  // contact would silently take that work with it, so it is "touched" (R-IMPORT-10, E43).
  const work = await sql<{ id: string }>`
    SELECT x.id::text AS id FROM unnest(${ids}::uuid[]) AS x(id)
     WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.tenant_id = app.tenant_id() AND t.contact_id = x.id AND t.created_at > ${since} AND t.created_by_kind <> 'import')
        OR EXISTS (SELECT 1 FROM appointments a WHERE a.tenant_id = app.tenant_id() AND a.contact_id = x.id AND a.created_at > ${since})
        OR EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id = x.id AND d.created_at > ${since})
        OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                    WHERE dc.tenant_id = app.tenant_id() AND dc.contact_id = x.id AND d.updated_at > ${since})
        OR EXISTS (SELECT 1 FROM saved_searches s WHERE s.tenant_id = app.tenant_id() AND s.contact_id = x.id AND s.created_at > ${since})
        OR EXISTS (SELECT 1 FROM playbook_enrollments pe WHERE pe.tenant_id = app.tenant_id() AND pe.contact_id = x.id AND pe.created_at > ${since})
        OR EXISTS (SELECT 1 FROM contact_collaborators cc WHERE cc.tenant_id = app.tenant_id() AND cc.contact_id = x.id AND cc.created_at > ${since})
        OR EXISTS (SELECT 1 FROM contact_attributes ca WHERE ca.tenant_id = app.tenant_id() AND ca.contact_id = x.id AND ca.created_at > ${since})
        OR EXISTS (SELECT 1 FROM listing_contacts lc WHERE lc.tenant_id = app.tenant_id() AND lc.contact_id = x.id AND lc.created_at > ${since})
        OR EXISTS (SELECT 1 FROM showings sh WHERE sh.tenant_id = app.tenant_id() AND sh.buyer_contact_id = x.id AND sh.created_at > ${since})
        OR EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.contact_id = x.id AND p.created_at > ${since}
                    AND p.import_batch_id IS DISTINCT FROM ${batchId}::uuid)
        OR EXISTS (SELECT 1 FROM contact_addresses ad WHERE ad.tenant_id = app.tenant_id() AND ad.contact_id = x.id AND ad.created_at > ${since}
                    AND ad.import_batch_id IS DISTINCT FROM ${batchId}::uuid)
        OR EXISTS (SELECT 1 FROM consent_events ce WHERE ce.tenant_id = app.tenant_id() AND ce.contact_id = x.id AND NOT ce.imported
                    AND ce.recorded_at > ${since})`.execute(tx);
  for (const r of work.rows) out.add(r.id);
  const fps = await sql<{ id: string; fp: string }>`
    SELECT id::text AS id, md5(jsonb_build_array(first_name, last_name, display_name, contact_type, intent, stage, tags, imported_fields)::text) AS fp
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[])`.execute(tx);
  for (const r of fps.rows) {
    const was = baseline.get(r.id)?.fp ?? null;
    if (was !== null && r.fp !== was) out.add(r.id);
  }
  return out;
}

/** History rows edited after the stage committed. */
export async function touchedRows(tx: Tx, table: 'notes' | 'messages' | 'calls' | 'contact_points' | 'contact_addresses', ids: readonly string[], since: Date): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const t = sql.table(table);
  const r = await sql<{ id: string }>`SELECT id::text AS id FROM ${t} WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[]) AND updated_at > ${since}`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}

/** app.import_revert_delete (migration 0009): deletes only rows this stage's records wrote; returns what it deleted. */
export async function revertDelete(tx: Tx, stageId: string, table: 'notes' | 'messages' | 'calls' | 'contact_points' | 'contact_addresses', ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${stageId}::uuid, ${table}, ${[...ids]}::uuid[]) AS x`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}

export interface ImportedConsentRow {
  id: string;
  event_type: 'grant' | 'revoke' | 'resubscribe' | 'expire' | 'import_revert';
  imported: boolean;
  channel: 'sms' | 'voice' | 'email';
  purpose: 'marketing' | 'informational' | 'all';
  address_kind: 'phone' | 'email';
  hmac: string;
  address_hint: string;
  source: string;
  contact_id: string | null;
  import_record_id: string | null;
  voided: boolean;
}

export async function consentEventsByIds(tx: Tx, ids: readonly string[]): Promise<ImportedConsentRow[]> {
  if (ids.length === 0) return [];
  return (
    await sql<ImportedConsentRow>`
      SELECT e.id, e.event_type, e.imported, e.channel, e.purpose, e.address_kind, encode(e.address_hmac, 'hex') AS hmac, e.address_hint, e.source,
             e.contact_id, e.import_record_id,
             EXISTS (SELECT 1 FROM consent_events v WHERE v.tenant_id = e.tenant_id AND v.reverts_event_id = e.id) AS voided
        FROM consent_events e WHERE e.tenant_id = app.tenant_id() AND e.id = ANY (${[...ids]}::uuid[])`.execute(tx)
  ).rows;
}

/** The ledger seq of each of these ownership events (the import's own assignment: the import_unassign fence). */
export async function ownershipEventSeqs(tx: Tx, eventIds: readonly string[]): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map();
  const r = await sql<{ event_id: string; seq: string }>`
    SELECT event_id::text AS event_id, seq FROM lead_ownership_events WHERE tenant_id = app.tenant_id() AND event_id = ANY (${[...eventIds]}::uuid[])`.execute(tx);
  return new Map(r.rows.map((x) => [x.event_id, Number(x.seq)]));
}
