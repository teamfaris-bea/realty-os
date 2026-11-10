// Shared vocabulary of api/comms (BUILD_PLAN module 12).
import type { ActionCategory, Channel, GateDecision, Initiator, Purpose } from '@realty/core/compliance';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import type { Database } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
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
  /** deterministic quiet-hours jitter seed (the message id) */
  jitterKey?: string;
  /** a message being dispatched is not counted in its own caps */
  excludeMessageId?: string;
}

/** A gate decision as the API returns it (gate outcomes are not errors, CONVENTIONS §7). */
export interface DecisionView {
  /** null for a preview that allowed (only blocking previews are stored) */
  id: string | null;
  outcome: GateDecision['outcome'];
  reasons: string[];
  explanation: string;
  deferUntil: string | null;
  canConfirm: boolean;
  phase: 'preview' | 'send' | 'confirm';
}

export type DispatchResult =
  | { kind: 'sent'; messageId: string; decision: DecisionView; providerRef: string }
  | { kind: 'dispatch_unknown'; messageId: string; decision: DecisionView }
  | { kind: 'failed'; messageId: string; decision: DecisionView; reason: string }
  | { kind: 'deferred'; messageId: string; decision: DecisionView; until: Instant }
  | { kind: 'skipped'; messageId: string; decision: DecisionView }
  | { kind: 'blocked'; messageId: string; decision: DecisionView }
  | { kind: 'needs_confirmation'; messageId: string; decision: DecisionView }
  | { kind: 'needs_retap'; messageId: string; reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' }
  | { kind: 'not_due'; messageId: string; due: Instant }
  | { kind: 'noop'; messageId: string; status: string };

export type DialResult =
  | { kind: 'dialing'; callId: string; bridgeToken: string; decision: DecisionView }
  | { kind: 'failed'; callId: string; reason: string }
  | { kind: 'noop'; callId: string };
