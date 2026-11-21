// Running the copilot for one lead (CP-1..CP-10): load, plan (pure core), ask the LOCAL model twice
// (summary, draft) with a timeout, finish (pure core). A model that is off, slow, not local or wrong leaves a
// complete result: confirmed facts, flags and the playbook draft.
//
// This module never sends, dials, changes a stage, reassigns or writes to the CRM (CP-1); its only effect is
// the HTTP call to the local model. The result goes to the assigned agent, who reviews and sends the draft
// themselves.
import { type Clock } from '@realty/core/foundation';
import { type CopilotInput, type CopilotPolicy, type CopilotPrompt, type CopilotResult, type ModelAnswer, finishCopilot, planCopilot } from '@realty/core/copilot';
import { type CopilotModel, CopilotModelError } from './model.js';
import type { CopilotSources } from './sources.js';

export interface CopilotDeps {
  /** null = model off (facts, flags and templates only) */
  model: CopilotModel | null;
  clock: Clock;
  policy: CopilotPolicy;
  timeoutMs?: number;
}

async function ask(model: CopilotModel | null, prompt: CopilotPrompt | null, timeoutMs: number): Promise<{ answer: ModelAnswer; tag: string | null }> {
  if (model === null || prompt === null) return { answer: { ok: false, problem: 'MODEL_OFF' }, tag: null };
  // run-time guard on top of the type: a cloud provider cast into this slot is refused (CP-10)
  if ((model as { locality?: unknown }).locality !== 'local') return { answer: { ok: false, problem: 'MODEL_NOT_LOCAL' }, tag: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await model.complete(prompt, { signal: ctl.signal });
    return { answer: { ok: true, raw: r.text }, tag: r.model };
  } catch (e) {
    if (e instanceof CopilotModelError && e.code === 'COPILOT_MODEL_NOT_LOCAL') return { answer: { ok: false, problem: 'MODEL_NOT_LOCAL' }, tag: null };
    return { answer: { ok: false, problem: 'MODEL_FAILED' }, tag: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runCopilot(input: CopilotInput, deps: CopilotDeps): Promise<CopilotResult> {
  const now = deps.clock.now();
  const plan = planCopilot(input, deps.policy, now);
  const t = deps.timeoutMs ?? 60_000;
  // one at a time: a 14B model on one GPU answers faster sequentially than with two requests competing
  const summary = await ask(deps.model, plan.prompts.summary, t);
  const draft = plan.draftPlan === null ? { answer: { ok: false, problem: 'MODEL_OFF' } as ModelAnswer, tag: null } : await ask(deps.model, plan.prompts.draft, t);
  return finishCopilot(plan, { summary: summary.answer, draft: draft.answer, model: summary.tag ?? draft.tag ?? null });
}

/** Loads one lead through the sources and runs the copilot; null when the lead is not visible. */
export async function runLeadCopilot(leadId: string, sources: CopilotSources, deps: CopilotDeps): Promise<CopilotResult | null> {
  const h = await sources.history.load(leadId);
  if (h === null) return null;
  const [timingCues, transcripts] = await Promise.all([sources.timing.cuesFor(leadId), sources.transcripts.transcriptsFor(leadId)]);
  return runCopilot({ lead: h.lead, activities: h.activities, priorFlags: h.priorFlags, timingCues, transcripts }, deps);
}
