// Tag catalog, contact tags, custom field definitions and values (PARITY_PLAN module 60). Every query
// runs under the caller's RLS: the catalog is member-readable, a person's tags and values follow the
// person's detail visibility (R-PAR-7, R-PAR-19), and the role policies decide who writes what.
import type { FieldDef, FieldOption, FieldType, TypedValue } from '@realty/core/parity/fields';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

// ---- tags ------------------------------------------------------------------------------------

export interface TagRow {
  id: string;
  name: string;
  color: string | null;
  protected_proxy: boolean;
  created_by_kind: 'user' | 'import';
  created_at: Date;
}

const TAG_COLS = sql`t.id, t.name, t.color, t.protected_proxy, t.created_by_kind, t.created_at`;

export async function listTags(tx: Tx): Promise<TagRow[]> {
  const r = await sql<TagRow>`SELECT ${TAG_COLS} FROM tags t WHERE t.tenant_id = app.tenant_id() ORDER BY lower(t.name), t.id`.execute(tx);
  return r.rows;
}

/** Links per tag that the caller can see (Owner/Admin: all). */
export async function tagUsage(tx: Tx): Promise<Map<string, number>> {
  const r = await sql<{ tag_id: string; n: number }>`
    SELECT ct.tag_id, count(*)::int AS n FROM contact_tags ct
      JOIN contacts c ON c.tenant_id = ct.tenant_id AND c.id = ct.contact_id AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
     WHERE ct.tenant_id = app.tenant_id() GROUP BY ct.tag_id`.execute(tx);
  return new Map(r.rows.map((x) => [x.tag_id, x.n]));
}

