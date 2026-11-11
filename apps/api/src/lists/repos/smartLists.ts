// Saved smart lists (R-PAR-27): personal (owner only) or team (members read; Owner/Admin/TL write).
// A list is a definition, never a stored result.
import type { ListSort } from '@realty/core/parity/lists';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface SmartListRow {
  id: string;
  scope: 'team' | 'personal';
  owner_user_id: string | null;
  name: string;
  definition: unknown;
  definition_version: number;
  sort: ListSort;
  position: number;
  archived_at: Date | null;
  updated_at: Date;
}

const COLS = sql`s.id, s.scope, s.owner_user_id, s.name, s.definition, s.definition_version, s.sort, s.position, s.archived_at, s.updated_at`;

/** Lists the caller can read: team lists and their own personal ones. */
export async function listSmartLists(tx: Tx): Promise<SmartListRow[]> {
  const r = await sql<SmartListRow>`
    SELECT ${COLS} FROM smart_lists s
     WHERE s.tenant_id = app.tenant_id() AND s.archived_at IS NULL
       AND (s.scope = 'team' OR s.owner_user_id = app.user_id())
     ORDER BY s.scope = 'team', s.position, lower(s.name), s.id`.execute(tx);
  return r.rows;
}

export async function getSmartList(tx: Tx, id: string): Promise<SmartListRow | null> {
  const r = await sql<SmartListRow>`
    SELECT ${COLS} FROM smart_lists s
     WHERE s.tenant_id = app.tenant_id() AND s.id = ${id}::uuid AND (s.scope = 'team' OR s.owner_user_id = app.user_id())`.execute(tx);
  return r.rows[0] ?? null;
}

export async function insertSmartList(
  tx: Tx,
  l: { id: string; scope: 'team' | 'personal'; ownerUserId: string | null; name: string; definition: unknown; sort: ListSort; position: number; byUserId: string },
): Promise<SmartListRow> {
  const r = await sql<SmartListRow>`
    INSERT INTO smart_lists (tenant_id, id, scope, owner_user_id, name, definition, definition_version, sort, position, updated_by_user_id)
    VALUES (app.tenant_id(), ${l.id}::uuid, ${l.scope}, ${l.ownerUserId}::uuid, ${l.name}, ${JSON.stringify(l.definition)}::jsonb, 1, ${l.sort}, ${l.position}, ${l.byUserId}::uuid)
    RETURNING id, scope, owner_user_id, name, definition, definition_version, sort, position, archived_at, updated_at`.execute(tx);
  return r.rows[0]!;
}

export async function updateSmartList(tx: Tx, id: string, p: { name?: string; definition?: unknown; sort?: ListSort; position?: number; archived?: boolean; byUserId: string }): Promise<SmartListRow | null> {
  const r = await sql<SmartListRow>`
    UPDATE smart_lists s SET name = COALESCE(${p.name ?? null}, s.name),
           definition = COALESCE(${p.definition === undefined ? null : JSON.stringify(p.definition)}::jsonb, s.definition),
           sort = COALESCE(${p.sort ?? null}, s.sort),
           position = COALESCE(${p.position ?? null}::smallint, s.position),
           archived_at = CASE WHEN ${p.archived === true} THEN COALESCE(s.archived_at, now()) ELSE s.archived_at END,
           updated_by_user_id = ${p.byUserId}::uuid
     WHERE s.tenant_id = app.tenant_id() AND s.id = ${id}::uuid
    RETURNING id, scope, owner_user_id, name, definition, definition_version, sort, position, archived_at, updated_at`.execute(tx);
  return r.rows[0] ?? null;
}
