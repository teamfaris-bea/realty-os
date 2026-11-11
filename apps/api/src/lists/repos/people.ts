// Smart-list runs (R-PAR-28, R-PAR-29): the compiler plan (core module 59) mapped to whitelisted,
// parameterised SQL. Each plan node has exactly one fragment below; every value in it is a bound
// parameter (`${value}` in Kysely's `sql` tag), and the only SQL text is the fixed text written here.
// The lint rule `realty/no-sql-raw` forbids sql.raw / sql.lit / sql.ref / sql.id / sql.table in this
// module, and the fuzz test (people.sql.test.ts) proves no input value ever appears in the SQL text.
//
// Visibility (R-PAR-28): rows come from `contacts` under the caller's RLS, narrowed to live contacts
// whose DETAIL the caller sees: the same rule as app.contact_detail_visible(), written inline (with
// InitPlan sub-selects, once per statement) so a 250k-row tenant does not pay a function call per row.
// The equivalence is proven in people.visibility.test.ts. Detail-only predicates (tags, fields, tasks)
// are EXISTS sub-queries on their own RLS-protected tables, so a pond card is never found by data its
// viewer cannot see.
import type { ListCursor, ListPlan, ListPredicate, ListSort, NumCmp } from '@realty/core/parity/lists';
import type { Tx } from '@realty/db';
import { type RawBuilder, sql } from 'kysely';

type Frag = RawBuilder<unknown>;

/** Live contacts whose detail the caller sees (inline app.contact_detail_visible). */
const DETAIL_VISIBLE: Frag = sql`(c.ownership_state NOT IN ('in_pond','offered')
      OR (SELECT app.sees_all_detail())
      OR c.id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR c.id = ANY ((SELECT app.my_deal_contact_ids())::uuid[]))`;
const LIVE: Frag = sql`c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL`;
const ACTIVITY: Frag = sql`GREATEST(c.last_human_touch_at, c.last_inbound_at)`;

