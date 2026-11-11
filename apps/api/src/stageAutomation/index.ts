// Public interface of api/stage-automation (parity module 67) for the stage-change path of api/people.
import type { Database } from '@realty/db';
import { z } from 'zod';
import { type AutomationOutcome, SKIP_REASONS } from './decide.js';
import { reconcileStageEvent } from './reconcile.js';

export { type AutomationOutcome, SKIP_REASONS, type SkipReason } from './decide.js';

/** The `automation` field of the stage-change response: started, skipped with a reason, or nothing applies. */
export const AutomationOutcomeSchema = z.union([z.object({ started: z.string() }), z.object({ skipped: z.enum(SKIP_REASONS), plan: z.string() })]).nullable();

/**
 * Called by POST /contacts/:id/stage AFTER its transaction committed, with the stage event it wrote: decides
 * that event now (its own system transaction) so the person who changed the stage is told at once. A
 * failure here never fails the stage change (it is committed): it answers null and the worker's backup scan
 * (stage_automation.scan) decides the event within a minute; the decision row makes both paths agree.
 */
export async function stageChangeAutomation(db: Database, tenantId: string, stageEventId: string, log?: { warn(o: object, m: string): void }): Promise<AutomationOutcome> {
  try {
    return (await reconcileStageEvent({ db }, tenantId, stageEventId)).automation;
  } catch (e) {
    log?.warn({ code: (e as { code?: string }).code ?? 'error' }, 'stage automation deferred to the scan');
    return null;
  }
}
