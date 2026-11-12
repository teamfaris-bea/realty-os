// api/cma storage (module 71): cma_reports rows and the few reads the service needs, all under the caller's RLS
// (0061: a CMA is read by its creator, by whoever sees the contact's detail, and by tenant-wide roles; written by a user
// actor as themselves; edited by its creator or a tenant-wide role; the guard keeps shared and superseded rows frozen).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

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

/** Rewrites a draft's content (the policy admits its creator and tenant-wide roles; the guard refuses a non-draft). */
export async function updateDraft(tx: Tx, id: string, w: CmaWrite): Promise<boolean> {
  const r = await sql`
    UPDATE cma_reports SET listing_id = ${w.listingId}::uuid, purpose = ${w.purpose}, inspection = ${w.inspection}, inspected_on = ${w.inspectedOn}::date,
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

/** The size field the connections' sold rows were read from most (the "connection's size field", V3). */
export async function connectionSizeField(tx: Tx, connectionIds: readonly string[]): Promise<string | null> {
  if (connectionIds.length === 0) return null;
  const r = await sql<{ f: string }>`SELECT size_source AS f FROM listings WHERE tenant_id = app.tenant_id() AND source = 'mls'
     AND mls_connection_id = ANY (${[...connectionIds]}::uuid[]) AND size_source IS NOT NULL
     GROUP BY size_source ORDER BY count(*) DESC, size_source LIMIT 1`.execute(tx);
  return r.rows[0]?.f ?? null;
}

export async function platformCleared(tx: Tx, key: string): Promise<boolean> {
  return (await sql<{ ok: boolean }>`SELECT app.platform_cleared(${key}) AS ok`.execute(tx)).rows[0]?.ok === true;
}

export async function tenantZoneName(tx: Tx): Promise<string> {
  return (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC';
}

/** The tenant's raw licence packs by connection (the valuation section and sold fields are read from the stored JSON). */
export async function storedPacks(tx: Tx): Promise<Map<string, unknown>> {
  const r = await sql<{ id: string; license_pack: unknown }>`SELECT id, license_pack FROM integration_connections WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed'`.execute(tx);
  return new Map(r.rows.map((x) => [x.id, x.license_pack]));
}
