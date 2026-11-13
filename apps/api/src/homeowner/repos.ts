// SQL of module 78 api/homeowner (owner decision D10). Every write names homeowner_profiles or
// homeowner_profile_facts only (architecture test), runs as the tenant's system actor (the migration's write
// policies) and never touches contacts, addresses, tags, deals, intent, stage or ownership (R-HOME-6, R-HOME-7). Names are read
// for the in-memory attach decision only: never written, hashed or logged.
import type { Tx } from '@realty/db';
import { sql, type RawBuilder } from 'kysely';
import { avmPurchaseClosedAt, avmQualifies } from '../nurture/repos.js';

/**
 * Recognition (R-HOME-1) of contact alias `c`: seller intent, a sell or value inquiry, a homeowner tag (never a
 * protected-proxy tag), or K2 (a past buyer who now owns: nurture/repos.ts avmQualifies on any of their addresses).
 */
export function recognizedSql(keys: readonly string[]): RawBuilder<unknown> {
  return sql`(
    COALESCE(c.intent IN ('seller','buyer_seller'), false)
    OR EXISTS (SELECT 1 FROM lead_inquiries li WHERE li.tenant_id = c.tenant_id AND li.contact_id = c.id AND li.inquiry_type IN ('sell','value'))
    OR EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
                WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id AND t.name_key = ANY (${[...keys]}::text[]) AND NOT t.protected_proxy)
    OR EXISTS (SELECT 1 FROM contact_addresses ka WHERE ka.tenant_id = c.tenant_id AND ka.contact_id = c.id AND ${avmQualifies('c', 'ka')}))`;
}

/** A contact that may hold a profile: live, unmerged, not closed and not do-not-contact (alias `c`). */
const LIVE = sql`c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL AND c.ownership_state <> 'closed' AND c.do_not_contact_at IS NULL`;

export async function tenantClock(tx: Tx): Promise<{ tz: string; localDate: string; localHour: number }> {
  const r = await sql<{ tz: string; local_date: string; local_hour: number }>`
    SELECT s.default_timezone AS tz, (now() AT TIME ZONE s.default_timezone)::date::text AS local_date,
           extract(hour FROM now() AT TIME ZONE s.default_timezone)::int AS local_hour
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const row = r.rows[0];
  if (!row) throw new Error('HOMEOWNER_NO_TENANT_SETTINGS');
  return { tz: row.tz, localDate: row.local_date, localHour: row.local_hour };
}

const n = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0);

/** Step 0: the bounded purge (R-HOME-9; E568, E569, E587). Facts cascade with their profile. */
export async function purgeProfiles(tx: Tx, keys: readonly string[], limit: number): Promise<{ expired: number; ineligible: number }> {
  const expired = n(await sql`
    DELETE FROM homeowner_profiles WHERE tenant_id = app.tenant_id() AND id IN (
      SELECT id FROM homeowner_profiles WHERE tenant_id = app.tenant_id() AND retention_until <= now() LIMIT ${limit})`.execute(tx));
  const ineligible = n(await sql`
    DELETE FROM homeowner_profiles WHERE tenant_id = app.tenant_id() AND id IN (
      SELECT p.id FROM homeowner_profiles p
        JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
        JOIN contact_addresses a ON a.tenant_id = p.tenant_id AND a.id = p.contact_address_id
       WHERE p.tenant_id = app.tenant_id()
         AND (NOT (${LIVE}) OR NOT ${recognizedSql(keys)}
              OR (a.kind IN ('mailing','interest') AND NOT ${avmQualifies('c', 'a')}))
       LIMIT ${limit})`.execute(tx));
  return { expired, ineligible };
}

/** Lookups already made on the local date (answered or failed), for the daily budget (E586). */
export async function lookupsOnDate(tx: Tx, tz: string, localDate: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM homeowner_profiles p
     WHERE p.tenant_id = app.tenant_id()
       AND ((p.checked_at AT TIME ZONE ${tz})::date = ${localDate}::date OR (p.last_failure_at AT TIME ZONE ${tz})::date = ${localDate}::date)`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export interface CandidateContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  seller_intent: boolean;
  seller_inquiry: boolean;
  homeowner_tag: boolean;
}

