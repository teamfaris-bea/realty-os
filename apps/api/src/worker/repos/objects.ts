// stored_objects rows whose blob must still be deleted (DEK already nulled by erasure / retention).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export async function pendingBlobDeletes(tx: Tx, limit: number): Promise<{ id: string; storageKey: string }[]> {
  const r = await sql<{ id: string; storage_key: string }>`
    SELECT id, storage_key FROM stored_objects
     WHERE tenant_id = app.tenant_id() AND deleted_at IS NOT NULL AND blob_deleted_at IS NULL AND NOT legal_hold
     ORDER BY deleted_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, storageKey: x.storage_key }));
}

export async function markBlobDeleted(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE stored_objects SET blob_deleted_at = clock_timestamp()
             WHERE tenant_id = app.tenant_id() AND id = ${id} AND blob_deleted_at IS NULL`.execute(tx);
}
