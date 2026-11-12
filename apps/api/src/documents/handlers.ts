// Job handlers of api/documents (registered in worker/handlers/index.ts, one line; R-OWN-27).
//
//   documents.scan       default, standalone, as the system: TX1 read, the scan outside a transaction, TX2 verdict
//   documents.extract    default, standalone, as the system: the PDF text layer → a contract_extraction proposal
//   documents.reconcile  per tenant, every 5 min (150 s offset), tx, as the system: lost scans, retention, shreds
// Payloads are ids only (R-TEN-7). Nothing here sends (D1): no dispatch, no dial, no provider outbound call.
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { extractDocument } from './extract.js';
import { reconcileInTx, scanDocument } from './scan.js';
import { DOCUMENTS_RECONCILE_EVERY_MS, DOCUMENTS_RECONCILE_OFFSET_MS, DOCUMENT_JOBS, type DocumentDeps } from './types.js';

export type DocumentDepsFor = (providers: Providers) => DocumentDeps;
const defaultDeps: DocumentDepsFor = (providers) => ({ ...commsRuntime(), providers });

const DocPayload = jobPayload({ documentId: zId });
const Empty = jobPayload({});

export function makeDocumentHandlers(depsFor: DocumentDepsFor = defaultDeps): JobHandler<unknown>[] {
  const scan: StandaloneJobHandler<{ documentId: string }> = {
    kind: DOCUMENT_JOBS.scan,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    schema: DocPayload,
    async run(ctx, p) {
      const r = await scanDocument(depsFor(ctx.providers), ctx.actor, (fn) => ctx.withTx(fn), p.documentId);
      ctx.log.info('documents.scan', { jobId: ctx.job.id.toString(), result: r.result, ...(r.result === 'scanned' ? { verdict: r.verdict.verdict } : {}) });
    },
  };
  const extract: StandaloneJobHandler<{ documentId: string }> = {
    kind: DOCUMENT_JOBS.extract,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    schema: DocPayload,
    async run(ctx, p) {
      const r = await extractDocument(depsFor(ctx.providers), ctx.actor, (fn) => ctx.withTx(fn), p.documentId);
      ctx.log.info('documents.extract', { jobId: ctx.job.id.toString(), result: r.result });
    },
  };
  const reconcile: TxJobHandler<Record<string, never>> = {
    kind: DOCUMENT_JOBS.reconcile,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: DOCUMENTS_RECONCILE_EVERY_MS, offsetMs: DOCUMENTS_RECONCILE_OFFSET_MS },
    periodicPayload: {},
    async run(ctx) {
      const r = await reconcileInTx(ctx.tx, { providers: ctx.providers }, ctx.now);
      if (r.requeued + r.stamped + r.shredded + r.superseded > 0) ctx.log.info('documents.reconcile', { jobId: ctx.job.id.toString(), ...r });
    },
  };
  return [scan, extract, reconcile] as unknown as JobHandler<unknown>[];
}

/** Everything api/documents registers with the worker (CONVENTIONS §3). */
export const documentHandlers: JobHandler<unknown>[] = makeDocumentHandlers();