/** Step 1: one page of recognised, live contacts with an address in a connector ZIP. */
export async function candidateContacts(tx: Tx, o: { keys: readonly string[]; zips: readonly string[]; after: string; limit: number }): Promise<CandidateContactRow[]> {
  const r = await sql<CandidateContactRow>`
    SELECT c.id, c.first_name, c.last_name, c.display_name,
           COALESCE(c.intent IN ('seller','buyer_seller'), false) AS seller_intent,
           EXISTS (SELECT 1 FROM lead_inquiries li WHERE li.tenant_id = c.tenant_id AND li.contact_id = c.id AND li.inquiry_type IN ('sell','value')) AS seller_inquiry,
           EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
                    WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id AND t.name_key = ANY (${[...o.keys]}::text[]) AND NOT t.protected_proxy) AS homeowner_tag
      FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND ${LIVE} AND c.id > ${o.after}::uuid
       AND EXISTS (SELECT 1 FROM contact_addresses za WHERE za.tenant_id = c.tenant_id AND za.contact_id = c.id
                     AND left(regexp_replace(COALESCE(za.postal_code, ''), '\\s', '', 'g'), 5) = ANY (${[...o.zips]}::text[]))
       AND ${recognizedSql(o.keys)}
     ORDER BY c.id LIMIT ${o.limit}`.execute(tx);
  return r.rows;
}

export interface AddressRow {
  id: string;
  contact_id: string;
  kind: 'home' | 'mailing' | 'property' | 'interest';
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  created_at: Date;
  updated_at: Date;
  k2: boolean;
  profile_id: string | null;
  next_refresh_at: Date | null;
  address_updated_at: Date | null;
  last_failure_at: Date | null;
  recognized_by: string[] | null;
}

/** Every address of the page's contacts, with K2 and its profile (if any). */
export async function addressesOf(tx: Tx, contactIds: readonly string[]): Promise<AddressRow[]> {
  if (contactIds.length === 0) return [];
  const r = await sql<AddressRow>`
    SELECT a.id, a.contact_id, a.kind, a.line1, a.line2, a.city, a.region, a.postal_code, a.created_at, a.updated_at,
           ${avmQualifies('c', 'a')} AS k2,
           p.id AS profile_id, p.next_refresh_at, p.address_updated_at, p.last_failure_at, p.recognized_by
      FROM contact_addresses a
      JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
      LEFT JOIN homeowner_profiles p ON p.tenant_id = a.tenant_id AND p.contact_address_id = a.id
     WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ANY (${[...contactIds]}::uuid[])
     ORDER BY a.contact_id, a.id`.execute(tx);
  return r.rows;
}

/** Profiles of `contactId` on addresses that are no longer its subjects (deleted in the page's transaction). */
export async function deleteNonSubjects(tx: Tx, contactId: string, keepAddressIds: readonly string[]): Promise<number> {
  return n(await sql`
    DELETE FROM homeowner_profiles WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid
       AND NOT (contact_address_id = ANY (${[...keepAddressIds]}::uuid[]))`.execute(tx));
}

export async function updateLabels(tx: Tx, profileId: string, reasons: readonly string[]): Promise<void> {
  await sql`UPDATE homeowner_profiles SET recognized_by = ${[...reasons]}::text[]
             WHERE tenant_id = app.tenant_id() AND id = ${profileId}::uuid AND recognized_by IS DISTINCT FROM ${[...reasons]}::text[]`.execute(tx);
}

export interface FenceRow {
  updated_at: Date;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  profile_id: string | null;
}

/**
 * Step 3's fence (E566, E567): the address is unchanged (updated_at), still the same contact's, and the contact is
 * still live, not do-not-contact and recognised. Locks the address row for the write.
 */
