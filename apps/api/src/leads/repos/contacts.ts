// Contact reads and writes for api/leads (BUILD_PLAN module 11). Every query runs under the
// caller's RLS (the request transaction's actor): the central contact visibility rule, the
// card/detail split (app.contact_detail_visible) and the contact-children policies decide what a
// row set contains. Nothing here widens what the caller can see.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  contact_type: string;
  intent: string | null;
  stage: string;
  timezone: string | null;
  ownership_state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  owner_user_id: string | null;
  owner_display_name: string | null;
  pond_id: string | null;
  pond_name: string | null;
  offer_id: string | null;
  offered_to_user_id: string | null;
  offer_expires_at: Date | null;
  offer_round: number;
  owned_at: Date | null;
  first_touch_due_at: Date | null;
  first_touch_at: Date | null;
  first_touch_breached_at: Date | null;
  release_due_at: Date | null;
  route_due_at: Date | null;
  closed_reason: string | null;
  ownership_seq: string;
  pond_summary: string | null;
  original_lead_source_id: string | null;
  source_name: string | null;
  source_kind: string | null;
  original_campaign_ref: string | null;
  original_ad_ref: string | null;
  original_source_detail: Record<string, unknown>;
  tags: string[];
  created_at: Date;
  last_human_touch_at: Date | null;
  merged_into_contact_id: string | null;
  /** created_at as Postgres text (keyset cursors keep microseconds) */
  created_at_text: string;
  // the caller's relation to the row (DATA_MODEL §3 scopes)
  rel_own: boolean;
  rel_offer: boolean;
  rel_collab: boolean;
  rel_team: boolean;
  rel_pond: boolean;
  rel_deal: boolean;
  detail_visible: boolean;
}

const CONTACT_SELECT = sql`
  SELECT c.id, c.first_name, c.last_name, c.display_name, c.contact_type, c.intent, c.stage, c.timezone,
         c.ownership_state, c.owner_user_id, ou.display_name AS owner_display_name, c.pond_id, p.name AS pond_name,
         c.offer_id, c.offered_to_user_id, c.offer_expires_at, c.offer_round, c.owned_at, c.first_touch_due_at,
         c.first_touch_at, c.first_touch_breached_at, c.release_due_at, c.route_due_at, c.closed_reason,
         c.ownership_seq, c.pond_summary, c.original_lead_source_id, s.name AS source_name, s.kind AS source_kind,
         c.original_campaign_ref, c.original_ad_ref, c.original_source_detail,
         -- parity (PARITY_PLAN §4.3, module 60): tags come from contact_tags (detail-visible only, R-PAR-7, R-PAR-10)
         ARRAY(SELECT t.name FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
                WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id ORDER BY lower(t.name), t.id) AS tags, c.created_at,
         c.last_human_touch_at, c.merged_into_contact_id, c.created_at::text AS created_at_text,
         COALESCE(c.owner_user_id = app.user_id(), false) AS rel_own,
         COALESCE(c.offered_to_user_id = app.user_id(), false) AS rel_offer,
         COALESCE(c.id = ANY (app.my_collab_contact_ids()), false) AS rel_collab,
         COALESCE(c.owner_user_id = ANY (app.my_team_member_ids()) OR c.offered_to_user_id = ANY (app.my_team_member_ids()), false) AS rel_team,
         COALESCE(c.ownership_state = 'in_pond' AND (c.pond_id = ANY (app.my_pond_ids()) OR app.my_role() = 'team_lead'), false) AS rel_pond,
         COALESCE(c.id = ANY (app.my_deal_contact_ids()), false) AS rel_deal,
         app.contact_detail_visible(c.tenant_id, c.id) AS detail_visible
    FROM contacts c
    LEFT JOIN users ou ON ou.id = c.owner_user_id
    LEFT JOIN ponds p ON p.tenant_id = c.tenant_id AND p.id = c.pond_id
    LEFT JOIN lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id`;

