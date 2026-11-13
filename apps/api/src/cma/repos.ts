// api/cma storage (module 71): cma_reports rows and the few reads the service needs, all under the caller's RLS
// (0061: a CMA is read by its creator, by whoever sees the contact's detail, and by tenant-wide roles; written by a user
// actor as themselves; edited by its creator or a tenant-wide role; the guard keeps shared and superseded rows frozen).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { LISTING_COLS, type ListingRow } from './deps.js';

export type CmaStatus = 'draft' | 'shared' | 'superseded';
export type CmaPurpose = 'listing_price' | 'buyer_offer' | 'other';
export type CmaInspection = 'none' | 'exterior' | 'interior_and_exterior';

export interface CmaRow {
  id: string;
  contact_id: string | null;
  contact_address_id: string | null;
  listing_id: string | null;
  status: CmaStatus;
  purpose: CmaPurpose;
  inspection: CmaInspection;
  inspected_on: string | null;
  intended_users: string | null;
  agent_interest: string | null;
  conflicts: string | null;
  value_definition: string | null;
  limiting_conditions: string | null;
  method_version: string;
  valuation_date: string;
  mls_data_as_of: Date | null;
  subject: Record<string, unknown>;
  result: Record<string, unknown>;
  value_cents: string | null;
  low_cents: string | null;
  high_cents: string | null;
  agent_notes: string | null;
  content_sha256: string;
  created_by_user_id: string;
  shared_by_user_id: string | null;
  shared_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = sql`id, contact_id, contact_address_id, listing_id, status, purpose, inspection, to_char(inspected_on, 'YYYY-MM-DD') AS inspected_on,
  intended_users, agent_interest, conflicts, value_definition, limiting_conditions, method_version, to_char(valuation_date, 'YYYY-MM-DD') AS valuation_date,
  mls_data_as_of, subject, result, value_cents, low_cents, high_cents, agent_notes, content_sha256, created_by_user_id, shared_by_user_id, shared_at,
  created_at, updated_at`;

export interface CmaWrite {
  contactId: string | null;
  contactAddressId: string | null;
  listingId: string | null;
  purpose: CmaPurpose;
  inspection: CmaInspection;
  inspectedOn: string | null;
  disclosure: { intendedUsers: string | null; agentInterest: string | null; conflicts: string | null; valueDefinition: string | null; limitingConditions: string | null };
  methodVersion: string;
  valuationDate: string;
  mlsDataAsOf: Date | null;
  subject: unknown;
  result: unknown;
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  notes: string | null;
  contentSha256: string;
}

export async function getCma(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<CmaRow | null> {
  const lock = o.lock ? sql` FOR UPDATE` : sql``;
  return (await sql<CmaRow>`SELECT ${COLS} FROM cma_reports WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid${lock}`.execute(tx)).rows[0] ?? null;
}

/** The caller's open draft for (contact, address), locked (F15). */
export async function myOpenDraft(tx: Tx, contactId: string, contactAddressId: string | null): Promise<CmaRow | null> {
  return (
    (await sql<CmaRow>`SELECT ${COLS} FROM cma_reports WHERE tenant_id = app.tenant_id() AND created_by_user_id = app.user_id()
       AND contact_id = ${contactId}::uuid AND contact_address_id IS NOT DISTINCT FROM ${contactAddressId}::uuid AND status = 'draft' FOR UPDATE`.execute(tx)).rows[0] ?? null
  );
}

/**
 * The caller's open drafts for (contact, address), locked, the one linked to the address first: also those whose
 * address was deleted (S0's F15 keeps such a draft open with contact_address_id NULL) and whose stored subject still
 * names it, newest first. An Undo of the delete puts the address back under the same id, so these are drafts of the
 * same home (batch 10 review db-public/F3, ownership-data/F3).
 */
export async function myOpenDrafts(tx: Tx, contactId: string, contactAddressId: string | null): Promise<CmaRow[]> {
  const orphan =
    contactAddressId === null
      ? sql`false`
      : sql`(contact_address_id IS NULL AND subject #>> '{input,kind}' = 'contact_address' AND subject #>> '{input,contactAddressId}' = ${contactAddressId})`;
  return (
    await sql<CmaRow>`SELECT ${COLS} FROM cma_reports WHERE tenant_id = app.tenant_id() AND created_by_user_id = app.user_id()
       AND contact_id = ${contactId}::uuid AND status = 'draft' AND (contact_address_id IS NOT DISTINCT FROM ${contactAddressId}::uuid OR ${orphan})
     ORDER BY (contact_address_id IS NULL) = (${contactAddressId}::uuid IS NULL) DESC, created_at DESC, id FOR UPDATE`.execute(tx)
  ).rows;
}

/** Links an open draft whose address was deleted to that address again, once it is back (its Undo). */
export async function relinkAddress(tx: Tx, id: string, contactAddressId: string): Promise<void> {
  await sql`UPDATE cma_reports SET contact_address_id = ${contactAddressId}::uuid
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'draft' AND contact_address_id IS NULL`.execute(tx);
}

/**
 * Inserts a draft. A contact CMA uses cma_reports_one_open_draft as its arbiter: a concurrent tap that already stored the
 * open draft for (caller, contact, address) wins, and this returns null (the caller re-reads).
 */
export async function insertDraft(tx: Tx, id: string, w: CmaWrite): Promise<string | null> {
  const conflict = w.contactId === null ? sql`` : sql` ON CONFLICT (tenant_id, created_by_user_id, contact_id, contact_address_id) WHERE status = 'draft' AND contact_id IS NOT NULL DO NOTHING`;
  const r = await sql<{ id: string }>`
    INSERT INTO cma_reports (tenant_id, id, contact_id, contact_address_id, listing_id, purpose, inspection, inspected_on, intended_users, agent_interest,
                             conflicts, value_definition, limiting_conditions, method_version, valuation_date, mls_data_as_of, subject, result,
                             value_cents, low_cents, high_cents, agent_notes, content_sha256, created_by_user_id)
    VALUES (app.tenant_id(), ${id}::uuid, ${w.contactId}::uuid, ${w.contactAddressId}::uuid, ${w.listingId}::uuid, ${w.purpose}, ${w.inspection}, ${w.inspectedOn}::date,
            ${w.disclosure.intendedUsers}, ${w.disclosure.agentInterest}, ${w.disclosure.conflicts}, ${w.disclosure.valueDefinition}, ${w.disclosure.limitingConditions},
            ${w.methodVersion}, ${w.valuationDate}::date, ${w.mlsDataAsOf}, ${JSON.stringify(w.subject)}::jsonb, ${JSON.stringify(w.result)}::jsonb,
            ${w.valueCents}, ${w.lowCents}, ${w.highCents}, ${w.notes}, ${w.contentSha256}, app.user_id())${conflict}
    RETURNING id`.execute(tx);
  return r.rows[0]?.id ?? null;
}

/**
 * Rewrites a draft's content (the policy admits its creator and tenant-wide roles; the guard refuses a non-draft). A
 * draft whose address was deleted and put back (the run resolved it again) is linked to it again, unless its creator
 * holds another open draft for that address (cma_reports_one_open_draft).
 */
export async function updateDraft(tx: Tx, id: string, w: CmaWrite): Promise<boolean> {
  const r = await sql`
    UPDATE cma_reports SET contact_address_id = CASE
             WHEN contact_address_id IS NULL AND ${w.contactAddressId}::uuid IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM cma_reports o WHERE o.tenant_id = cma_reports.tenant_id AND o.created_by_user_id = cma_reports.created_by_user_id
                                 AND o.contact_id = cma_reports.contact_id AND o.contact_address_id = ${w.contactAddressId}::uuid AND o.status = 'draft' AND o.id <> cma_reports.id)
             THEN ${w.contactAddressId}::uuid ELSE contact_address_id END,
           listing_id = ${w.listingId}::uuid, purpose = ${w.purpose}, inspection = ${w.inspection}, inspected_on = ${w.inspectedOn}::date,
           intended_users = ${w.disclosure.intendedUsers}, agent_interest = ${w.disclosure.agentInterest}, conflicts = ${w.disclosure.conflicts},
           value_definition = ${w.disclosure.valueDefinition}, limiting_conditions = ${w.disclosure.limitingConditions}, method_version = ${w.methodVersion},
           valuation_date = ${w.valuationDate}::date, mls_data_as_of = ${w.mlsDataAsOf}, subject = ${JSON.stringify(w.subject)}::jsonb,
           result = ${JSON.stringify(w.result)}::jsonb, value_cents = ${w.valueCents}, low_cents = ${w.lowCents}, high_cents = ${w.highCents},
           agent_notes = ${w.notes}, content_sha256 = ${w.contentSha256}
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'draft'`.execute(tx);
  return Number(r.numAffectedRows ?? 0) === 1;
}

/** Refreshes only the MLS data date of an unchanged draft (the one-tap path, F15). */
export async function touchDataDate(tx: Tx, id: string, at: Date | null): Promise<void> {
  await sql`UPDATE cma_reports SET mls_data_as_of = ${at} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'draft'`.execute(tx);
}

export async function supersede(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE cma_reports SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'draft'`.execute(tx);
}

// ---- merged records (R-CMA-8; batch 10 review db-public/F1, ownership-data/F4; batch 11 review ownership-data/F1) ----
// A merge moves no CMA and leaves the merged-away record closed and unowned, so contacts RLS hides it from its former
// agent and from the survivor's agent and Team Lead. Where a person's merge chain goes is read through 0075's two
// SECURITY DEFINER helpers (app.contact_merge_tree_ids, app.contact_merge_root: ids of the caller's own tenant only,
// never a column, and they never read cma_reports), so a chain through a closed middle record is followed whole.
// Which CMA rows the caller reads is still decided by cma_reports_select (0061, widened by 0077): a tenant-wide role,
// the creator as an active member, whoever sees the record's detail, and whoever sees the detail of the record its
// merge chain ends at. Nobody else; support only through its RESTRICTIVE grant policies, read-only.

/**
 * The contact and every record merged into it, along merge chains (0075's definer app.contact_merge_tree_ids: ids of
 * the caller's tenant only, empty for another tenant's id). Contacts RLS hides a merged-away record (closed, no owner)
 * from its creator and from the survivor's agent and Team Lead, so an invoker tree would stop at the first hidden
 * record; cma_reports_select (0077) still decides each CMA row.
 */
export async function mergeTreeIds(tx: Tx, contactId: string): Promise<string[]> {
  const r = await sql<{ ids: string[] }>`SELECT app.contact_merge_tree_ids(app.tenant_id(), ${contactId}::uuid) AS ids`.execute(tx);
  return r.rows[0]?.ids ?? [];
}

/**
 * The live record a merged-away contact's person lives on now (the record its merge chain ends at: 0075's
 * app.contact_merge_root), when the caller sees its detail (R-PERM-5), else null. Null for a contact that was never
 * merged away. The caller's own RLS decides the survivor row and its detail, so the id is named only to whoever may
 * see that record anyway.
 */
export async function survivorSeenByCaller(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ id: string }>`
    SELECT c.id FROM (SELECT app.contact_merge_root(app.tenant_id(), ${contactId}::uuid) AS id) root
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = root.id
     WHERE root.id <> ${contactId}::uuid AND c.merged_into_contact_id IS NULL AND c.deleted_at IS NULL
       AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  return r.rows[0]?.id ?? null;
}

/**
 * Supersedes the caller's own open drafts for the home `addressKey` on `contactIds` (records merged into the one the
 * caller just stored a draft for): one creator keeps one open draft per home across the person (F15). Another
 * person's draft is never touched (R-CMA-6).
 */
export async function supersedeMyDraftsForHome(tx: Tx, contactIds: readonly string[], addressKey: string): Promise<void> {
  if (contactIds.length === 0) return;
  await sql`UPDATE cma_reports SET status = 'superseded'
     WHERE tenant_id = app.tenant_id() AND created_by_user_id = app.user_id() AND status = 'draft'
       AND contact_id = ANY (${[...contactIds]}::uuid[]) AND subject #>> '{resolved,addressKey}' = ${addressKey}`.execute(tx);
}

/** The CMAs of contacts, newest first (RLS decides which rows the caller reads). */
export async function cmasOfContacts(tx: Tx, contactIds: readonly string[]): Promise<CmaRow[]> {
  return (await sql<CmaRow>`SELECT ${COLS} FROM cma_reports WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...contactIds]}::uuid[])
    ORDER BY created_at DESC, id LIMIT 200`.execute(tx)).rows;
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
  updated_at: Date;
}

/** One of the contact's addresses (null: not this contact's, or invisible). */
export async function addressOf(tx: Tx, contactId: string, addressId: string): Promise<AddressRow | null> {
  return (
    (await sql<AddressRow>`SELECT id, contact_id, kind, line1, line2, city, region, postal_code, updated_at FROM contact_addresses
      WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND id = ${addressId}::uuid`.execute(tx)).rows[0] ?? null
  );
}

/** Owner question (c) default: the contact's 'property' address, else 'home', most recently updated. */
export const ONE_TAP_ADDRESS_KINDS = ['property', 'home'] as const;

export async function defaultAddress(tx: Tx, contactId: string): Promise<AddressRow | null> {
  return (
    (await sql<AddressRow>`SELECT id, contact_id, kind, line1, line2, city, region, postal_code, updated_at FROM contact_addresses
      WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND kind = ANY (${[...ONE_TAP_ADDRESS_KINDS]}::text[])
      ORDER BY array_position(${[...ONE_TAP_ADDRESS_KINDS]}::text[], kind), updated_at DESC, id LIMIT 1`.execute(tx)).rows[0] ?? null
  );
}

export async function addressById(tx: Tx, addressId: string): Promise<AddressRow | null> {
  return (await sql<AddressRow>`SELECT id, contact_id, kind, line1, line2, city, region, postal_code, updated_at FROM contact_addresses WHERE tenant_id = app.tenant_id() AND id = ${addressId}::uuid`.execute(tx)).rows[0] ?? null;
}

export async function contactLive(tx: Tx, contactId: string): Promise<{ live: boolean; mergedInto: string | null } | null> {
  const r = await sql<{ live: boolean; merged_into: string | null }>`SELECT (deleted_at IS NULL AND merged_into_contact_id IS NULL) AS live, merged_into_contact_id AS merged_into
    FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}::uuid`.execute(tx);
  const x = r.rows[0];
  return x ? { live: x.live, mergedInto: x.merged_into } : null;
}

/**
 * The size field the connections' sold rows were read from most (the "connection's size field", V3): the RESO name
 * V1-A's sync stored in listings.size_source (normalize records the field it read sqft from, LivingArea by default,
 * BuildingAreaTotal under the Spark mapping). No column records a connection's field, so the newest sold rows are sampled.
 */
export async function connectionSizeField(tx: Tx, connectionIds: readonly string[]): Promise<string | null> {
  if (connectionIds.length === 0) return null;
  const r = await sql<{ f: string }>`SELECT f FROM (SELECT size_source AS f FROM listings WHERE tenant_id = app.tenant_id() AND source = 'mls'
     AND mls_connection_id = ANY (${[...connectionIds]}::uuid[]) AND status = 'sold' AND size_source IS NOT NULL LIMIT 500) x
     GROUP BY f ORDER BY count(*) DESC, f LIMIT 1`.execute(tx);
  return r.rows[0]?.f ?? null;
}

export async function platformCleared(tx: Tx, key: string): Promise<boolean> {
  return (await sql<{ ok: boolean }>`SELECT app.platform_cleared(${key}) AS ok`.execute(tx)).rows[0]?.ok === true;
}

export async function tenantZoneName(tx: Tx): Promise<string> {
  return (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC';
}

// ---- listings (V1-A's columns and row type) ---------------------------------------------------------

export async function listingRow(tx: Tx, id: string): Promise<ListingRow | null> {
  return (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${id}::uuid`.execute(tx)).rows[0] ?? null;
}

export async function listingRows(tx: Tx, ids: readonly string[]): Promise<ListingRow[]> {
  if (ids.length === 0) return [];
  return (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ANY (${[...ids]}::uuid[]) ORDER BY l.id`.execute(tx)).rows;
}

/** The MLS mirrors of a team listing (R-MLS-5), newest first. */
export async function mirrorsOf(tx: Tx, teamListingId: string): Promise<ListingRow[]> {
  return (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.team_listing_id = ${teamListingId}::uuid
    ORDER BY l.mls_modified_at DESC NULLS LAST, l.id`.execute(tx)).rows;
}