export async function fence(tx: Tx, o: { addressId: string; contactId: string; keys: readonly string[] }): Promise<FenceRow | null> {
  const r = await sql<FenceRow>`
    SELECT a.updated_at, c.first_name, c.last_name, c.display_name, p.id AS profile_id
      FROM contact_addresses a
      JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
      LEFT JOIN homeowner_profiles p ON p.tenant_id = a.tenant_id AND p.contact_address_id = a.id
     WHERE a.tenant_id = app.tenant_id() AND a.id = ${o.addressId}::uuid AND a.contact_id = ${o.contactId}::uuid
       AND ${LIVE} AND ${recognizedSql(o.keys)}
     FOR SHARE OF a`.execute(tx);
  return r.rows[0] ?? null;
}

export interface AnswerWrite {
  profileId: string;
  contactId: string;
  addressId: string;
  countyKey: string;
  status: 'matched' | 'not_matched' | 'not_available' | 'ambiguous';
  matchDetail: string | null;
  reasons: readonly string[];
  parcelRef: string | null;
  source: string | null;
  recordAsOf: string | null;
  addressUpdatedAt: Date;
  refreshAgeDays: number;
  retentionDays: number;
  facts: { field: string; column: 'date_value' | 'cents_value' | 'int_value' | 'bool_value' | 'text_value'; value: string | number | boolean; source: string; asOf: string | null }[];
}

/** An answered lookup: facts deleted first (E584), the profile upserted (contact_id never touched), then facts. */
export async function writeAnswer(tx: Tx, w: AnswerWrite): Promise<void> {
  await sql`DELETE FROM homeowner_profile_facts WHERE tenant_id = app.tenant_id()
              AND profile_id = (SELECT id FROM homeowner_profiles WHERE tenant_id = app.tenant_id() AND contact_address_id = ${w.addressId}::uuid)`.execute(tx);
  const r = await sql<{ id: string }>`
    INSERT INTO homeowner_profiles (tenant_id, id, contact_id, contact_address_id, county_key, status, match_detail, recognized_by,
                                    parcel_ref, source, record_as_of, checked_at, last_failure_at, last_failure_code,
                                    address_updated_at, next_refresh_at, retention_until)
    VALUES (app.tenant_id(), ${w.profileId}::uuid, ${w.contactId}::uuid, ${w.addressId}::uuid, ${w.countyKey}, ${w.status}, ${w.matchDetail},
            ${[...w.reasons]}::text[], ${w.parcelRef}, ${w.source}, ${w.recordAsOf}::date, now(), NULL, NULL,
            ${w.addressUpdatedAt}::timestamptz, now() + make_interval(days => ${w.refreshAgeDays}), now() + make_interval(days => ${w.retentionDays}))
    ON CONFLICT (tenant_id, contact_address_id) DO UPDATE SET
      county_key = EXCLUDED.county_key, status = EXCLUDED.status, match_detail = EXCLUDED.match_detail, recognized_by = EXCLUDED.recognized_by,
      parcel_ref = EXCLUDED.parcel_ref, source = EXCLUDED.source, record_as_of = EXCLUDED.record_as_of, checked_at = EXCLUDED.checked_at,
      last_failure_at = NULL, last_failure_code = NULL, address_updated_at = EXCLUDED.address_updated_at,
      next_refresh_at = EXCLUDED.next_refresh_at, retention_until = EXCLUDED.retention_until
    RETURNING id`.execute(tx);
  const id = r.rows[0]!.id;
  for (const f of w.facts) {
    await sql`
      INSERT INTO homeowner_profile_facts (tenant_id, profile_id, field, ${sql.ref(f.column)}, source, as_of)
      VALUES (app.tenant_id(), ${id}::uuid, ${f.field}, ${f.value}, ${f.source}, ${f.asOf}::date)`.execute(tx);
  }
}

