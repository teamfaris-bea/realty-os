// Reads for the CRM read API. Every statement is a SELECT under the caller's tenant GUCs (RLS still
// applies). The keyset is (updated_at, id), or (updated_at, kind, id) for the activity union, so a
// page is stable when two rows share a clock. Columns are named: no SELECT *.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EventKind } from '../cursor.js';

const STAMP = (expr: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface Keyset {
  since: string | null;
  cursorAt: string | null;
  cursorId: string | null;
  cursorKind: string | null;
  limit: number;
  /** activity union only */
  only: EventKind | null;
}

export interface PersonRow {
  id: string;
  created: string;
  updated: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  stage: string;
  source_id: string | null;
  source_name: string | null;
  assigned_user_id: string | null;
  contacted: boolean;
}

export interface PointRow {
  contact_id: string;
  kind: 'phone' | 'email';
  address: string;
  label: string;
  status: string;
  is_primary: boolean;
}

export interface AddressRow {
  contact_id: string;
  kind: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
}

export interface TagRow {
  contact_id: string;
  name: string;
}

export interface EventRow {
  kind: EventKind;
  id: string;
  created: string;
  updated: string;
  occurred_at: string;
  person_id: string | null;
  user_id: string | null;
  deal_id: string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  from_address: string | null;
  to_address: string | null;
  phone: string | null;
  outcome: string | null;
  status: string | null;
  appointment_kind: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  duration_s: number | null;
  activity_kind: string | null;
}

export interface DealRow {
  id: string;
  name: string;
  created: string;
  updated: string;
  stage: string;
  side: string;
  price_cents: string | null;
  expected_close_date: string | null;
  closed_at: string | null;
  primary_contact_id: string;
  owner_user_id: string;
}

export interface PartyRow {
  deal_id: string;
  id: string;
  role: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  accepting_leads: boolean;
  created: string;
  updated: string;
}

export interface StageClock {
  updated: string;
  labels: Record<string, string>;
}

const personSelect = `
  SELECT c.id::text AS id,
         ${STAMP('c.created_at')} AS created,
         ${STAMP('c.updated_at')} AS updated,
         c.display_name, c.first_name, c.last_name, c.stage,
         c.original_lead_source_id::text AS source_id,
         s.name AS source_name,
         CASE WHEN c.ownership_state = 'owned' THEN c.owner_user_id::text END AS assigned_user_id,
         (c.first_touch_at IS NOT NULL OR c.last_human_touch_at IS NOT NULL) AS contacted
    FROM contacts c
    LEFT JOIN lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
   WHERE c.tenant_id = app.tenant_id()
     AND c.deleted_at IS NULL
     AND c.merged_into_contact_id IS NULL`;

export async function listPeople(tx: Tx, q: Keyset): Promise<PersonRow[]> {
  const r = await sql<PersonRow>`
    ${sql.raw(personSelect)}
     AND (${q.since}::timestamptz IS NULL OR c.updated_at >= ${q.since}::timestamptz)
     AND (${q.cursorAt}::timestamptz IS NULL OR (c.updated_at, c.id) > (${q.cursorAt}::timestamptz, ${q.cursorId}::uuid))
   ORDER BY c.updated_at, c.id
   LIMIT ${q.limit}`.execute(tx);
  return r.rows;
}

export async function getPerson(tx: Tx, id: string): Promise<PersonRow | null> {
  const r = await sql<PersonRow>`${sql.raw(personSelect)} AND c.id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function pointsOf(tx: Tx, ids: readonly string[]): Promise<PointRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<PointRow>`
    SELECT contact_id::text AS contact_id, kind, address, label, status, is_primary
      FROM contact_points
     WHERE tenant_id = app.tenant_id() AND removed_at IS NULL AND kind IN ('phone', 'email')
       AND contact_id = ANY(${ids}::uuid[])
     ORDER BY contact_id, is_primary DESC, created_at, id`.execute(tx);
  return r.rows;
}

export async function addressesOf(tx: Tx, ids: readonly string[]): Promise<AddressRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<AddressRow>`
    SELECT contact_id::text AS contact_id, kind, line1, line2, city, region, postal_code, country
      FROM contact_addresses
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY(${ids}::uuid[])
     ORDER BY contact_id, created_at, id`.execute(tx);
  return r.rows;
}

export async function tagsOf(tx: Tx, ids: readonly string[]): Promise<TagRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<TagRow>`
    SELECT ct.contact_id::text AS contact_id, t.name
      FROM contact_tags ct
      JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
     WHERE ct.tenant_id = app.tenant_id() AND ct.contact_id = ANY(${ids}::uuid[])
     ORDER BY ct.contact_id, t.name`.execute(tx);
  return r.rows;
}

function branchGate(q: Keyset, kind: EventKind): ReturnType<typeof sql> {
  return sql`
    AND (${q.since}::timestamptz IS NULL OR updated_at >= ${q.since}::timestamptz)
    AND (${q.cursorAt}::timestamptz IS NULL
         OR (updated_at, ${kind}::text, id) > (${q.cursorAt}::timestamptz, ${q.cursorKind}::text, ${q.cursorId}::uuid))
    AND (${q.only}::text IS NULL OR ${q.only}::text = ${kind})`;
}

const eventColumns = `
  kind, id::text AS id,
  ${STAMP('created_at')} AS created,
  ${STAMP('updated_at')} AS updated,
  ${STAMP('occurred_at')} AS occurred_at,
  person_id::text AS person_id, user_id::text AS user_id, deal_id::text AS deal_id,
  direction, subject, body, from_address, to_address, phone, outcome, status,
  appointment_kind, ${STAMP('starts_at')} AS starts_at, ${STAMP('ends_at')} AS ends_at,
  location, duration_s, activity_kind`;

export async function listEvents(tx: Tx, q: Keyset): Promise<EventRow[]> {
  const call = branchGate(q, 'call');
  const text = branchGate(q, 'text');
  const email = branchGate(q, 'email');
  const note = branchGate(q, 'note');
  const appointment = branchGate(q, 'appointment');
  const r = await sql<EventRow>`
    SELECT ${sql.raw(eventColumns)} FROM (
      SELECT 'call'::text AS kind, id, created_at, updated_at, started_at AS occurred_at,
             contact_id AS person_id, agent_user_id AS user_id, NULL::uuid AS deal_id,
             direction, NULL::text AS subject, NULL::text AS body, NULL::text AS from_address, NULL::text AS to_address,
             client_address AS phone, outcome, status, NULL::text AS appointment_kind,
             NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::text AS location,
             duration_s, NULL::text AS activity_kind
        FROM calls
       WHERE tenant_id = app.tenant_id() ${call}
      UNION ALL
      SELECT 'text'::text, id, created_at, updated_at, occurred_at,
             contact_id, initiated_by_user_id, NULL::uuid,
             direction, NULL::text, body, from_address, to_address,
             NULL::text, NULL::text, status, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text,
             NULL::integer, NULL::text
        FROM messages
       WHERE tenant_id = app.tenant_id() AND channel IN ('sms', 'mms') ${text}
      UNION ALL
      SELECT 'email'::text, id, created_at, updated_at, occurred_at,
             contact_id, initiated_by_user_id, NULL::uuid,
             direction, subject, body, from_address, to_address,
             NULL::text, NULL::text, status, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text,
             NULL::integer, NULL::text
        FROM messages
       WHERE tenant_id = app.tenant_id() AND channel = 'email' ${email}
      UNION ALL
      SELECT 'note'::text, id, created_at, updated_at, COALESCE(activity_at, created_at),
             contact_id, author_user_id, deal_id,
             activity_direction, NULL::text, body, NULL::text, NULL::text,
             NULL::text, activity_outcome, NULL::text, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text,
             NULL::integer, activity_kind
        FROM notes
       WHERE tenant_id = app.tenant_id() ${note}
      UNION ALL
      SELECT 'appointment'::text, id, created_at, updated_at, starts_at,
             contact_id, user_id, deal_id,
             NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
             NULL::text, outcome, status, kind,
             starts_at, ends_at, location,
             NULL::integer, NULL::text
        FROM appointments
       WHERE tenant_id = app.tenant_id() ${appointment}
    ) e
    ORDER BY updated_at, kind, id
    LIMIT ${q.limit}`.execute(tx);
  return r.rows;
}

export async function getEvent(tx: Tx, kind: EventKind, id: string): Promise<EventRow | null> {
  const r = await sql<EventRow>`
    SELECT ${sql.raw(eventColumns)} FROM (
      SELECT 'call'::text AS kind, id, created_at, updated_at, started_at AS occurred_at,
             contact_id AS person_id, agent_user_id AS user_id, NULL::uuid AS deal_id,
             direction, NULL::text AS subject, NULL::text AS body, NULL::text AS from_address, NULL::text AS to_address,
             client_address AS phone, outcome, status, NULL::text AS appointment_kind,
             NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::text AS location,
             duration_s, NULL::text AS activity_kind
        FROM calls WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND ${kind} = 'call'
      UNION ALL
      SELECT 'text'::text, id, created_at, updated_at, occurred_at, contact_id, initiated_by_user_id, NULL::uuid,
             direction, NULL::text, body, from_address, to_address, NULL::text, NULL::text, status, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text
        FROM messages WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND channel IN ('sms', 'mms') AND ${kind} = 'text'
      UNION ALL
      SELECT 'email'::text, id, created_at, updated_at, occurred_at, contact_id, initiated_by_user_id, NULL::uuid,
             direction, subject, body, from_address, to_address, NULL::text, NULL::text, status, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text
        FROM messages WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND channel = 'email' AND ${kind} = 'email'
      UNION ALL
      SELECT 'note'::text, id, created_at, updated_at, COALESCE(activity_at, created_at), contact_id, author_user_id, deal_id,
             activity_direction, NULL::text, body, NULL::text, NULL::text, NULL::text, activity_outcome, NULL::text, NULL::text,
             NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, activity_kind
        FROM notes WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND ${kind} = 'note'
      UNION ALL
      SELECT 'appointment'::text, id, created_at, updated_at, starts_at, contact_id, user_id, deal_id,
             NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, outcome, status, kind,
             starts_at, ends_at, location, NULL::integer, NULL::text
        FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND ${kind} = 'appointment'
    ) e
    LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

export async function listDeals(tx: Tx, q: Keyset): Promise<DealRow[]> {
  const r = await sql<DealRow>`
    SELECT id::text AS id, name,
           ${sql.raw(STAMP('created_at'))} AS created,
           ${sql.raw(STAMP('updated_at'))} AS updated,
           stage, side, price_cents::text AS price_cents,
           expected_close_date::text AS expected_close_date,
           ${sql.raw(STAMP('closed_at'))} AS closed_at,
           primary_contact_id::text AS primary_contact_id,
           owner_user_id::text AS owner_user_id
      FROM deals
     WHERE tenant_id = app.tenant_id()
       AND (${q.since}::timestamptz IS NULL OR updated_at >= ${q.since}::timestamptz)
       AND (${q.cursorAt}::timestamptz IS NULL OR (updated_at, id) > (${q.cursorAt}::timestamptz, ${q.cursorId}::uuid))
     ORDER BY updated_at, id
     LIMIT ${q.limit}`.execute(tx);
  return r.rows;
}

export async function getDeal(tx: Tx, id: string): Promise<DealRow | null> {
  const r = await sql<DealRow>`
    SELECT id::text AS id, name,
           ${sql.raw(STAMP('created_at'))} AS created,
           ${sql.raw(STAMP('updated_at'))} AS updated,
           stage, side, price_cents::text AS price_cents,
           expected_close_date::text AS expected_close_date,
           ${sql.raw(STAMP('closed_at'))} AS closed_at,
           primary_contact_id::text AS primary_contact_id,
           owner_user_id::text AS owner_user_id
      FROM deals
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function dealPeople(tx: Tx, ids: readonly string[]): Promise<PartyRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<PartyRow>`
    SELECT deal_id::text AS deal_id, contact_id::text AS id, role
      FROM deal_contacts
     WHERE tenant_id = app.tenant_id() AND deal_id = ANY(${ids}::uuid[])`.execute(tx);
  return r.rows;
}

export async function dealUsers(tx: Tx, ids: readonly string[]): Promise<PartyRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<PartyRow>`
    SELECT deal_id::text AS deal_id, user_id::text AS id, role
      FROM deal_members
     WHERE tenant_id = app.tenant_id() AND deal_id = ANY(${ids}::uuid[])`.execute(tx);
  return r.rows;
}

const userFrom = `
  SELECT m.user_id::text AS id, u.display_name AS name, u.email::text AS email, m.role, m.status, m.accepting_leads,
         ${STAMP('u.created_at')} AS created,
         ${STAMP('GREATEST(m.updated_at, u.updated_at)')} AS updated
    FROM memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.tenant_id = app.tenant_id()`;

export async function listUsers(tx: Tx, q: Keyset): Promise<UserRow[]> {
  const r = await sql<UserRow>`
    ${sql.raw(userFrom)}
     AND (${q.since}::timestamptz IS NULL OR GREATEST(m.updated_at, u.updated_at) >= ${q.since}::timestamptz)
     AND (${q.cursorAt}::timestamptz IS NULL
          OR (GREATEST(m.updated_at, u.updated_at), m.user_id) > (${q.cursorAt}::timestamptz, ${q.cursorId}::uuid))
   ORDER BY GREATEST(m.updated_at, u.updated_at), m.user_id
   LIMIT ${q.limit}`.execute(tx);
  return r.rows;
}

export async function getUser(tx: Tx, id: string): Promise<UserRow | null> {
  const r = await sql<UserRow>`${sql.raw(userFrom)} AND m.user_id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function stageClock(tx: Tx): Promise<StageClock | null> {
  const r = await sql<{ updated: string; labels: unknown }>`
    SELECT ${sql.raw(STAMP('GREATEST(s.updated_at, t.created_at)'))} AS updated, s.stage_labels AS labels
      FROM tenant_settings s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const row = r.rows[0];
  if (!row) return null;
  const labels: Record<string, string> = {};
  if (row.labels && typeof row.labels === 'object' && !Array.isArray(row.labels)) {
    for (const [k, v] of Object.entries(row.labels as Record<string, unknown>)) {
      if (typeof v === 'string') labels[k] = v;
    }
  }
  return { updated: row.updated, labels };
}
