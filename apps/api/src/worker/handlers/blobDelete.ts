// storage.blob_delete (ARCHITECTURE §6 maintenance; R-DATA-5 "the media job deletes the blobs"):
// erasure, purge and retention null an object's DEK (crypto-shred) and set deleted_at; this periodic
// per-tenant job then deletes the ciphertext blob from object storage and stamps blob_deleted_at.
// Idempotent: deleting a missing blob is a no-op, and a crash before COMMIT just repeats the delete.
// A blob the storage refuses is skipped (left pending for the next run) and alerted; the others proceed.
// Objects on legal hold are never touched.
import { HOUR_MS } from '@realty/core/foundation';
import type { z } from 'zod';
import { errorCode } from '../loop.js';
import { jobPayload } from '../payload.js';
import { markBlobDeleted, pendingBlobDeletes } from '../repos/objects.js';
import type { TxJobHandler } from '../types.js';

export const BlobDeletePayload = jobPayload({});
export type BlobDeletePayload = z.infer<typeof BlobDeletePayload>;

export function blobDeleteHandler(o: { batch?: number; every?: { ms: number; offsetMs?: number } } = {}): TxJobHandler<BlobDeletePayload> {
  return {
    kind: 'storage.blob_delete',
    queue: 'maintenance',
    priority: 600,
    via: 'worker',
    schema: BlobDeletePayload,
    every: o.every ?? { ms: HOUR_MS },
    periodicPayload: {},
    async run(ctx) {
      const rows = await pendingBlobDeletes(ctx.tx, o.batch ?? 500);
      // each blob on its own: one the storage refuses (permissions, outage of one key) must not roll back
      // the others' stamps or block every later blob of the tenant behind it (R-DATA-5)
      let deleted = 0;
      let failed = 0;
      let lastError = '';
      for (const r of rows) {
        try {
          await ctx.providers.storage.delete(r.storageKey);
        } catch (e) {
          failed++;
          lastError = errorCode(e).slice(0, 160);
          continue;
        }
        await markBlobDeleted(ctx.tx, r.id);
        deleted++;
      }
      if (deleted > 0) ctx.log.info('blobs deleted', { jobId: ctx.job.id.toString(), tenantId: ctx.actor.tenantId, count: deleted });
      if (failed > 0) {
        // left for the next run (still pending: blob_deleted_at stays NULL); alerted so a stuck key is seen
        ctx.log.warn('blob deletes failed', { jobId: ctx.job.id.toString(), tenantId: ctx.actor.tenantId, count: failed, error: lastError });
        ctx.alerts.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: ctx.actor.tenantId, details: { kind: 'storage.blob_delete', failed, deleted, error: lastError } });
      }
    },
  };
}
