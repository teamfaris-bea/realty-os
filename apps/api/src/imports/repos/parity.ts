// The import's parity reads and bookkeeping (PARITY_PLAN module 65; R-PAR-46, R-PAR-6, R-PAR-10, R-PAR-17,
// R-PAR-19). Every catalog, tag-link, field-definition and value WRITE goes through module 60's writers
// (apps/api/src/lists/index.ts: ensureTags, addContactTags, ensureFieldDef, setFieldValue with
// fillEmptyOnly), called by commit.ts as the import system actor (RLS: `added_by_kind = 'import'` with the
// batch id, `created_by_kind = 'import'`, `origin = 'fub_import' | 'csv_import'`, tenant-wide system only).
// What stays here: the catalog reads of the dry run, the savepoint that keeps one refused tag or value
// from rejecting the person, the batch's bookkeeping and the revert's batch-scoped deletes.
import type { FieldOption, FieldType } from '@realty/core/import';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

let sp = 0;
/** Runs `fn` in a savepoint; a check violation (a DB limit or type guard) rolls back just that and returns null. */
export async function guarded<T>(tx: Tx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  const name = sql.raw(`imp_par_${(sp = (sp + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    const value = await fn();
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return { ok: true, value };
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    const pe = e as { code?: string; message?: string };
    if (pe.code === '23514' || pe.code === '23505') return { ok: false, code: (pe.message ?? '').split(':')[0] || 'CHECK_FAILED' };
    throw e;
  }
}

/** The tenant's catalog: name key → tag id. */
export async function catalog(tx: Tx): Promise<Map<string, string>> {
  const r = await sql<{ id: string; name_key: string }>`SELECT id, name_key FROM tags WHERE tenant_id = app.tenant_id()`.execute(tx);
  return new Map(r.rows.map((x) => [x.name_key, x.id]));
}

export interface FieldDefRow {
  id: string;
  key: string;
  label: string;
  field_type: FieldType;
  options: FieldOption[];
  annual: boolean;
  archived: boolean;
}

export async function fieldDefs(tx: Tx): Promise<FieldDefRow[]> {
  const r = await sql<FieldDefRow>`
    SELECT id, key, label, field_type, options, annual, archived_at IS NOT NULL AS archived FROM custom_field_defs WHERE tenant_id = app.tenant_id() ORDER BY position, key`.execute(tx);
  return r.rows;
}

/** The tag names a contact holds now (for E41 previews and the review list). */
export async function tagNamesOf(tx: Tx, contactIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (contactIds.length === 0) return out;
  const r = await sql<{ contact_id: string; name: string }>`
    SELECT ct.contact_id, t.name FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
     WHERE ct.tenant_id = app.tenant_id() AND ct.contact_id = ANY (${[...contactIds]}::uuid[]) ORDER BY t.name`.execute(tx);
  for (const x of r.rows) (out.get(x.contact_id) ?? out.set(x.contact_id, []).get(x.contact_id))!.push(x.name);
  return out;
}

/** Adds to the batch's parity bookkeeping (catalog rows it created, committed counts), under the batch row lock. */
export async function recordParity(tx: Tx, batchId: string, add: { tagIds?: string[]; fieldIds?: string[]; counts?: Record<string, number> }): Promise<void> {
  const r = await sql<{ options: Record<string, unknown> }>`SELECT options FROM import_batches WHERE tenant_id = app.tenant_id() AND id = ${batchId} FOR UPDATE`.execute(tx);
  const o = r.rows[0]?.options ?? {};
  const created = (o.parityCreated ?? {}) as { tagIds?: string[]; fieldIds?: string[] };
  const committed = { ...((o.parityCommitted ?? {}) as Record<string, number>) };
  for (const [k, v] of Object.entries(add.counts ?? {})) committed[k] = (committed[k] ?? 0) + v;
  const next = {
    ...o,
    parityCreated: { tagIds: [...(created.tagIds ?? []), ...(add.tagIds ?? [])], fieldIds: [...(created.fieldIds ?? []), ...(add.fieldIds ?? [])] },
    parityCommitted: committed,
  };
  await sql`UPDATE import_batches SET options = ${JSON.stringify(next)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${batchId}`.execute(tx);
}

/** Revert: the batch's tag links and untouched imported values on these contacts. Returns what was removed. */
export async function removeBatchRows(tx: Tx, batchId: string, contactIds: readonly string[]): Promise<{ tagLinks: number; values: number }> {
  if (contactIds.length === 0) return { tagLinks: 0, values: 0 };
  const t = await sql`DELETE FROM contact_tags WHERE tenant_id = app.tenant_id() AND import_batch_id = ${batchId} AND contact_id = ANY (${[...contactIds]}::uuid[])`.execute(tx);
  // a value someone edited since carries their provenance, not the batch's: it stays (R-PAR-46 "unless edited since")
  const v = await sql`DELETE FROM contact_field_values WHERE tenant_id = app.tenant_id() AND import_batch_id = ${batchId} AND updated_by_kind = 'import'
                        AND contact_id = ANY (${[...contactIds]}::uuid[])`.execute(tx);
  return { tagLinks: Number(t.numAffectedRows ?? 0), values: Number(v.numAffectedRows ?? 0) };
}

/** Revert: catalog tags this batch created that nobody uses any more (definer: the import has no tag delete right). */
export async function removeUnusedCreatedTags(tx: Tx, batchId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app.import_revert_tags(${batchId}::uuid) AS n`.execute(tx);
  return Number(r.rows[0]?.n ?? 0);
}

/** Revert: fields this batch created that hold no value any more are archived (definitions are never deleted, R-PAR-17). */
export async function archiveUnusedCreatedFields(tx: Tx, fieldIds: readonly string[]): Promise<number> {
  if (fieldIds.length === 0) return 0;
  const r = await sql`
    UPDATE custom_field_defs d SET archived_at = now()
     WHERE d.tenant_id = app.tenant_id() AND d.id = ANY (${[...fieldIds]}::uuid[]) AND d.archived_at IS NULL AND d.origin <> 'manual'
       AND NOT EXISTS (SELECT 1 FROM contact_field_values v WHERE v.tenant_id = d.tenant_id AND v.field_id = d.id)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}