export interface FailureWrite {
  profileId: string;
  contactId: string;
  addressId: string;
  countyKey: string;
  reasons: readonly string[];
  code: 'unavailable' | 'timeout' | 'rejected' | 'address_invalid';
  retryDays: number;
  retentionDays: number;
  addressUpdatedAt: Date;
}

/**
 * A failed lookup (E572, E578): an existing profile keeps its status, values, checked_at and retention and gets only
 * the failure stamp and its next try; with no profile, a 'failed' row with no values.
 */
export async function writeFailure(tx: Tx, w: FailureWrite): Promise<void> {
  await sql`
    INSERT INTO homeowner_profiles (tenant_id, id, contact_id, contact_address_id, county_key, status, match_detail, recognized_by,
                                    checked_at, last_failure_at, last_failure_code, address_updated_at, next_refresh_at, retention_until)
    VALUES (app.tenant_id(), ${w.profileId}::uuid, ${w.contactId}::uuid, ${w.addressId}::uuid, ${w.countyKey}, 'failed', NULL, ${[...w.reasons]}::text[],
            NULL, now(), ${w.code}, ${w.addressUpdatedAt}::timestamptz, now() + make_interval(days => ${w.retryDays}),
            now() + make_interval(days => ${w.retentionDays}))
    ON CONFLICT (tenant_id, contact_address_id) DO UPDATE SET
      last_failure_at = now(), last_failure_code = EXCLUDED.last_failure_code, next_refresh_at = EXCLUDED.next_refresh_at,
      recognized_by = EXCLUDED.recognized_by`.execute(tx);
}

// ---- the read route (under the VIEWER's RLS: R-HOME-7) ----------------------------------------------------

export interface ViewReasonsRow {
  tz: string;
  today: string;
  seller_intent: boolean;
  seller_inquiry: boolean;
  homeowner_tag: boolean;
  /** owner question 16: the latest sell or value inquiry the viewer can see (team's date; any age counts), or null */
  seller_inquiry_on: string | null;
  /** the latest closing of a qualifying purchase the viewer can see, or null (K2 not visible to them) */
  past_buyer_since: string | null;
  past_buyer: boolean;
  /**
   * b11 ownership-data/F6: a record (still stored) was merged into this one, directly or along a chain; its addresses,
   * inquiries and intent stay on it. Read from the merge tree, so every viewer of the survivor gets it.
   */
  merged_records: boolean;
  clearance_on: string | null;
}

