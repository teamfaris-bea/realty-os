// Public interface of api/comms (BUILD_PLAN module 12): the ONLY outbound path (send-time gate), dial,
// inbound ingestion with opt-out + atomic playbook pause, consent capture, numbers, email, recordings.
//
// Other modules (api/assistant playbook steps and the first response, saved-search alerts, api/workspace
// alert SMS) create messages with `queueOutboundInTx` and never call a provider: dispatchOutbound runs the
// send-time gate when the comms.dispatch job fires. A within-playbook assistant message must carry its
// assistant_action_id and playbook_step_run_id; an approved draft carries its approved action.
export { commsRoutes } from './routes.js';
export { commsHandlers, makeCommsHandlers } from './handlers.js';
export { type DispatchOptions, type AlertResult, PROVIDER_OPT_OUT_CODES, dispatchAgentAlertSms, dispatchOutbound, reconcileOutbound } from './dispatch.js';
export { type CallStatusEvent, type StartCallResult, RECORDING_ANNOUNCEMENT, applyCallStatus, dialOutbound, startCall } from './dial.js';
export { type InboundEvent, type IngestResult, ingestInbound, systemReplyText } from './inbound.js';
export { type ComposeInput, type ComposeResult, type QueueResult, type QueueSpec, composeHumanMessage, previewHumanMessage, queueOutboundInTx } from './compose.js';
// module 71 (CMA share): the compose box's human email in the caller's transaction (flagged export, PHASE2_3_PLAN §5.3)
export { type HumanEmailResult, type HumanEmailSpec, createHumanEmailInTx } from './compose.js';
export { type RecordingReady, onRecordingReady, transcribeRecording } from './recordings.js';
export { type StatusEvent, applyMessageStatus, nextStatus } from './status.js';
export { DISPATCH_DENY_SENTENCES, PolicyUnavailableError, buildGateInput, evaluateGate } from './gateInput.js';
export { depsFromPlatform } from './runtime.js';
export { COMMS_REQUEST_SCHEMAS, COMMS_RESPONSE_SCHEMAS } from './schemas.js';
export type { CommsDeps, DecisionView, DispatchResult, DialResult, OutboundIntent } from './types.js';
