// The copilot pipeline, pure (CP-1..CP-10). The api layer runs it in two steps around the local model:
//
//   const plan = planCopilot(input, policy, now)          // flags, facts, template draft, prompts
//   ... the api asks the LOCAL model plan.prompts.summary / plan.prompts.draft (or skips the model) ...
//   const result = finishCopilot(plan, { summary, draft, model })
//
// Without a model the result is still complete: confirmed facts, every slipping flag and a playbook draft.
// The result is a suggestion: `suggestionOnly: true`, no send, stage change, reassignment or write (CP-1).
import type { Instant } from '../foundation/index.js';
import { type DraftPlan, finalizeDraft, planDraft, templateDraft } from './draft.js';
import { parseDraftOutput, parseSummaryOutput } from './output.js';
import { type CopilotPrompt, draftPrompt, summaryPrompt } from './prompt.js';
import { computeSlipFlags } from './slipping.js';
import { summaryFacts, summaryLines } from './summary.js';
import type { CopilotInput, CopilotModelProblem, CopilotPolicy, CopilotResult, SlipFlag, SummaryFacts } from './types.js';

export interface CopilotPlan {
  input: CopilotInput;
  policy: CopilotPolicy;
  now: Instant;
  flags: SlipFlag[];
  facts: SummaryFacts;
  lines: string[];
  draftPlan: DraftPlan | null;
  noDraftReason: CopilotResult['noDraftReason'];
  prompts: { summary: CopilotPrompt; draft: CopilotPrompt | null };
}

export function planCopilot(input: CopilotInput, policy: CopilotPolicy, now: Instant): CopilotPlan {
  const flags = computeSlipFlags(input, policy, now);
  const facts = summaryFacts(input, policy, now);
  const lines = summaryLines(facts, now);
  const dp = planDraft(input, flags, policy, now);
  const draftPlan = dp.ok ? dp.plan : null;
  const tpl = draftPlan === null ? null : templateDraft(draftPlan, input, policy);
  return {
    input,
    policy,
    now,
    flags,
    facts,
    lines,
    draftPlan,
    noDraftReason: dp.ok ? null : dp.reason,
    prompts: {
      summary: summaryPrompt(input, facts, lines, now),
      draft: draftPlan === null || tpl === null ? null : draftPrompt(input, draftPlan, policy, lines, tpl.text, now),
    },
  };
}

/** One model answer: its raw text, or the reason there is none. */
export type ModelAnswer = { ok: true; raw: string } | { ok: false; problem: Extract<CopilotModelProblem, 'MODEL_OFF' | 'MODEL_NOT_LOCAL' | 'MODEL_FAILED'> };

export function finishCopilot(plan: CopilotPlan, answers: { summary: ModelAnswer; draft: ModelAnswer; model: string | null }): CopilotResult {
  let narrative: CopilotResult['summary']['narrative'] = null;
  let narrativeProblem: CopilotModelProblem | null = null;
  if (answers.summary.ok) {
    const s = parseSummaryOutput(answers.summary.raw);
    if (s.ok) narrative = { text: s.text, model: answers.model ?? 'unknown', label: 'UNVERIFIED' };
    else narrativeProblem = s.problem;
  } else narrativeProblem = answers.summary.problem;

  let draft: CopilotResult['draft'] = null;
  let draftProblem: CopilotModelProblem | null = null;
  if (plan.draftPlan !== null) {
    let modelDraft: { text: string; subject: string | null; context: string } | null = null;
    if (answers.draft.ok) {
      const d = parseDraftOutput(answers.draft.raw);
      if (d.ok) modelDraft = { text: d.text, subject: d.subject, context: plan.prompts.draft?.user ?? '' };
      else draftProblem = d.problem;
    } else draftProblem = answers.draft.problem;
    const f = finalizeDraft(plan.draftPlan, plan.input, plan.policy, modelDraft);
    draft = f.draft;
    if (f.modelRejected !== null) draftProblem = 'MODEL_OUTPUT_FAILED_CHECKS';
  }

  return {
    leadId: plan.input.lead.id,
    generatedAt: plan.now,
    suggestionOnly: true,
    flags: plan.flags,
    summary: { facts: plan.facts, lines: plan.lines, narrative, narrativeProblem },
    draft,
    noDraftReason: plan.noDraftReason,
    draftProblem,
    model: answers.model,
  };
}
