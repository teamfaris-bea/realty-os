// Shared vocabulary of api/assistant (BUILD_PLAN module 13).
//
// The assistant reaches the outside world ONLY through api/comms: it queues messages with
// `queueOutboundInTx` and the send-time gate (dispatchOutbound) decides when the comms.dispatch job runs
// (R-GATE-2, R-GATE-3, R-GATE-10). Model calls never run inside a database transaction.
import type { CommsDeps } from '../comms/index.js';

/** Everything the assistant needs at run time: the comms deps (db, providers, envelope, ids, links). */
export type AssistantDeps = CommsDeps;

/** What started an assistant run (assistant_actions.trigger_ref: ids and codes only, never PII). */
export interface TriggerRef {
  kind: 'inbound' | 'call_ready' | 'lead_created' | 'playbook_step' | 'agent_request' | 'handback';
  messageId?: string;
  callId?: string;
  actionId?: string;
  enrollmentId?: string;
  requestedByUserId?: string;
}

/** The outcome of one playbook step run (executePlaybookStep / sendFirstResponse). */
export type StepOutcome =
  | { kind: 'queued'; messageId: string; actionId: string; stepKey: string }
  | { kind: 'drafted'; actionId: string; stepKey: string; reason: string }
  | { kind: 'waiting'; until: number | null; reason: string }
  | { kind: 'skipped'; stepKey: string | null; reason: string }
  | { kind: 'completed' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'not_sent'; reason: string; explanation: string }
  | { kind: 'noop'; reason: string };

/** Job kinds api/assistant registers (contracts of the sweeper and of api/leads / api/comms are reused). */
export const ASSISTANT_JOBS = {
  firstResponse: 'assistant.first_response',
  enrichHandback: 'assistant.enrich_handback',
  callSummary: 'assistant.call_summary',
  callScan: 'assistant.call_scan',
  draftReply: 'assistant.draft_reply',
  playbookMigrate: 'assistant.playbook_migrate',
  playbookRevoked: 'assistant.playbook_revoked',
  matchListing: 'assistant.match_listing',
  searchScan: 'assistant.search_scan',
  dealClosed: 'assistant.deal_closed',
  closingScan: 'assistant.closing_scan',
} as const;