export async function getTag(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<TagRow | null> {
  const r = await sql<TagRow>`SELECT ${TAG_COLS} FROM tags t WHERE t.tenant_id = app.tenant_id() AND t.id = ${id}::uuid ${o.lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function tagsByIds(tx: Tx, ids: readonly string[]): Promise<TagRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<TagRow>`SELECT ${TAG_COLS} FROM tags t WHERE t.tenant_id = app.tenant_id() AND t.id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return r.rows;
}

/** Tags by the database's own name key (lower(normalize(name, NFKC))), so core and the DB agree (E165). */
export async function tagsByNames(tx: Tx, names: readonly string[]): Promise<(TagRow & { name_key: string; asked: string })[]> {
  if (names.length === 0) return [];
  const r = await sql<TagRow & { name_key: string; asked: string }>`
    SELECT ${TAG_COLS}, t.name_key, q.asked FROM unnest(${[...names]}::text[]) AS q(asked)
      JOIN tags t ON t.tenant_id = app.tenant_id() AND t.name_key = lower(normalize(q.asked, NFKC))`.execute(tx);
  return r.rows;
}

/** Inserts a tag unless one with the same key exists (then returns null; the caller reads that one). */
export async function insertTag(tx: Tx, t: { id: string; name: string; color: string | null; protectedProxy: boolean; byUserId: string | null }): Promise<TagRow | null> {
  const r = await sql<TagRow>`
    INSERT INTO tags (tenant_id, id, name, color, protected_proxy, created_by_kind, created_by_user_id)
    VALUES (app.tenant_id(), ${t.id}::uuid, ${t.name}, ${t.color}, ${t.protectedProxy}, ${t.byUserId === null ? 'import' : 'user'}, ${t.byUserId}::uuid)
    ON CONFLICT (tenant_id, name_key) DO NOTHING
    RETURNING id, name, color, protected_proxy, created_by_kind, created_at`.execute(tx);
  return r.rows[0] ?? null;
}

export async function updateTag(tx: Tx, id: string, p: { name?: string; color?: string | null; protectedProxy?: boolean }): Promise<TagRow | null> {
  const r = await sql<TagRow>`
    UPDATE tags t SET name = COALESCE(${p.name ?? null}, t.name),
                      color = CASE WHEN ${p.color !== undefined} THEN ${p.color ?? null} ELSE t.color END,
                      protected_proxy = COALESCE(${p.protectedProxy ?? null}::boolean, t.protected_proxy)
     WHERE t.tenant_id = app.tenant_id() AND t.id = ${id}::uuid
    RETURNING id, name, color, protected_proxy, created_by_kind, created_at`.execute(tx);
  return r.rows[0] ?? null;
}

/** Links of a tag (live contacts) the caller can see. */
export async function tagLinkCount(tx: Tx, id: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM contact_tags WHERE tenant_id = app.tenant_id() AND tag_id = ${id}::uuid`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

/**
 * R-PAR-9: moves every link of `source` to `target` in one statement (the source links are deleted and
 * re-inserted as the merging user; a person who already has the target keeps one link). Returns the
 * number of source links and how many new target links were written.
 */
export async function moveTagLinks(tx: Tx, source: string, target: string, byUserId: string): Promise<{ moved: number; added: number }> {
  const r = await sql<{ moved: number; added: number }>`
    WITH gone AS (
      DELETE FROM contact_tags ct WHERE ct.tenant_id = app.tenant_id() AND ct.tag_id = ${source}::uuid RETURNING ct.contact_id
    ), ins AS (
      INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
      SELECT app.tenant_id(), g.contact_id, ${target}::uuid, 'user', ${byUserId}::uuid FROM gone g
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM gone)::int AS moved, (SELECT count(*) FROM ins)::int AS added`.execute(tx);
  return r.rows[0] ?? { moved: 0, added: 0 };
}

/** R-PAR-9: rewrites every saved list (personal ones included) that names `source` (definer, 0025). */
export async function retargetLists(tx: Tx, source: string, target: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app.smart_lists_retarget_tag(${source}::uuid, ${target}::uuid) AS n`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export async function deleteTag(tx: Tx, id: string): Promise<boolean> {
  const r = await sql`DELETE FROM tags WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

// ---- contact tags ------------------------------------------------------------------------------

export interface ContactTagRow {
  id: string;
  name: string;
  color: string | null;
  protected_proxy: boolean;
}

/** A person's tags (RLS: only when the caller sees the person's detail). */
export async function contactTags(tx: Tx, contactId: string): Promise<ContactTagRow[]> {
  const r = await sql<ContactTagRow>`
    SELECT t.id, t.name, t.color, t.protected_proxy FROM contact_tags ct
      JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
     WHERE ct.tenant_id = app.tenant_id() AND ct.contact_id = ${contactId}::uuid ORDER BY lower(t.name), t.id`.execute(tx);
  return r.rows;
}

export type TagLinkBy = { kind: 'user' | 'bulk'; userId: string } | { kind: 'import'; importBatchId: string };

/** Adds links; returns the tag ids that were new for the person. */
export async function addTagLinks(tx: Tx, contactId: string, tagIds: readonly string[], by: TagLinkBy): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const userId = by.kind === 'import' ? null : by.userId;
  const batch = by.kind === 'import' ? by.importBatchId : null;
  const r = await sql<{ tag_id: string }>`
    INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id, import_batch_id)
    SELECT app.tenant_id(), ${contactId}::uuid, x, ${by.kind}, ${userId}::uuid, ${batch}::uuid FROM unnest(${[...new Set(tagIds)]}::uuid[]) AS u(x)
    ON CONFLICT DO NOTHING RETURNING tag_id`.execute(tx);
  return r.rows.map((x) => x.tag_id);
}

export async function removeTagLinks(tx: Tx, contactId: string, tagIds: readonly string[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const r = await sql<{ tag_id: string }>`
    DELETE FROM contact_tags WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND tag_id = ANY (${[...tagIds]}::uuid[])
    RETURNING tag_id`.execute(tx);
  return r.rows.map((x) => x.tag_id);
}

// ---- custom fields -----------------------------------------------------------------------------

export interface FieldDefRow {
  id: string;
  key: string;
  label: string;
  field_type: FieldType;
  options: FieldOption[];
  annual: boolean;
  position: number;
  origin: 'manual' | 'fub_import' | 'csv_import';
  archived_at: Date | null;
}

const FIELD_COLS = sql`d.id, d.key, d.label, d.field_type, d.options, d.annual, d.position, d.origin, d.archived_at`;

export function fieldDefOf(r: FieldDefRow): FieldDef {
  return { id: r.id, key: r.key, label: r.label, fieldType: r.field_type, options: r.options, annual: r.annual, archived: r.archived_at !== null };
}

export async function listFieldDefs(tx: Tx, o: { includeArchived?: boolean } = {}): Promise<FieldDefRow[]> {
  const r = await sql<FieldDefRow>`
    SELECT ${FIELD_COLS} FROM custom_field_defs d WHERE d.tenant_id = app.tenant_id() ${o.includeArchived ? sql`` : sql`AND d.archived_at IS NULL`}
     ORDER BY d.archived_at IS NOT NULL, d.position, lower(d.label), d.id`.execute(tx);
  return r.rows;
}

export async function getFieldDef(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<FieldDefRow | null> {
  const r = await sql<FieldDefRow>`SELECT ${FIELD_COLS} FROM custom_field_defs d WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}::uuid ${o.lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function fieldKeys(tx: Tx): Promise<Set<string>> {
  const r = await sql<{ key: string }>`SELECT key FROM custom_field_defs WHERE tenant_id = app.tenant_id()`.execute(tx);
  return new Set(r.rows.map((x) => x.key));
}

export async function insertFieldDef(
  tx: Tx,
  d: { id: string; key: string; label: string; fieldType: FieldType; options: FieldOption[]; annual: boolean; position: number; origin: FieldDefRow['origin']; byUserId: string | null },
): Promise<FieldDefRow> {
  const r = await sql<FieldDefRow>`
    INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, options, annual, position, origin, created_by_user_id)
    VALUES (app.tenant_id(), ${d.id}::uuid, ${d.key}, ${d.label}, ${d.fieldType}, ${JSON.stringify(d.options)}::jsonb, ${d.annual}, ${d.position},
            ${d.origin}, ${d.byUserId}::uuid)
    RETURNING id, key, label, field_type, options, annual, position, origin, archived_at`.execute(tx);
  return r.rows[0]!;
}

export async function updateFieldDef(tx: Tx, id: string, p: { label?: string; options?: FieldOption[]; position?: number; archived?: boolean }): Promise<FieldDefRow | null> {
  const r = await sql<FieldDefRow>`
    UPDATE custom_field_defs d SET label = COALESCE(${p.label ?? null}, d.label),
           options = COALESCE(${p.options === undefined ? null : JSON.stringify(p.options)}::jsonb, d.options),
           position = COALESCE(${p.position ?? null}::smallint, d.position),
           archived_at = CASE WHEN ${p.archived === undefined} THEN d.archived_at WHEN ${p.archived === true} THEN COALESCE(d.archived_at, now()) ELSE NULL END
     WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}::uuid
    RETURNING id, key, label, field_type, options, annual, position, origin, archived_at`.execute(tx);
  return r.rows[0] ?? null;
}

export async function nextFieldPosition(tx: Tx): Promise<number> {
  const r = await sql<{ p: number }>`SELECT COALESCE(max(position) + 1, 0)::int AS p FROM custom_field_defs WHERE tenant_id = app.tenant_id()`.execute(tx);
  return Math.min(r.rows[0]?.p ?? 0, 32_000);
}

export interface FieldValueRow {
  field_id: string;
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_options: string[] | null;
  updated_by_kind: 'user' | 'bulk' | 'import';
  updated_at: Date;
}

/** A person's values (RLS: only when the caller sees the person's detail). */
export async function contactFieldValues(tx: Tx, contactId: string): Promise<FieldValueRow[]> {
  const r = await sql<FieldValueRow>`
    SELECT field_id, value_text, value_number::text AS value_number, value_date::text AS value_date, value_options, updated_by_kind, updated_at
      FROM contact_field_values WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid`.execute(tx);
  return r.rows;
}

export async function fieldValue(tx: Tx, contactId: string, fieldId: string): Promise<FieldValueRow | null> {
  const r = await sql<FieldValueRow>`
    SELECT field_id, value_text, value_number::text AS value_number, value_date::text AS value_date, value_options, updated_by_kind, updated_at
      FROM contact_field_values WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND field_id = ${fieldId}::uuid FOR UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

export type ValueBy = { kind: 'user' | 'bulk'; userId: string } | { kind: 'import'; importBatchId: string };

export async function upsertFieldValue(tx: Tx, contactId: string, fieldId: string, v: TypedValue, by: ValueBy): Promise<void> {
  const text = v.type === 'text' ? v.text : null;
  const num = v.type === 'number' ? String(v.number) : null;
  const date = v.type === 'date' ? v.date : null;
  const opts = v.type === 'options' ? v.optionIds : null;
  const userId = by.kind === 'import' ? null : by.userId;
  const batch = by.kind === 'import' ? by.importBatchId : null;
  await sql`
    INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, value_number, value_date, value_options, updated_by_kind, updated_by_user_id, import_batch_id)
    VALUES (app.tenant_id(), ${contactId}::uuid, ${fieldId}::uuid, ${text}, ${num}::numeric, ${date}::date, ${opts}::text[], ${by.kind}, ${userId}::uuid, ${batch}::uuid)
    ON CONFLICT (tenant_id, contact_id, field_id) DO UPDATE
      SET value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number, value_date = EXCLUDED.value_date,
          value_options = EXCLUDED.value_options, updated_by_kind = EXCLUDED.updated_by_kind,
          updated_by_user_id = EXCLUDED.updated_by_user_id, import_batch_id = EXCLUDED.import_batch_id`.execute(tx);
}

/** Writes the value only where the person has none, even one written since the caller looked (E41); true when written. */
export async function insertFieldValueIfAbsent(tx: Tx, contactId: string, fieldId: string, v: TypedValue, by: ValueBy): Promise<boolean> {
  const text = v.type === 'text' ? v.text : null;
  const num = v.type === 'number' ? String(v.number) : null;
  const date = v.type === 'date' ? v.date : null;
  const opts = v.type === 'options' ? v.optionIds : null;
  const userId = by.kind === 'import' ? null : by.userId;
  const batch = by.kind === 'import' ? by.importBatchId : null;
  const r = await sql<{ field_id: string }>`
    INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, value_number, value_date, value_options, updated_by_kind, updated_by_user_id, import_batch_id)
    VALUES (app.tenant_id(), ${contactId}::uuid, ${fieldId}::uuid, ${text}, ${num}::numeric, ${date}::date, ${opts}::text[], ${by.kind}, ${userId}::uuid, ${batch}::uuid)
    ON CONFLICT (tenant_id, contact_id, field_id) DO NOTHING RETURNING field_id`.execute(tx);
  return r.rows.length > 0;
}

export async function deleteFieldValue(tx: Tx, contactId: string, fieldId: string): Promise<boolean> {
  const r = await sql`DELETE FROM contact_field_values WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND field_id = ${fieldId}::uuid`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

// ---- the person (for authorization facts) ------------------------------------------------------

export interface PersonFactsRow {
  id: string;
  rel_own: boolean;
  rel_collab: boolean;
  rel_team: boolean;
  rel_pond: boolean;
  rel_offer: boolean;
  rel_deal: boolean;
  detail_visible: boolean;
  live: boolean;
}

/** The caller's relation to a visible contact (null: invisible or absent, R-PERM-5). */
export async function personFacts(tx: Tx, contactId: string): Promise<PersonFactsRow | null> {
  const r = await sql<PersonFactsRow>`
    SELECT c.id,
           COALESCE(c.owner_user_id = app.user_id(), false) AS rel_own,
           COALESCE(c.id = ANY (app.my_collab_contact_ids()), false) AS rel_collab,
           COALESCE(c.owner_user_id = ANY (app.my_team_member_ids()) OR c.offered_to_user_id = ANY (app.my_team_member_ids()), false) AS rel_team,
           COALESCE(c.ownership_state = 'in_pond' AND (c.pond_id = ANY (app.my_pond_ids()) OR app.my_role() = 'team_lead'), false) AS rel_pond,
           COALESCE(c.offered_to_user_id = app.user_id(), false) AS rel_offer,
           COALESCE(c.id = ANY (app.my_deal_contact_ids()), false) AS rel_deal,
           app.contact_detail_visible(c.tenant_id, c.id) AS detail_visible,
           (c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL) AS live
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** The tenant's IANA zone (tenant_settings.default_timezone). */
export async function tenantZone(tx: Tx): Promise<string> {
  const r = await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.z ?? 'UTC';
}

/**
 * Runs `fn` inside a savepoint so an expected refusal (e.g. TAG_LIMIT) leaves the transaction usable.
 * The name is fixed text: Postgres allows the same savepoint name again, and ROLLBACK TO the latest one.
 */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await sql`SAVEPOINT lists_write`.execute(tx);
  try {
    const r = await fn();
    await sql`RELEASE SAVEPOINT lists_write`.execute(tx);
    return r;
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT lists_write`.execute(tx);
    throw e;
  }
}
