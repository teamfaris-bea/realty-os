// Shared vocabulary of api/comms (BUILD_PLAN module 12).
import type { AiIsaGateFacts } from '@realty/core/compliance';
import type { ActionCategory, Channel, GateDecision, Initiator, Purpose } from '@realty/core/compliance';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import type { Database } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
import type { ErrorReporter } from '../observability/errors.js';
import type { Providers } from '../providers/index.js';

/**
 * Everything comms needs at run time. The HTTP routes build it from the server's Platform; the worker
 * handlers from the job context plus `commsRuntime()`. Adapters never get tenant context implicitly.
 */
export interface CommsDeps {
  db: Database;
  providers: Providers;
  envelope: EnvelopeService;
  ids: IdGenerator;
  /** absolute base of this API (unsubscribe links, provider callbacks) */
  publicBaseUrl: string;
  /** keys the stateless email links (unsubscribe); derived per purpose with HMAC */
  linkSecret: Uint8Array;
  /**
   * R-TWL-2: count outbound texts and calls against tenant_settings.telephony_daily_cap. On whenever the REAL telephony
   * adapter is configured (TELEPHONY_PROVIDER=twilio); the deterministic fake leaves it off unless a test turns it on.
   */
  telephonyDailyCap?: boolean;
  /** R-ISA-25: AI_ISA_LIVE_SENDS=false refuses AI ISA messages on a non-fake adapter of that channel (fakes are unaffected). */
  aiIsaLiveOff?: { sms: boolean; email: boolean };
  /**
   * Where comms reports a fault it turns into a recorded outcome instead of throwing (b14: a sign-in link seal that
   * cannot be read fails PORTAL_LINK_SEAL_ERROR and is reported here). The API passes the platform's error reporter;
   * the comms worker handlers raise a WORKER_ERROR alert. Codes and ids only in the context, never message content.
   */
  errorReporter?: Pick<ErrorReporter, 'capture'>;
}

/** What a send-time gate evaluation is about (buildGateInput). Never carries a plaintext address. */
export interface OutboundIntent {
  contactId: string | null;
  recipient: { kind: 'contact' | 'user'; addressHmac: string; channel: Channel; pointId: string | null; userId?: string };
  purpose: Purpose;
  initiator: Initiator;
  category: ActionCategory;
  sender: { phoneNumberId: string | null; emailIdentityId: string | null };
  /** the body exactly as it will be sent (rendered facts are derived from it) */
  body: string | null;
  /** web chat (module 22): the sending widget's state for the gate (core check 10); absent/null on other channels */
  connection?: { status: 'connected' | 'degraded' | 'other' } | null;
  /** 0080 (D12): the AI ISA facts for core checks 0/8/12 (AI ISA categories only; isa/send.ts aiIsaGateFacts) */
  aiIsa?: AiIsaGateFacts;
}

/**
 * A gate decision as the API returns it (gate outcomes are not errors, CONVENTIONS §7). Since
 * core-compliance/2.0.0 the outcome is allow | deny; nothing is deferred or confirmed.
 */
export interface DecisionView {
  /** the gate_decisions row of a blocked send; null for an allowed send and for every preview (never stored) */
  id: string | null;
  outcome: GateDecision['outcome'];
  reasons: string[];
  explanation: string;
  phase: 'preview' | 'send';
}

export type DispatchResult =
  | { kind: 'sent'; messageId: string; decision: DecisionView; providerRef: string }
  | { kind: 'dispatch_unknown'; messageId: string; decision: DecisionView }
  | { kind: 'failed'; messageId: string; decision: DecisionView; reason: string }
  | { kind: 'blocked'; messageId: string; decision: DecisionView }
  | { kind: 'needs_retap'; messageId: string; reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' }
  | { kind: 'not_due'; messageId: string; due: Instant }
  | { kind: 'noop'; messageId: string; status: string };

export type DialResult =
  | { kind: 'dialing'; callId: string; bridgeToken: string; decision: DecisionView }
  | { kind: 'failed'; callId: string; reason: string }
  | { kind: 'noop'; callId: string };

const SYSTEM = 'system' as const;
/**
 * "Written by the system" as the consent ledger records it (consent_events.actor_kind). This is NOT an
 * Actor: the system Actor is built only by worker/systemActor.ts (lint + architecture test).
 */
export const LEDGER_SYSTEM: { readonly kind: typeof SYSTEM } = Object.freeze({ kind: SYSTEM });
/** notifications.kind for platform notices (not an actor kind). */
export const SYSTEM_NOTICE = SYSTEM;
