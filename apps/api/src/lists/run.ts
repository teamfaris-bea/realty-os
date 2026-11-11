// Running a list (R-PAR-28, R-PAR-29): build the viewer from the caller's own RLS, compile the
// definition with core (module 59), run the plan under the same RLS with the 3 s statement timeout.
import { instantFromDate, type Instant, type Role, zone } from '@realty/core/foundation';
import {
  ALL_PEOPLE,
  compileList,
  decodeCursor,
  encodeCursor,
  LIST_COUNT_CAP,
  LIST_PAGE_SIZE,
  type ListPlan,
  type ListSort,
  type ListViewer,
  type SmartListDefinition,
  validateDefinition,
  type ListScope,
} from '@realty/core/parity/lists';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError, fromCoreFailure } from '../errors.js';
import { limitListStatement } from './common.js';
import * as catalog from './repos/catalog.js';
import * as people from './repos/people.js';
import * as lists from './repos/smartLists.js';

function tagIdsOf(def: SmartListDefinition): string[] {
  const out = new Set<string>();
  for (const c of [...def.all, ...(def.any ?? [])]) if (c.kind === 'tag') c.tagIds.forEach((id) => out.add(id));
  return [...out];
}

async function viewerRole(tx: Tx): Promise<{ userId: string; role: Role | null; now: Instant }> {
  const r = await sql<{ u: string | null; role: Role | null; now: Date }>`SELECT app.user_id()::text AS u, app.my_role() AS role, clock_timestamp() AS now`.execute(tx);
  const row = r.rows[0]!;
  return { userId: row.u ?? '', role: row.role, now: instantFromDate(row.now) };
}

/** The tag ids a definition names. */
export function definitionTagIds(raw: unknown): string[] {
  const d = raw as Partial<SmartListDefinition> | null;
  const out = new Set<string>();
  for (const c of [...(Array.isArray(d?.all) ? d.all : []), ...(Array.isArray(d?.any) ? d.any : [])]) {
    if (c && typeof c === 'object' && c.kind === 'tag' && Array.isArray(c.tagIds)) c.tagIds.forEach((id) => typeof id === 'string' && out.add(id.toLowerCase()));
  }
  return [...out];
}

/** The compiler's view of the caller and the catalog, read under the caller's RLS. */
export async function viewerFor(tx: Tx, def: SmartListDefinition): Promise<ListViewer> {
  return viewerForTags(tx, tagIdsOf(def));
}

export async function viewerForTags(tx: Tx, tagIds: readonly string[]): Promise<ListViewer> {
  const who = await viewerRole(tx);
  if (who.role === null) throw new AppError('NOT_FOUND');
  // one connection per transaction: these run one after another
  const fields = await catalog.listFieldDefs(tx, { includeArchived: true });
  const tags = await catalog.tagsByIds(tx, tagIds);
  const z = await catalog.tenantZone(tx);
  return {
    userId: who.userId,
    role: who.role,
    now: who.now,
    zone: zone(z),
    fields: fields.map(catalog.fieldDefOf),
    tags: tags.map((t) => ({ id: t.id, protectedProxy: t.protected_proxy })),
  };
}

/** Validates a raw definition for a scope (422 with the issue paths). */
export function parseDefinition(raw: unknown, scope: ListScope): SmartListDefinition {
  const v = validateDefinition(raw, scope);
  if (!v.ok) throw new AppError(v.code, { issues: v.issues });
  return v.definition;
}

export async function planFor(tx: Tx, def: SmartListDefinition, o: { sort?: ListSort; strict?: boolean } = {}): Promise<ListPlan> {
  const r = compileList(def, await viewerFor(tx, def), o);
  if (!r.ok) throw fromCoreFailure(r, { path: r.path });
  return r.plan;
}

export type ListSource = { listId: string } | { definition: unknown } | { all: true };

export interface ResolvedList {
  definition: SmartListDefinition;
  sort: ListSort;
  list: lists.SmartListRow | null;
}

/** The definition of a saved list the caller can read (404 otherwise), an ad-hoc one, or "everyone". */
export async function resolveSource(tx: Tx, src: ListSource, sort?: ListSort): Promise<ResolvedList> {
  if ('listId' in src) {
    const l = await lists.getSmartList(tx, src.listId);
    if (!l || l.archived_at !== null) throw new AppError('NOT_FOUND');
    // a stored definition is re-validated: lists are definitions, and v1 is the only version
    return { definition: parseDefinition(l.definition, l.scope), sort: sort ?? l.sort, list: l };
  }
  if ('definition' in src) return { definition: parseDefinition(src.definition, 'personal'), sort: sort ?? 'last_activity_desc', list: null };
  return { definition: ALL_PEOPLE, sort: sort ?? 'last_activity_desc', list: null };
}

export interface PageResult {
  rows: people.PersonRow[];
  nextCursor: string | null;
  audienceProtected: boolean;
}

export async function runPage(tx: Tx, def: SmartListDefinition, sort: ListSort, cursorText: string | null, limit = LIST_PAGE_SIZE): Promise<PageResult> {
  const cursor = cursorText === null ? null : decodeCursor(cursorText, sort);
  if (cursorText !== null && cursor === null) throw new AppError('LIST_CURSOR_INVALID');
  const plan = await planFor(tx, def, { sort });
  await limitListStatement(tx);
  const keys = await people.pageKeys(tx, plan, cursor, limit + 1);
  const page = keys.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = keys.length > limit && last ? encodeCursor({ sort, key: last.sort_key, id: last.id }) : null;
  const rows = await people.peopleRows(tx, page.map((k) => k.id));
  return { rows, nextCursor, audienceProtected: plan.audienceProtected };
}

export async function runCount(tx: Tx, def: SmartListDefinition): Promise<{ count: number; capped: boolean }> {
  const plan = await planFor(tx, def);
  await limitListStatement(tx);
  const n = await people.countUpTo(tx, plan, LIST_COUNT_CAP);
  return { count: Math.min(n, LIST_COUNT_CAP), capped: n > LIST_COUNT_CAP };
}
