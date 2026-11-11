// Whether a bulk audience is built from a protected tag (R-PAR-8, E189: a protected tag never defines the audience of
// a bulk email, text or enrollment; no override).
//
//   anyProtected                the tags an audience was built from: is any of them protected now (a tag protected
//                               since, or merged into a protected one, counts)
//   stageAudienceProtected      a bulk stage action, read when one of its stage changes would start a plan (batch 5
//                               review F1, migration 0041): the stage automation skips the plan (protected_audience)
//                               when the tags its draft recorded, or its saved list's plan, are protected NOW. A draft
//                               that recorded no audience (made before 0041), or an action the reader cannot see,
//                               counts as protected: the plan does not start.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { selectionAudience } from '../lists/index.js';

/** The audience is protected when any tag it was built from is (R-PAR-8). */
export async function anyProtected(tx: Tx, tagIds: readonly string[]): Promise<boolean> {
  if (tagIds.length === 0) return false;
  const r = await sql<{ p: boolean }>`SELECT bool_or(protected_proxy) AS p FROM tags WHERE tenant_id = app.tenant_id() AND id = ANY (${[...tagIds]}::uuid[])`.execute(tx);
  return r.rows[0]?.p === true;
}

const isIdList = (x: unknown): x is string[] => Array.isArray(x) && x.every((t) => typeof t === 'string');

/** A bulk stage action's audience, read now (fail closed: unknown is protected). Runs as the system actor. */
export async function stageAudienceProtected(tx: Tx, bulkActionId: string): Promise<boolean> {
  const r = await sql<{ counts: unknown; smart_list_id: string | null }>`
    SELECT counts, smart_list_id FROM bulk_actions WHERE tenant_id = app.tenant_id() AND id = ${bulkActionId}::uuid AND kind = 'stage'`.execute(tx);
  const a = r.rows[0];
  if (!a) return true;
  const tagIds = (a.counts as { audienceTagIds?: unknown } | null)?.audienceTagIds;
  if (!isIdList(tagIds)) return true;
  if (await anyProtected(tx, tagIds)) return true;
  if (!a.smart_list_id) return false;
  return selectionAudience(tx, { listId: a.smart_list_id }).then((x) => x.audienceProtected, () => true);
}