/** One contact as the caller sees it (null: invisible or absent, R-PERM-5). */
export async function getContact(tx: Tx, id: string): Promise<ContactRow | null> {
  const r = await sql<ContactRow>`${CONTACT_SELECT} WHERE c.tenant_id = app.tenant_id() AND c.id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** Pond cards: contacts waiting in one pond, newest first, keyset-paginated by (created_at, id). */
export async function pondContacts(tx: Tx, pondId: string, limit: number, after: { createdAt: string; id: string } | null): Promise<ContactRow[]> {
  const r = await sql<ContactRow>`${CONTACT_SELECT}
     WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'in_pond' AND c.pond_id = ${pondId}::uuid
       AND (${after === null} OR (c.created_at, c.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
     ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit}`.execute(tx);
  return r.rows;
}

export interface PointRow {
  id: string;
  kind: 'phone' | 'email';
  address: string;
  label: string;
  line_type: string;
  status: string;
  is_primary: boolean;
}

/** Live phones and emails (RLS: contact detail visible). */
export async function contactPoints(tx: Tx, contactId: string): Promise<PointRow[]> {
  const r = await sql<PointRow>`
    SELECT id, kind, address, label, line_type, status, is_primary FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND removed_at IS NULL
     ORDER BY kind, is_primary DESC, created_at, id`.execute(tx);
  return r.rows;
}

export interface InquiryRow {
  id: string;
  received_at: Date;
  inquiry_type: string;
  source_name: string | null;
  postal_code: string | null;
  price_min_cents: string | null;
  price_max_cents: string | null;
  campaign_ref: string | null;
  ad_ref: string | null;
  property_text: string | null;
  message: string | null;
  outcome: string;
}

/** Recent inquiries (RLS: contact detail visible). */
export async function contactInquiries(tx: Tx, contactId: string, limit = 10): Promise<InquiryRow[]> {
  const r = await sql<InquiryRow>`
    SELECT i.id, i.received_at, i.inquiry_type, s.name AS source_name, i.postal_code, i.price_min_cents, i.price_max_cents,
           i.campaign_ref, i.ad_ref, i.property_text, left(i.message, 1000) AS message, i.outcome
      FROM lead_inquiries i LEFT JOIN lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
     WHERE i.tenant_id = app.tenant_id() AND i.contact_id = ${contactId}::uuid
     ORDER BY i.received_at DESC, i.id DESC LIMIT ${limit}`.execute(tx);
  return r.rows;
}

export interface NewPoint {
  id: string;
  contactId: string;
  kind: 'phone' | 'email';
  address: string;
  hmacHex: string;
  label?: 'mobile' | 'home' | 'work' | 'other';
}

/**
 * Adds a phone/email to a contact unless it is already there; the first live point of a kind
 * becomes primary. Returns true when a row was inserted.
 */
export async function addPoint(tx: Tx, p: NewPoint): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary)
    SELECT app.tenant_id(), ${p.id}::uuid, ${p.contactId}::uuid, ${p.kind}, ${p.address}, decode(${p.hmacHex}, 'hex'),
           ${p.label ?? 'other'},
           NOT EXISTS (SELECT 1 FROM contact_points x WHERE x.tenant_id = app.tenant_id() AND x.contact_id = ${p.contactId}::uuid
                         AND x.kind = ${p.kind} AND x.is_primary AND x.removed_at IS NULL)
    ON CONFLICT (tenant_id, contact_id, kind, address) DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

/** FUB parity module 57: an address given at create (RLS: contact detail visible, as every contact child). */
export async function addAddress(tx: Tx, id: string, contactId: string, a: { kind: string; line1?: string | undefined; line2?: string | undefined; city?: string | undefined; region?: string | undefined; postalCode?: string | undefined; country: string }): Promise<void> {
  await sql`
    INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code, country)
    VALUES (app.tenant_id(), ${id}::uuid, ${contactId}::uuid, ${a.kind}, ${a.line1 ?? null}, ${a.line2 ?? null}, ${a.city ?? null}, ${a.region ?? null},
            ${a.postalCode ?? null}, ${a.country})`.execute(tx);
}

let savepointSeq = 0;

/**
 * contact_duplicate_candidates keeps pairs a < b (CHECK); a pair already suggested stays as it is.
 * No ON CONFLICT: PG16 checks an ON CONFLICT insert against the SELECT policy too, and the other
 * contact of the pair may be one the caller cannot see (R-PERM-12). A savepoint absorbs the duplicate.
 */
export async function addDuplicateCandidate(tx: Tx, id: string, a: string, b: string, reason: string): Promise<void> {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  const name = sql.raw(`leads_dup_${(savepointSeq = (savepointSeq + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    await sql`
      INSERT INTO contact_duplicate_candidates (tenant_id, id, contact_a_id, contact_b_id, match_reason)
      VALUES (app.tenant_id(), ${id}::uuid, ${x}::uuid, ${y}::uuid, ${reason})`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    const e = err as { code?: string; table?: string };
    if (e.code === '23505' && e.table === 'contact_duplicate_candidates') return;
    throw err;
  }
}

/** R-PERM-12: who holds a contact with these address HMACs (owner display name only, never details). */
export async function findByAddress(tx: Tx, hmacsHex: readonly string[]): Promise<{ contact_id: string; owner_user_id: string | null; owner_display_name: string | null; ownership_state: string; hmac: string }[]> {
  if (hmacsHex.length === 0) return [];
  const r = await sql<{ contact_id: string; owner_user_id: string | null; owner_display_name: string | null; ownership_state: string; hmac: string }>`
    SELECT contact_id, owner_user_id, owner_display_name, ownership_state, encode(matched_hmac, 'hex') AS hmac
      FROM app.find_contacts_by_address(ARRAY(SELECT decode(x, 'hex') FROM unnest(${[...hmacsHex]}::text[]) x))`.execute(tx);
  return r.rows;
}

/** Ids of the given contacts the caller can see (RLS). */
export async function visibleIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await sql<{ id: string }>`SELECT id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}

/**
 * What an ownership command id the caller already issued names (R-OWN-7): its ledger events (via
 * app.ownership_command_events: the issuer, or a tenant-wide caller) and/or the caller's own stored
 * rejection. Empty when the id is new to this caller. Used to tell a genuine replay (same command,
 * same contact) from a command id reused for a different contact or command.
 */
export interface CommandRecord {
  /** ledger events of the command, in (contact, seq) order */
  events: { contact_id: string; type: string }[];
  /** the caller's stored rejection, if the command was rejected */
  rejection: { contact_id: string | null; command_kind: string } | null;
}

export async function commandRecord(tx: Tx, commandId: string): Promise<CommandRecord> {
  // one round trip (lane perf-misses-2): the two reads are sub-queries of one statement, each unchanged
  // (the events in the function's own order, the caller's rejection row)
  const r = await sql<{ events: { contact_id: string; type: string }[] | null; rejection: { contact_id: string | null; command_kind: string } | null }>`
    SELECT (SELECT json_agg(json_build_object('contact_id', e.contact_id, 'type', e.type) ORDER BY e.ordinality)
              FROM app.ownership_command_events(${commandId}::uuid) WITH ORDINALITY AS e) AS events,
           (SELECT json_build_object('contact_id', x.contact_id, 'command_kind', x.command_kind)
              FROM ownership_command_rejections x
             WHERE x.tenant_id = app.tenant_id() AND x.command_id = ${commandId}::uuid AND x.actor_user_id = app.user_id()
             LIMIT 1) AS rejection`.execute(tx);
  const row = r.rows[0];
  return { events: row?.events ?? [], rejection: row?.rejection ?? null };
}

/** Whether the record is empty (the command id is new to this caller). */
export function isNewCommand(r: CommandRecord): boolean {
  return r.events.length === 0 && r.rejection === null;
}

/** The contacts a recorded command acted on (events and rejection). */
export function commandContacts(r: CommandRecord): Set<string> {
  const s = new Set(r.events.map((e) => e.contact_id));
  if (r.rejection?.contact_id) s.add(r.rejection.contact_id);
  return s;
}

/** State + head of a contact the caller had legitimate sight of (app.ownership_head, migration 0002). */
export async function ownershipHead(tx: Tx, id: string): Promise<{ ownership_state: string; ownership_seq: string } | null> {
  const r = await sql<{ ownership_state: string; ownership_seq: string }>`SELECT * FROM app.ownership_head(${id}::uuid)`.execute(tx);
  return r.rows[0] ?? null;
}

/** A membership's role/status and whether it is in a team the caller leads (reassign targets). */
export async function memberTarget(tx: Tx, userId: string): Promise<{ role: string; status: string; in_my_team: boolean } | null> {
  const r = await sql<{ role: string; status: string; in_my_team: boolean }>`
    SELECT role, status, COALESCE(user_id = ANY (app.my_team_member_ids()), false) AS in_my_team
      FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** Whether the caller may claim from the pond (app.my_pond_ids(); Team Leads see every pond). */
export async function pondAccess(tx: Tx, pondId: string): Promise<{ id: string; name: string; claimable: boolean; tenant_wide: boolean; team_lead: boolean } | null> {
  const r = await sql<{ id: string; name: string; claimable: boolean; tenant_wide: boolean; team_lead: boolean }>`
    SELECT p.id, p.name, COALESCE(p.id = ANY (app.my_pond_ids()), false) AS claimable,
           COALESCE(app.is_tenant_wide(), false) AS tenant_wide, COALESCE(app.my_role() = 'team_lead', false) AS team_lead
      FROM ponds p WHERE p.tenant_id = app.tenant_id() AND p.id = ${pondId}::uuid AND p.archived_at IS NULL`.execute(tx);
  return r.rows[0] ?? null;
}
