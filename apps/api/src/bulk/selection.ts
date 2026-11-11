// STUB of module 60's resolveSelection (PARITY_PLAN §4.2), with exactly its signature, until lane L2
// (lane/par-lists, apps/api/src/lists/**) merges. At merge, this file re-exports L2's implementation:
//   export { resolveSelection } from '../lists/<its file>.js';
// and the LIST_SELECTION_UNAVAILABLE branch disappears.
//
// Contract (§4.2): the people of a selection whose DETAIL the caller sees (app.contact_detail_visible; a pond
// or offer card is never returned), at most `cap`, under the caller's own RLS in `tx`. This stub implements
// the explicit-ids case fully (it is what the People page multi-select sends) and refuses smart-list ids and
// definitions with LIST_SELECTION_UNAVAILABLE (409) rather than guessing at L2's compiler.
import type { ContactId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';

export type SelectionDef = { contactIds: readonly string[] } | { listId: string } | { definition: unknown };

/** The cap the caller wants enforced: one more than the kind's cap, so "too large" is detectable. */
export async function resolveSelection(tx: Tx, def: SelectionDef, cap = 10_001): Promise<ContactId[]> {
  if (!('contactIds' in def)) throw new AppError('LIST_SELECTION_UNAVAILABLE');
  const ids = [...new Set(def.contactIds.map((s) => s.toLowerCase()))];
  if (ids.length === 0) return [];
  const r = await sql<{ id: string }>`
    SELECT c.id FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${ids}::uuid[])
       AND app.contact_detail_visible(c.tenant_id, c.id)
     ORDER BY c.id
     LIMIT ${cap}`.execute(tx);
  return r.rows.map((x) => x.id as ContactId);
}
