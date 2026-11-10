// Intake queries (BUILD_PLAN module 11; R-OWN-25, A7d attribution). They run as the SYSTEM actor
// of the tenant the lead-source token resolved to (tenant-wide inside that one tenant, R-TEN-3), so
// the dedup lookups see every contact of the tenant, which is what R-OWN-25 needs. Nothing they
// return reaches the HTTP response beyond the contact id and the outcome code.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface LeadSourceRow {
  id: string;
  name: string;
  kind: string;
  consent_disclosure_id: string | null;
  active: boolean;
}

export async function leadSource(tx: Tx, id: string): Promise<LeadSourceRow | null> {
  const r = await sql<LeadSourceRow>`
    SELECT id, name, kind, consent_disclosure_id, active FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export interface PriorInquiryRow {
  id: string;
  contact_id: string;
  lead_source_id: string;
  external_id: string | null;
  fingerprint: string;
  received_at: Date;
}

/** Earlier inquiries with this (source, external id), or this fingerprint inside the window. */
export async function priorInquiries(tx: Tx, sourceId: string, externalId: string | null, fingerprint: string, since: string, until: string): Promise<PriorInquiryRow[]> {
  const r = await sql<PriorInquiryRow>`
    SELECT id, contact_id, lead_source_id, external_id, fingerprint, received_at FROM lead_inquiries
     WHERE tenant_id = app.tenant_id()
       AND ((${externalId}::text IS NOT NULL AND lead_source_id = ${sourceId}::uuid AND external_id = ${externalId}::text)
            OR (fingerprint = ${fingerprint} AND received_at > ${since}::timestamptz AND received_at < ${until}::timestamptz))
     ORDER BY received_at, id`.execute(tx);
  return r.rows;
}

export interface ExactMatchRow {
  contact_id: string;
  created_at: Date;
  ownership_state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  closed_reason: string | null;
  hmac: string;
}

/** How many merge hops an inquiry is redirected along (R-OWN-20: closed as merged ⇒ merged_into, depth ≤ 5). */
export const MERGE_REDIRECT_DEPTH = 5;

/**
 * Live contacts holding one of these address HMACs. A merge leaves the loser's phones and emails on
 * the closed loser, so a hit on a merged-away contact is redirected along merged_into (≤ 5 hops) to
 * the surviving contact (R-OWN-20). Soft-deleted contacts never match (and end a chain).
 */
export async function exactMatches(tx: Tx, hmacsHex: readonly string[]): Promise<ExactMatchRow[]> {
  if (hmacsHex.length === 0) return [];
  const r = await sql<ExactMatchRow>`
    WITH RECURSIVE hit AS (
      SELECT c.id AS cur, c.merged_into_contact_id AS nxt, encode(p.address_hmac, 'hex') AS hmac, 0 AS depth
        FROM contact_points p
        JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = app.tenant_id() AND p.removed_at IS NULL
         AND p.address_hmac = ANY (ARRAY(SELECT decode(x, 'hex') FROM unnest(${[...hmacsHex]}::text[]) x))
         AND c.deleted_at IS NULL
      UNION ALL
      SELECT c.id, c.merged_into_contact_id, h.hmac, h.depth + 1
        FROM hit h JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = h.nxt
       WHERE h.depth < ${MERGE_REDIRECT_DEPTH} AND c.deleted_at IS NULL)
    SELECT DISTINCT c.id AS contact_id, c.created_at, c.ownership_state, c.closed_reason, h.hmac
      FROM hit h JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = h.cur
     WHERE h.nxt IS NULL
     ORDER BY c.created_at, c.id`.execute(tx);
  return r.rows;
}

export interface FuzzyMatchRow {
  contact_id: string;
  created_at: Date;
  ownership_state: ExactMatchRow['ownership_state'];
  closed_reason: string | null;
  sim: number;
  same_postal: boolean;
}

/** Name similarity candidates (pg_trgm), never attached automatically (R-OWN-25). */
export async function fuzzyMatches(tx: Tx, name: string, postal: string | null, threshold: number): Promise<FuzzyMatchRow[]> {
  const r = await sql<FuzzyMatchRow>`
    SELECT c.id AS contact_id, c.created_at, c.ownership_state, c.closed_reason,
           similarity(c.display_name, ${name})::float8 AS sim,
           (${postal}::text IS NOT NULL AND (
              EXISTS (SELECT 1 FROM lead_inquiries i WHERE i.tenant_id = c.tenant_id AND i.contact_id = c.id AND i.postal_code = ${postal}::text)
              OR EXISTS (SELECT 1 FROM contact_addresses a WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id AND a.postal_code = ${postal}::text)))
             AS same_postal
      FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
       AND c.display_name % ${name} AND similarity(c.display_name, ${name}) >= ${threshold}
     ORDER BY sim DESC, c.created_at, c.id LIMIT 5`.execute(tx);
  return r.rows;
}

export interface InquiryInsert {
  id: string;
  contactId: string;
  leadSourceId: string;
  externalId: string | null;
  receivedAt: string;
  inquiryType: string;
  message: string | null;
  propertyText: string | null;
  postalCode: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  campaignRef: string | null;
  adRef: string | null;
  sourceDetail: Record<string, string | number | boolean>;
  consentDisclosureId: string | null;
  rawPayloadEnc: Uint8Array | null;
  fingerprint: string;
  outcome: 'new_contact' | 'attached' | 'reinquiry' | 'duplicate_ignored';
}

export async function insertInquiry(tx: Tx, i: InquiryInsert): Promise<void> {
  await sql`
    INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, external_id, received_at, inquiry_type, message,
                                property_text, postal_code, price_min_cents, price_max_cents, campaign_ref, ad_ref,
                                source_detail, consent_disclosure_id, raw_payload_enc, fingerprint, outcome)
    VALUES (app.tenant_id(), ${i.id}::uuid, ${i.contactId}::uuid, ${i.leadSourceId}::uuid, ${i.externalId}, ${i.receivedAt}::timestamptz,
            ${i.inquiryType}, ${i.message}, ${i.propertyText}, ${i.postalCode}, ${i.priceMinCents}, ${i.priceMaxCents},
            ${i.campaignRef}, ${i.adRef}, ${JSON.stringify(i.sourceDetail)}::jsonb, ${i.consentDisclosureId}::uuid,
            ${i.rawPayloadEnc === null ? null : Buffer.from(i.rawPayloadEnc)}, ${i.fingerprint}, ${i.outcome})`.execute(tx);
}

/** The card narrative a pond / offer viewer sees (R-PERM-6): structured, PII-free facts only. */
export async function setPondSummary(tx: Tx, contactId: string, summary: string | null): Promise<void> {
  await sql`UPDATE contacts SET pond_summary = ${summary} WHERE tenant_id = app.tenant_id() AND id = ${contactId}::uuid
              AND pond_summary IS DISTINCT FROM ${summary}`.execute(tx);
}

export async function contactState(tx: Tx, contactId: string): Promise<{ ownership_state: ExactMatchRow['ownership_state']; closed_reason: string | null } | null> {
  const r = await sql<{ ownership_state: ExactMatchRow['ownership_state']; closed_reason: string | null }>`
    SELECT ownership_state, closed_reason FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

// ---- lead sources (Owner/Admin) --------------------------------------------------------------------

export async function listLeadSources(tx: Tx): Promise<(LeadSourceRow & { has_token: boolean; created_at: Date })[]> {
  const r = await sql<LeadSourceRow & { has_token: boolean; created_at: Date }>`
    SELECT id, name, kind, consent_disclosure_id, active, ingest_token_hash IS NOT NULL AS has_token, created_at
      FROM lead_sources WHERE tenant_id = app.tenant_id() ORDER BY name`.execute(tx);
  return r.rows;
}

export async function insertLeadSource(tx: Tx, id: string, name: string, kind: string, tokenHash: Buffer | null): Promise<void> {
  await sql`INSERT INTO lead_sources (tenant_id, id, name, kind, ingest_token_hash) VALUES (app.tenant_id(), ${id}::uuid, ${name}, ${kind}, ${tokenHash})`.execute(tx);
}
