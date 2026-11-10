// Public interface of api/assistant (BUILD_PLAN module 13): AI runs with evidence-backed claims,
// one-tap draft / handback approval, the call pipeline, playbooks (approve rules, not every message),
// enrollments and the step runner, the 60-second first response, saved searches and handback enrichment.
// Every outbound message goes through api/comms (queueOutboundInTx → dispatchOutbound's send-time gate).
export { assistantRoutes } from './routes.js';
export { assistantHandlers, makeAssistantHandlers } from './handlers.js';
export { type ModelRun, runAssistant, runModel } from './runs.js';
export { type ApproveInput, type ApproveResult, approveAction, inbox, rejectAction, reviewClaim } from './drafts.js';
export { type CallPipelineResult, summarizeCall } from './callPipeline.js';
export { approveVersion, createPlaybook, createVersion, listPlaybooks, migrateVersionEnrollments, pauseRevokedEnrollments, revokeVersion } from './playbooks.js';
export { enrollContact, enrollOnDealClosed, executePlaybookStep, executePlaybookStepInTx, pauseEnrollment, resumeEnrollment, stopEnrollment } from './enrollments.js';
export { sendFirstResponse, sendFirstResponseInTx } from './firstResponse.js';
export { activateSearch, approveSearch, matchSavedSearches, pauseSearch, previewSearch } from './searches.js';
export { enrichHandback } from './handbacks.js';
export { BUILT_IN_TEMPLATES, templateByKey } from './templates.js';
export { ASSISTANT_REQUEST_SCHEMAS, ASSISTANT_RESPONSE_SCHEMAS } from './schemas.js';
export { ASSISTANT_JOBS, type AssistantDeps, type StepOutcome, type TriggerRef } from './types.js';