/** What the viewer may see of the contact's recognition, the team's date, and the outreach pack's recorded review. */
export async function viewReasons(tx: Tx, contactId: string, keys: readonly string[]): Promise<ViewReasonsRow | null> {
  const r = await sql<ViewReasonsRow>`
    SELECT s.default_timezone AS tz, (now() AT TIME ZONE s.default_timezone)::date::text AS today,
           COALESCE(c.intent IN ('seller','buyer_seller'), false) AS seller_intent,
           EXISTS (SELECT 1 FROM lead_inquiries li WHERE li.tenant_id = c.tenant_id AND li.contact_id = c.id AND li.inquiry_type IN ('sell','value')) AS seller_inquiry,
           (SELECT (max(li.received_at) AT TIME ZONE s.default_timezone)::date::text FROM lead_inquiries li
             WHERE li.tenant_id = c.tenant_id AND li.contact_id = c.id AND li.inquiry_type IN ('sell','value')) AS seller_inquiry_on,
           EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
                    WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id AND t.name_key = ANY (${[...keys]}::text[]) AND NOT t.protected_proxy) AS homeowner_tag,
           EXISTS (SELECT 1 FROM contact_addresses ka WHERE ka.tenant_id = c.tenant_id AND ka.contact_id = c.id AND ${avmQualifies('c', 'ka')}) AS past_buyer,
           (SELECT (max(bd.closed_at) AT TIME ZONE s.default_timezone)::date::text FROM deals bd
              JOIN deal_contacts bdc ON bdc.tenant_id = bd.tenant_id AND bdc.deal_id = bd.id AND bdc.contact_id = c.id AND bdc.role IN ('buyer','co_buyer')
             WHERE bd.tenant_id = c.tenant_id AND bd.stage = 'closed' AND bd.side IN ('buy','dual') AND bd.closed_at IS NOT NULL) AS past_buyer_since,
           -- b11 ownership-data/F6: the merge tree's ids (0075 definer; ids of the caller's tenant only), because contacts
           -- RLS hides an engine-merged record (closed, no owner) from the survivor's agent and Team Lead
           cardinality(app.contact_merge_tree_ids(c.tenant_id, c.id)) > 1 AS merged_records,
           (SELECT (j.reviewed_by_counsel_at AT TIME ZONE s.default_timezone)::date::text FROM jurisdiction_packs j
             WHERE j.key = 'platform:public_records_outreach' AND j.status = 'published') AS clearance_on
      FROM contacts c JOIN tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export interface ViewHomeRow {
  address_id: string;
  kind: 'home' | 'mailing' | 'property' | 'interest';
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  profile_id: string | null;
  status: string | null;
  match_detail: string | null;
  source: string | null;
  recognized_by: string[] | null;
  checked_on: string | null;
  last_failure_on: string | null;
  last_failure_code: string | null;
  next_check_on: string | null;
  /** E582: the latest closing (team's date) of the team's purchase of this home (K2) that the viewer can see */
  team_closed_on: string | null;
}

/**
 * The contact's subjects as the viewer sees them: complete home and property addresses, complete K2 addresses of any
 * kind (the viewer's deals; b11 reconciliation homeowner-4, E560), and every address with a visible profile (the
 * profile's own RLS). An incomplete address and a plain mailing or interest row are never listed: nothing is looked up
 * for them, and the panel then asks for the home address.
 */
export async function viewHomes(tx: Tx, contactId: string, tz: string): Promise<ViewHomeRow[]> {
  const r = await sql<ViewHomeRow>`
    SELECT a.id AS address_id, a.kind, a.line1, a.line2, a.city, a.region, a.postal_code,
           p.id AS profile_id, p.status, p.match_detail, p.source, p.recognized_by,
           (p.checked_at AT TIME ZONE ${tz})::date::text AS checked_on,
           (p.last_failure_at AT TIME ZONE ${tz})::date::text AS last_failure_on, p.last_failure_code,
           (p.next_refresh_at AT TIME ZONE ${tz})::date::text AS next_check_on,
           CASE WHEN ${avmQualifies('c', 'a')} THEN (${avmPurchaseClosedAt('c', 'a')} AT TIME ZONE ${tz})::date::text END AS team_closed_on
      FROM contact_addresses a
      JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
      LEFT JOIN homeowner_profiles p ON p.tenant_id = a.tenant_id AND p.contact_address_id = a.id
     WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ${contactId}::uuid
       AND (p.id IS NOT NULL OR (a.line1 IS NOT NULL AND a.city IS NOT NULL AND a.region IS NOT NULL AND a.postal_code IS NOT NULL
                                 AND (a.kind IN ('home','property') OR ${avmQualifies('c', 'a')})))
     ORDER BY (p.id IS NULL), a.kind, a.created_at, a.id
     LIMIT 20`.execute(tx);
  return r.rows;
}

export interface ViewFactRow {
  profile_id: string;
  field: string;
  date_value: string | null;
  cents_value: string | null;
  int_value: number | null;
  bool_value: boolean | null;
  text_value: string | null;
  source: string;
  as_of: string | null;
}

export async function viewFacts(tx: Tx, profileIds: readonly string[]): Promise<ViewFactRow[]> {
  if (profileIds.length === 0) return [];
  const r = await sql<ViewFactRow>`
    SELECT profile_id, field, date_value::text, cents_value::text, int_value, bool_value, text_value, source, as_of::text
      FROM homeowner_profile_facts WHERE tenant_id = app.tenant_id() AND profile_id = ANY (${[...profileIds]}::uuid[])`.execute(tx);
  return r.rows;
}
