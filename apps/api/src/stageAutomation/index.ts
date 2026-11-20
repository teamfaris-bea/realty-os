// Public interface of api/stage-automation (parity module 67) for the stage-change path of api/people.
import { type UserActor, plusMs } from '@realty/core/foundation';
import { type Database, withTenantTx } from '@realty/db';
import { z } from 'zod';
import { systemActor } from '../worker/systemActor.js';
import { SCAN_WINDOW_MS } from './contract.js';
import { decisionOf, pendingStageEvents } from './repos.js';
import { type AutomationOutcome, SKIP_REASONS, outcomeOf } from './decide.js';
import { HIDDEN_PLAN, visiblePlaybookIds } from './planNames.js';
import { reconcileStageEvent } from './reconcile.js';
import { decisionSentence } from './sentences.js';

export { type AutomationOutcome, SKIP_REASONS, type SkipReason } from './decide.js';

/** The `automation` field of the stage-change response: started, skipped with a reason, or nothing applies. */
export const AutomationOutcomeSchema = z.union([z.object({ started: z.string() }), z.object({ skipped: z.enum(SKIP_REASONS), plan: z.string() })]).nullable();

/**
 * Called by POST /contacts/:id/stage AFTER its transaction committed, with the stage event it wrote: decides
 * that event now (its own system transaction) so the person who changed the stage is told at once. A
 * failure here never fails the stage change (it is committed): it answers null and the worker's backup scan
 * (stage_automation.scan) decides the event within a minute; the decision row makes both paths agree.
 */
export async function stageChangeAutomation(db: Database, tenantId: string, stageEventId: string, log?: { warn(o: object, m: string): void }, viewer?: UserActor): Promise<AutomationOutcome> {
  try {
    const out = (await reconcileStageEvent({ db }, tenantId, stageEventId)).automation;
    return out === null || viewer === undefined ? out : await asSeenBy(db, viewer, stageEventId, out);
  } catch (e) {
    log?.warn({ code: (e as { code?: string }).code ?? 'error' }, 'stage automation deferred to the scan');
    return null;
  }
}

/**
 * The same stage posted again (R-STG-5): what is STORED for the event that put the person in that stage, as the
 * viewer may see it. Nothing is decided here that the worker would not decide anyway: when no decision is stored, the
 * event is decided now only if the backup scan's own query still lists it (the other of two taps at the same moment,
 * whose decision is being written); an older undecided event stays undecided and the answer is null.
 */
export async function stageRepeatAutomation(db: Database, tenantId: string, stageEventId: string, log?: { warn(o: object, m: string): void }, viewer?: UserActor): Promise<AutomationOutcome> {
  try {
    const stored = await withTenantTx(
      systemActor(tenantId, 'assistant'),
      async (tx, now) => {
        const d = await decisionOf(tx, stageEventId);
        return { d, pending: d === null && (await pendingStageEvents(tx, plusMs(now, -SCAN_WINDOW_MS), 1, { eventId: stageEventId })).length > 0 };
      },
      { db },
    );
    if (stored.pending) return await stageChangeAutomation(db, tenantId, stageEventId, log, viewer);
    const out = outcomeOf(stored.d);
    return out === null || viewer === undefined ? out : await asSeenBy(db, viewer, stageEventId, out);
  } catch (e) {
    log?.warn({ code: (e as { code?: string }).code ?? 'error' }, 'stage automation: the stored decision could not be read');
    return null;
  }
}

/** A plan's name only if the viewer's own RLS shows that playbook (planNames.ts: an agent's private plan is hidden from a collaborator; security review). */
async function asSeenBy(db: Database, viewer: UserActor, stageEventId: string, out: NonNullable<AutomationOutcome>): Promise<AutomationOutcome> {
  const d = await withTenantTx(systemActor(viewer.tenantId, 'worker'), (tx) => decisionOf(tx, stageEventId), { db });
  const visible = d?.playbookId ? await withTenantTx(viewer, async (tx) => (await visiblePlaybookIds(tx, [d.playbookId!])).has(d.playbookId!), { db }) : false;
  if (visible) return out;
  return 'started' in out ? { started: HIDDEN_PLAN } : { skipped: out.skipped, plan: HIDDEN_PLAN };
}

/**
 * E784, E787: `automation` in words, for the stage route's answer: decisionSentence of the STORED decision (so a
 * "cannot be reached" says its cause, exactly as the status will), with the plan named as `automation` names it for
 * this viewer. Null when there is nothing to say. A failure here never fails the stage change: the words fall back to
 * the sentence the outcome alone gives.
 */
export async function automationSentenceOf(db: Database, tenantId: string, stageEventId: string, automation: AutomationOutcome): Promise<string | null> {
  if (automation === null) return null;
  const plan = 'started' in automation ? automation.started : automation.plan;
  const fromOutcome = decisionSentence('started' in automation ? { outcome: 'started', reason: null } : { outcome: 'skipped', reason: automation.skipped }, plan);
  try {
    const d = await withTenantTx(systemActor(tenantId, 'assistant'), (tx) => decisionOf(tx, stageEventId), { db });
    return d === null ? fromOutcome : decisionSentence(d, plan);
  } catch {
    return fromOutcome;
  }
}
