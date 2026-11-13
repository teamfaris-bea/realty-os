// The report PDF of a shared CMA (module 71, D9 V2-A; R-CMA-9, R-CMA-7, R-MLS-2/3; E616).
//
//   GET /cma/:id/report.pdf  cma.share on the CMA's facts (owner question f: anyone who may view the shared CMA).
//
// Only a shared CMA has one (a draft or a superseded CMA is 404). Readiness is checked again at every download
// (R-CMA-7: a stale feed now pauses it, CMA_NOT_SHAREABLE), and the statement rules for print apply (rule 5: a statement
// set at the smallest renderer size ≥ max(12, the state's minimum), never substituted; CMA_STATEMENT_NOT_RENDERABLE).
// It is the report as the pack allows it now, from the stored CMA (report.ts); the email in the thread is what was sent
// then. Rendered by the configured DocumentRenderer (pdf-lib, dependency N16 pending the owner's approval; the fake
// in tests): deterministic bytes. Audited cma.report_downloaded with the cma id and the PDF's sha256 only. The route
// sends it as an attachment named "cma.pdf" (no address), nosniff, no-store.
import type { UserActor } from '@realty/core/foundation';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import type { DocumentRenderer, RenderedPdf } from '../providers/integrations/types.js';
import { ProviderError } from '../providers/types.js';
import { pdfFields, refusalFor } from './report.js';
import { getCma } from './repos.js';
import { readinessOf } from './service.js';
import { type AdminTx, reportOf } from './share.js';

export const CMA_PDF_TEMPLATE = 'cma/1';

export async function reportPdf(run: AdminTx, renderer: DocumentRenderer, actor: UserActor, id: string): Promise<RenderedPdf> {
  return run(async (tx, now) => {
    const row = await getCma(tx, id);
    if (row === null || row.status !== 'shared') throw new AppError('NOT_FOUND');
    const rd = await readinessOf(tx, now as never, row);
    if (rd.share.blockers.length > 0) throw new AppError('CMA_NOT_SHAREABLE', { blockers: rd.share.blockers.map((b) => b.code) });
    const { report } = await reportOf(tx, now, row, rd);
    if (report === null) throw new AppError('CMA_NOT_SHAREABLE', { blockers: ['NO_VALUE'] });
    const refusal = refusalFor(report, 'pdf');
    if (refusal !== null) throw new AppError('CMA_STATEMENT_NOT_RENDERABLE', { part: refusal.part, reason: refusal.reason, ...(refusal.codePoints ? { codePoints: refusal.codePoints } : {}) });
    const pdf = await renderer.renderPdf({ templateKey: CMA_PDF_TEMPLATE, fields: pdfFields(report.blocks), imageCount: 0 }).catch((e: unknown) => {
      // no renderer on this deployment: said honestly, never a 500
      if (e instanceof ProviderError && e.kind === 'not_configured') throw new AppError('INTEGRATION_NOT_CONFIGURED', { provider: 'renderer' });
      throw e;
    });
    await audit(tx, actor, { action: 'cma.report_downloaded', entity: { type: 'cma_report', id: row.id }, changes: redactSnapshot({ cma_id: row.id, pdf_sha256: pdf.sha256 }) });
    return pdf;
  });
}