const CMP: Readonly<Record<NumCmp, Frag>> = { eq: sql`=`, gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` };

// Every detail-table predicate is a per-person probe by primary key (or the open-task index), written as
// a scalar sub-query so the planner can never turn it into a hash over the whole table: under RLS each
// detail row read costs one app.contact_detail_visible() call (the contact_tags / contact_field_values /
// tasks policies), so a hashed semi-join pays that for every row of the tag or field in the tenant. A
// probe reads only the person's own rows (index conditions on leakproof uuid equality), so the policy
// runs at most once per person scanned and only when a row matches.
const tagExists = (ids: string[]): Frag =>
  sql`COALESCE((SELECT TRUE FROM contact_tags ct WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id AND ct.tag_id = ANY (${ids}::uuid[]) LIMIT 1), FALSE)`;
/**
 * One person's value of one field, probed by its primary key (tenant_id, contact_id, field_id). A scalar
 * sub-query is never turned into a join, so the planner cannot choose to scan every value of the field:
 * under RLS each value row read costs one app.contact_detail_visible() call (contact_field_values_select),
 * and the value comparisons (numeric, arrays, EXTRACT, LIKE) are not leakproof, so they cannot become
 * index conditions ahead of that policy. Probing per person bounds the policy calls to the people scanned.
 */
const valueExists = (fieldId: string, cond: Frag | null): Frag =>
  sql`COALESCE((SELECT ${cond === null ? sql`TRUE` : cond} FROM contact_field_values v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id AND v.field_id = ${fieldId}::uuid), FALSE)`;
const openTask = (cond: Frag | null): Frag =>
  sql`COALESCE((SELECT TRUE FROM tasks t WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.status = 'open'${cond === null ? sql`` : sql` AND ${cond}`} LIMIT 1), FALSE)`;

/** The one fragment of each plan node. Exhaustive: a new node kind fails to compile here. */
export function predicateSql(n: ListPredicate): Frag {
  switch (n.p) {
    case 'and':
      return n.of.length === 0 ? sql`TRUE` : sql`(${sql.join(n.of.map(predicateSql), sql` AND `)})`;
    case 'or':
      return n.of.length === 0 ? sql`FALSE` : sql`(${sql.join(n.of.map(predicateSql), sql` OR `)})`;
    case 'stage_in':
      return sql`c.stage = ANY (${n.stages}::text[])`;
    case 'intent_in':
      return sql`c.intent = ANY (${n.intents}::text[])`;
    case 'contact_type_in':
      return sql`c.contact_type = ANY (${n.types}::text[])`;
    case 'source_in':
      return sql`c.original_lead_source_id = ANY (${n.sourceIds}::uuid[])`;
    case 'owner_in':
      return sql`c.owner_user_id = ANY (${n.userIds}::uuid[])`;
    case 'owner_none':
      return sql`c.owner_user_id IS NULL`;
    // exclusions (E194-E197): stage and contact_type are NOT NULL; a NULL intent, source or owner is "not X"
    case 'stage_not_in':
      return sql`c.stage <> ALL (${n.stages}::text[])`;
    case 'contact_type_not_in':
      return sql`c.contact_type <> ALL (${n.types}::text[])`;
    case 'intent_not_in':
      return sql`(c.intent IS NULL OR c.intent <> ALL (${n.intents}::text[]))`;
    case 'source_not_in':
      return sql`(c.original_lead_source_id IS NULL OR c.original_lead_source_id <> ALL (${n.sourceIds}::uuid[]))`;
    case 'owner_not_in':
      return sql`(c.owner_user_id IS NULL OR c.owner_user_id <> ALL (${n.userIds}::uuid[]))`;
    case 'tag_any':
      return tagExists(n.tagIds);
    case 'tag_none':
      return sql`NOT ${tagExists(n.tagIds)}`;
    case 'tag_all':
      return sql`(SELECT count(*) FROM contact_tags ct WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id AND ct.tag_id = ANY (${n.tagIds}::uuid[])) = ${n.tagIds.length}`;
    case 'activity_since':
      return sql`${ACTIVITY} >= ${new Date(n.at)}::timestamptz`;
    case 'activity_before_or_never':
      return sql`(${ACTIVITY} IS NULL OR ${ACTIVITY} < ${new Date(n.at)}::timestamptz)`;
    case 'activity_never':
      return sql`${ACTIVITY} IS NULL`;
    case 'created_since':
      return sql`c.created_at >= ${new Date(n.at)}::timestamptz`;
    case 'created_before':
      return sql`c.created_at < ${new Date(n.at)}::timestamptz`;
    case 'task_overdue':
      return openTask(sql`t.due_at < ${new Date(n.now)}::timestamptz`);
    case 'task_due_between':
      return openTask(sql`t.due_at >= ${new Date(n.from)}::timestamptz AND t.due_at <= ${new Date(n.to)}::timestamptz`);
    case 'task_any':
      return openTask(null);
    case 'task_none':
      return sql`NOT ${openTask(null)}`;
    case 'name_like':
      return sql`lower(c.display_name) LIKE ${n.pattern} ESCAPE '\\'`;
    case 'field_set':
    case 'field_text_eq':
    case 'field_text_like':
    case 'field_num':
    case 'field_date_between':
    case 'field_md_in':
    case 'field_opt_any':
    case 'field_opt_all':
      return valueExists(n.fieldId, valueCond(n));
    case 'field_empty':
      return sql`NOT ${valueExists(n.fieldId, null)}`;
    case 'field_opt_none':
      return sql`NOT ${valueExists(n.fieldId, sql`v.value_options && ${n.optionIds}::text[]`)}`;
  }
}

type PositiveField = Extract<ListPredicate, { p: 'field_set' | 'field_text_eq' | 'field_text_like' | 'field_num' | 'field_date_between' | 'field_md_in' | 'field_opt_any' | 'field_opt_all' }>;

/** The value condition of a positive field predicate (null: any value row). One text for the probe and the driver. */
function valueCond(n: PositiveField): Frag | null {
  switch (n.p) {
    case 'field_set':
      return null;
    case 'field_text_eq':
      return sql`lower(v.value_text) = ${n.text}`;
    case 'field_text_like':
      return sql`lower(v.value_text) LIKE ${n.pattern} ESCAPE '\\'`;
    case 'field_num':
      return sql`v.value_number ${CMP[n.cmp]} ${String(n.value)}::numeric`;
    case 'field_date_between': {
      const parts: Frag[] = [sql`v.value_date IS NOT NULL`];
      if (n.from !== null) parts.push(sql`v.value_date >= ${n.from}::date`);
      if (n.to !== null) parts.push(sql`v.value_date <= ${n.to}::date`);
      return sql.join(parts, sql` AND `);
    }
    case 'field_md_in': {
      // the expression of contact_field_values_md_idx
      const md = sql`(EXTRACT(MONTH FROM v.value_date) * 100 + EXTRACT(DAY FROM v.value_date))`;
      const ranges = n.ranges.map(([a, b]) => sql`${md} BETWEEN ${a}::numeric AND ${b}::numeric`);
      return sql`v.value_date IS NOT NULL AND (${ranges.length === 0 ? sql`FALSE` : sql.join(ranges, sql` OR `)})`;
    }
    case 'field_opt_any':
      return sql`v.value_options && ${n.optionIds}::text[]`;
    case 'field_opt_all':
      return sql`v.value_options @> ${n.optionIds}::text[]`;
  }
}

/**
 * Value-driven runs (lane perf-misses-2). For a viewer without the 'book' hint (Owner, Admin, Team Lead) a
 * broad list used to walk every person of the tenant and probe each one. When the plan's top level requires
 * a tag or a field value, the people it can hold are exactly the contacts of the matching detail rows, so
 *   c.id IN (SELECT contact_id FROM <detail rows the caller sees that match>)
 * is IMPLIED by the WHERE (the probe below asks for the same visible row with the same condition, read
 * under the same RLS). Adding it changes no result, only lets the planner start from the tag or value index.
 * Proven in lists/value_driven.test.ts against the plain WHERE for every role and the system actor.
 */
/** The contact ids of the detail rows a required tag or value predicate needs (null: not such a predicate). */
function driverRows(n: ListPredicate): Frag | null {
  switch (n.p) {
    case 'tag_any':
    case 'tag_all':
      return sql`SELECT ct.contact_id FROM contact_tags ct WHERE ct.tenant_id = app.tenant_id() AND ct.tag_id = ANY (${n.tagIds}::uuid[])`;
    case 'field_set':
    case 'field_text_eq':
    case 'field_text_like':
    case 'field_num':
    case 'field_date_between':
    case 'field_md_in':
    case 'field_opt_any':
    case 'field_opt_all': {
      const cond = valueCond(n);
      return sql`SELECT v.contact_id FROM contact_field_values v WHERE v.tenant_id = app.tenant_id() AND v.field_id = ${n.fieldId}::uuid${cond === null ? sql`` : sql` AND ${cond}`}`;
    }
    default:
      return null;
  }
}

export function driverSql(n: ListPredicate): Frag | null {
  switch (n.p) {
    case 'tag_any':
    case 'tag_all':
      return sql`c.id IN (${driverRows(n)})`;
    case 'field_set':
    case 'field_text_eq':
    case 'field_text_like':
    case 'field_num':
    case 'field_date_between':
    case 'field_md_in':
    case 'field_opt_any':
    case 'field_opt_all': {
      return sql`c.id IN (${driverRows(n)})`;
    }
    case 'and': {
      // every required tag / value of the AND: the people in ALL of their row sets (each set is implied on its
      // own, so their intersection is too), read once each and intersected instead of probed per person
      const ds = n.of.map(driverRows).filter((d): d is Frag => d !== null);
      return ds.length === 0 ? null : sql`c.id IN (${sql.join(ds, sql` INTERSECT `)})`;
    }
    default:
      return null;
  }
}

interface SortSpec {
  /** the sort key expression (text-comparable for the cursor) */
  key: Frag;
  /** the key as text for the cursor (ISO instant with microseconds, or the lower-cased name) */
  keyText: Frag;
  desc: boolean;
  /** whether the key can be NULL (nulls always sort last) */
  nullable: boolean;
  /** the SQL type the cursor key is cast to */
  cast: 'timestamptz' | 'text';
}

const isoText = (e: Frag): Frag => sql`to_char((${e}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const NEXT_TASK: Frag = sql`(SELECT min(t.due_at) FROM tasks t WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.status = 'open')`;
const STAGE_ENTERED: Frag = sql`(SELECT max(e.occurred_at) FROM contact_stage_events e WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id)`;

const SORTS: Readonly<Record<ListSort, SortSpec>> = {
  // contacts_list_activity_idx: (tenant_id, GREATEST(...) DESC NULLS LAST, id)
  last_activity_desc: { key: ACTIVITY, keyText: isoText(ACTIVITY), desc: true, nullable: true, cast: 'timestamptz' },
  // contacts_list_created_idx: (tenant_id, created_at DESC, id)
  created_desc: { key: sql`c.created_at`, keyText: isoText(sql`c.created_at`), desc: true, nullable: false, cast: 'timestamptz' },
  name_asc: { key: sql`lower(c.display_name)`, keyText: sql`lower(c.display_name)`, desc: false, nullable: false, cast: 'text' },
  next_task_asc: { key: NEXT_TASK, keyText: isoText(NEXT_TASK), desc: false, nullable: true, cast: 'timestamptz' },
  stage_entered_desc: { key: STAGE_ENTERED, keyText: isoText(STAGE_ENTERED), desc: true, nullable: true, cast: 'timestamptz' },
};

function orderBy(s: SortSpec): Frag {
  return sql`${s.key} ${s.desc ? sql`DESC` : sql`ASC`} NULLS LAST, c.id ASC`;
}

/** Rows strictly after the cursor in (key [DESC|ASC] NULLS LAST, id ASC) order. */
function afterCursor(s: SortSpec, cur: ListCursor): Frag {
  if (cur.key === null) return sql`(${s.key} IS NULL AND c.id > ${cur.id}::uuid)`;
  const k = s.cast === 'timestamptz' ? sql`${cur.key}::timestamptz` : sql`${cur.key}::text`;
  const beyond = s.desc ? sql`${s.key} < ${k}` : sql`${s.key} > ${k}`;
  return sql`(${beyond} OR (${s.key} = ${k} AND c.id > ${cur.id}::uuid)${s.nullable ? sql` OR ${s.key} IS NULL` : sql``})`;
}

/**
 * For an Agent, ISA or TC the detail-visible people are always a subset of "owned by me, collaborating
 * on, or on one of my deals" (contacts_select admits pond and offer cards too, but those are not
 * detail-visible unless collaborating or on a deal; such a viewer has no team or tenant-wide branch).
 * Saying so explicitly changes no result (it is implied by the two predicates above; the equivalence
 * test runs every role) but lets the planner start from the owner index instead of walking the
 * tenant-wide activity index past every other agent's contacts.
 */
const BOOK: Frag = sql`(c.owner_user_id = (SELECT app.user_id())
      OR c.id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR c.id = ANY ((SELECT app.my_deal_contact_ids())::uuid[]))`;

/**
 * 'book': the viewer is an Agent, ISA or TC (see BOOK). 'wide': an Owner or Admin, whose detail reads pay no
 * per-row check (tenant-wide policies), so a shape that reads a whole detail table once is cheap for them.
 * A hint only chooses a query shape; every shape returns the same rows (proven in lists/value_driven.test.ts).
 */
export type ScopeHint = 'book' | 'wide' | null;

export function scopeHintFor(role: string | null): ScopeHint {
  if (role === 'agent' || role === 'isa' || role === 'tc') return 'book';
  return role === 'owner' || role === 'admin' ? 'wide' : null;
}

/** The WHERE of a list run (shared by page, count and selection). */
export function whereSql(plan: ListPlan, hint: ScopeHint = null, o: { driven?: boolean } = {}): Frag {
  // counts of 'book' viewers start from their own book; everyone else's from the list's tag or value index
  // when it has one. Pages never: walking the sort index until the page is full is cheaper while matches are
  // dense, and the driver made a dense list's first page scan every matching value (measured at 250k).
  const driver = hint === 'book' || o.driven !== true ? null : driverSql(plan.where);
  return sql`${LIVE} AND ${DETAIL_VISIBLE}${hint === 'book' ? sql` AND ${BOOK}` : sql``}${driver === null ? sql`` : sql` AND ${driver}`} AND ${predicateSql(plan.where)}`;
}

/** The WHERE without the value-driven clause (the equivalence tests' reference). */
export function plainWhereSql(plan: ListPlan, hint: ScopeHint = null): Frag {
  return sql`${LIVE} AND ${DETAIL_VISIBLE}${hint === 'book' ? sql` AND ${BOOK}` : sql``} AND ${predicateSql(plan.where)}`;
}

/** The SQL of one page (exported for the fuzz and EXPLAIN tests): one scan in list order. */
export function pageQuery(plan: ListPlan, cursor: ListCursor | null, limit: number, hint: ScopeHint = null): Frag {
  const s = SORTS[plan.sort];
  return sql`SELECT c.id, ${s.keyText} AS sort_key FROM contacts c
     WHERE ${whereSql(plan, hint)}${cursor === null ? sql`` : sql` AND ${afterCursor(s, cursor)}`}
     ORDER BY ${orderBy(s)} LIMIT ${limit}`;
}

/**
 * The "next task" page of an Owner or Admin ('wide'), as ONE statement in two ordered parts (lane
 * perf-misses-2; one statement, so one snapshot: a task changed during the request can neither show a
 * person twice nor drop one). The key, min(due_at) of the person's open tasks the viewer sees, is NULL
 * exactly for the people with no dated open task, so the list in (key ASC NULLS LAST, id) order is the dated
 * people in (key, id) order followed by the undated people in id order.
 *   part 1: the open dated tasks grouped by person (the same rows and the same min as the per-person key:
 *           one read of the tenant's open tasks, no per-row check for a tenant-wide viewer), joined to the
 *           people the list holds, in key order;
 *   part 2: the people the list holds whose key is NULL, in id order.
 * Each part reads only its first `limit` rows (the page cannot hold more from either); the caller pins
 * enable_sort off for this statement so part 2 walks the primary key instead of sorting every undated person
 * (pageKeysVia). The single scan computed the key of every person of the tenant
 * and sorted them all (1.3 s at 250k). Proven equal to pageQuery page after page in lists/value_driven.test.ts.
 */
export function nextTaskPageQuery(plan: ListPlan, cursor: ListCursor | null, limit: number, hint: ScopeHint): Frag {
  const s = SORTS.next_task_asc;
  const nullCursor = cursor !== null && cursor.key === null;
  // after a NULL-key cursor no dated person can follow: part 1 is empty
  const dated = sql`
    SELECT 1 AS part, g.k, c.id, ${isoText(sql`g.k`)} AS sort_key
      FROM (SELECT t.contact_id, min(t.due_at) AS k FROM tasks t
             WHERE t.tenant_id = app.tenant_id() AND t.status = 'open' AND t.contact_id IS NOT NULL AND t.due_at IS NOT NULL
             GROUP BY t.contact_id) g
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = g.contact_id
     WHERE ${whereSql(plan, hint)}${nullCursor ? sql` AND FALSE` : cursor === null ? sql`` : sql` AND (g.k > ${cursor.key}::timestamptz OR (g.k = ${cursor.key}::timestamptz AND c.id > ${cursor.id}::uuid))`}`;
  const undated = sql`
    SELECT 2 AS part, NULL::timestamptz AS k, c.id, NULL::text AS sort_key FROM contacts c
     WHERE ${whereSql(plan, hint)} AND ${s.key} IS NULL${nullCursor ? sql` AND c.id > ${cursor!.id}::uuid` : sql``}`;
  // each part's own first `limit` rows hold the page's rows from that part
  return sql`SELECT p.id, p.sort_key FROM ((${dated} ORDER BY 2, 3 LIMIT ${limit}) UNION ALL (${undated} ORDER BY 3 LIMIT ${limit})) p
     ORDER BY p.part, p.k, p.id LIMIT ${limit}`;
}

/** Whether the predicate tree holds a free-text name filter. */
function hasNameLike(n: ListPredicate): boolean {
  return n.p === 'name_like' || ((n.p === 'and' || n.p === 'or') && n.of.some(hasNameLike));
}

/** Sorts backed by a list index (contacts_list_activity_idx, contacts_list_created_idx, contacts_list_name_idx). */
const INDEXED_SORTS: ReadonlySet<ListSort> = new Set(['last_activity_desc', 'created_desc', 'name_asc']);
export const PREFIX_ROWS = 2_000;

/**
 * Lane perf-misses-2: the first PREFIX_ROWS live people the viewer sees in list order (walking the sort
 * index), filtered by the list. When that holds `limit` rows they ARE the page: the prefix is the start of
 * the list order, so no later person can come before them. Otherwise the caller runs pageQuery. Under RLS
 * the planner estimates a few hundred visible people of 250k (the contacts_select disjunction), so for a
 * name filter it scanned and sorted the whole tenant (544 ms p95 at 250k) instead of walking the index.
 */
export function prefixPageQuery(plan: ListPlan, cursor: ListCursor | null, limit: number, hint: ScopeHint, prefixRows = PREFIX_ROWS): Frag {
  const s = SORTS[plan.sort];
  return sql`SELECT c.id, ${s.keyText} AS sort_key FROM (
       SELECT c.* FROM contacts c WHERE ${LIVE}${cursor === null ? sql`` : sql` AND ${afterCursor(s, cursor)}`}
        ORDER BY ${orderBy(s)} LIMIT ${prefixRows}) c
     WHERE ${whereSql(plan, hint)}
     ORDER BY ${orderBy(s)} LIMIT ${limit}`;
}

/**
 * One page of ids in list order, plus each row's cursor key. `run` executes one statement; `pinSort` turns
 * enable_sort off (true) or back on (false) for the bounded prefix statement only (a planner choice, no
 * change to what RLS admits).
 */
export async function pageKeysVia(run: (q: Frag) => Promise<PageKeyRow[]>, plan: ListPlan, cursor: ListCursor | null, limit: number, hint: ScopeHint = null,
  pinSort: (off: boolean) => Promise<void> = async () => {}, prefixRows = PREFIX_ROWS): Promise<PageKeyRow[]> {
  // A pinned statement: enable_sort off for it only. On an error the transaction is aborted (SET LOCAL ends
  // with it), so nothing is reset and the statement's own error (e.g. the list timeout) is what propagates.
  const pinned = async (q: Frag): Promise<PageKeyRow[]> => {
    await pinSort(true);
    const rows = await run(q);
    await pinSort(false);
    return rows;
  };
  if (hint === 'wide' && INDEXED_SORTS.has(plan.sort) && hasNameLike(plan.where)) {
    const pre = await pinned(prefixPageQuery(plan, cursor, limit, hint, prefixRows));
    if (pre.length >= limit) return pre;
    return run(pageQuery(plan, cursor, limit, hint));
  }
  if (plan.sort === 'next_task_asc' && hint === 'wide') return pinned(nextTaskPageQuery(plan, cursor, limit, hint));
  return run(pageQuery(plan, cursor, limit, hint));
}

export interface PageKeyRow {
  id: string;
  sort_key: string | null;
}

/** One page of ids in list order, plus each row's cursor key. */
export async function pageKeys(tx: Tx, plan: ListPlan, cursor: ListCursor | null, limit: number, hint: ScopeHint = null): Promise<PageKeyRow[]> {
  return pageKeysVia(async (q) => (await q.execute(tx)).rows as PageKeyRow[], plan, cursor, limit, hint,
    async (off) => void (await (off ? sql`SET LOCAL enable_sort = off` : sql`SET LOCAL enable_sort = on`).execute(tx)));
}

export function countQuery(plan: ListPlan, cap: number, hint: ScopeHint = null): Frag {
  return sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM contacts c WHERE ${whereSql(plan, hint, { driven: true })} LIMIT ${cap + 1}) x`;
}

/** Exact count up to `cap`, then cap + 1 (the API says "10,000+"). */
export async function countUpTo(tx: Tx, plan: ListPlan, cap: number, hint: ScopeHint = null): Promise<number> {
  const r = await countQuery(plan, cap, hint).execute(tx);
  return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
}

/** Up to `limit` ids of the list, in list order (resolveSelection). */
export async function allIds(tx: Tx, plan: ListPlan, limit: number, hint: ScopeHint = null): Promise<string[]> {
  const s = SORTS[plan.sort];
  const r = await sql<{ id: string }>`SELECT c.id FROM contacts c WHERE ${whereSql(plan, hint)} ORDER BY ${orderBy(s)} LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** The subset of `ids` that are live and detail-visible to the caller, in input order. */
export async function visibleOf(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await sql<{ id: string }>`
    SELECT c.id FROM unnest(${[...ids]}::uuid[]) WITH ORDINALITY AS u(id, ord)
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = u.id
     WHERE ${LIVE} AND ${DETAIL_VISIBLE} ORDER BY u.ord`.execute(tx);
  return r.rows.map((x) => x.id);
}

export interface PersonRow {
  id: string;
  display_name: string;
  stage: string;
  intent: string | null;
  contact_type: string;
  owner_user_id: string | null;
  owner_display_name: string | null;
  source_name: string | null;
  last_activity_at: Date | null;
  created_at: Date;
  next_task_due_at: Date | null;
  tags: { id: string; name: string; color: string | null }[];
}

/** The People rows for a page of ids (tags read under contact_tags RLS: detail-visible only). */
export async function peopleRows(tx: Tx, ids: readonly string[]): Promise<PersonRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<PersonRow>`
    SELECT c.id, c.display_name, c.stage, c.intent, c.contact_type, c.owner_user_id, u.display_name AS owner_display_name,
           s.name AS source_name, ${ACTIVITY} AS last_activity_at, c.created_at, ${NEXT_TASK} AS next_task_due_at,
           COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY lower(t.name), t.id)
                       FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
                      WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id), '[]'::json) AS tags
      FROM contacts c
      LEFT JOIN users u ON u.id = c.owner_user_id
      LEFT JOIN lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${[...ids]}::uuid[])`.execute(tx);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter((x): x is PersonRow => x !== undefined);
}
