// @realty/core/copilot — the lead copilot (docs/copilot/COPILOT.md): for one lead, a summary of its history
// (notes, calls, transcripts, timing cues), the next text or email for the AGENT to review and send
// themselves, and slipping flags from the speed-to-lead and slipping-lead playbooks. Pure: no I/O, no clock,
// no model call (the api layer calls the local model between planCopilot and finishCopilot). Suggestions
// only: nothing here sends, changes a stage, reassigns or writes (CP-1).
export * from './types.js';
export { chronological, isHumanTouch, isInboundReply, isInterestSignal } from './history.js';
export * from './slipping.js';
export { timingStatus, timingViews } from './timing.js';
export * from './voice.js';
export { type DraftPlan, type DraftPlanResult, finalizeDraft, planDraft, safeWord, templateDraft, unsupportedNumbers } from './draft.js';
export { COPILOT_PROMPT_VERSION, type CopilotPrompt, draftPrompt, maskContactData, summaryPrompt } from './prompt.js';
export { summaryFacts, summaryLines } from './summary.js';
export { parseDraftOutput, parseSummaryOutput } from './output.js';
export { type CopilotPlan, type ModelAnswer, finishCopilot, planCopilot } from './copilot.js';
