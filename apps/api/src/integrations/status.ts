// The honest connection status machine (PHASE2_3_PLAN §5.4 #21; R-INT-2, R-INT-3).
//
// Pure: no clock, no I/O. Instants come in on the event. Every live status is reached ONLY through
// `oauth_proved` (the provider callback after proving control) or, for the keyed kinds that have no
// external account (web-chat widget, lead inbox), `keyed_enabled`. A different external account is a new
// row: `oauth_proved` for another account id throws. `disconnected` is final (a reconnect is a new row,
// which keeps the same HMAC identities and opt-outs, E134).
import type { Capabilities, ConnectionKind, ConnectionStatus } from '../providers/integrations/types.js';

export const KEYED_KINDS: readonly ConnectionKind[] = ['web_chat_widget', 'lead_email'];
export const LIVE_STATUSES: readonly ConnectionStatus[] = ['connected', 'degraded'];
/** Statuses that reserve the external account (0018 integration_connections_live_account). */
export const RESERVING_STATUSES: readonly ConnectionStatus[] = ['pending_review', 'connected', 'degraded'];
/** Statuses a provider callback may start from. */
export const CONNECTABLE_STATUSES: readonly ConnectionStatus[] = ['not_configured', 'needs_partner_access', 'revoked'];

export interface ConnectionRow {
  kind: ConnectionKind;
  status: ConnectionStatus;
  statusReason: string | null;
  externalAccountId: string | null;
  credentialId: string | null;
  capabilities: Capabilities;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastErrorCode: string | null;
}

export type ConnectionEvent =
  | { type: 'partner_access_required' }
  | { type: 'oauth_proved'; externalAccountId: string; credentialId: string; capabilities: Capabilities; reviewPending: boolean; at: string }
  | { type: 'proof_failed'; code: string }
  | { type: 'review_approved'; at: string }
  | { type: 'health_degraded'; code: string }
  | { type: 'health_ok' }
  | { type: 'token_revoked'; code: string }
  | { type: 'keyed_enabled'; at: string }
  | { type: 'disconnect'; at: string };

export class ConnectionTransitionError extends Error {
  override readonly name = 'ConnectionTransitionError';
  constructor(
    readonly from: ConnectionStatus,
    readonly event: ConnectionEvent['type'],
    readonly code: 'TRANSITION_INVALID' | 'CONNECTION_ACCOUNT_IMMUTABLE' | 'KIND_MISMATCH' = 'TRANSITION_INVALID',
  ) {
    super(`${code}: ${event} from ${from}`);
  }
}

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
function code(c: string): string {
  if (!CODE_RE.test(c)) throw new TypeError('status codes are UPPER_SNAKE');
  return c;
}

export function isLive(s: ConnectionStatus): boolean {
  return LIVE_STATUSES.includes(s);
}

export function transitionConnection(c: ConnectionRow, e: ConnectionEvent): ConnectionRow {
  const bad = (k: ConnectionTransitionError['code'] = 'TRANSITION_INVALID') => new ConnectionTransitionError(c.status, e.type, k);
  if (c.status === 'disconnected') throw bad();
  const keyed = KEYED_KINDS.includes(c.kind);
  switch (e.type) {
    case 'partner_access_required':
      if (keyed || c.status !== 'not_configured') throw bad();
      return { ...c, status: 'needs_partner_access', statusReason: 'PARTNER_ACCESS_REQUIRED' };
    case 'oauth_proved': {
      if (keyed) throw bad('KIND_MISMATCH');
      if (!CONNECTABLE_STATUSES.includes(c.status)) throw bad();
      if (c.externalAccountId !== null && c.externalAccountId !== e.externalAccountId) throw bad('CONNECTION_ACCOUNT_IMMUTABLE');
      if (e.externalAccountId.length === 0 || e.credentialId.length === 0) throw bad();
      const status: ConnectionStatus = e.reviewPending ? 'pending_review' : 'connected';
      return {
        ...c,
        status,
        statusReason: e.reviewPending ? 'PLATFORM_REVIEW_PENDING' : null,
        externalAccountId: e.externalAccountId,
        credentialId: e.credentialId,
        capabilities: { ...e.capabilities },
        connectedAt: status === 'connected' ? e.at : c.connectedAt,
        lastErrorCode: null,
      };
    }
    case 'proof_failed':
      // E160: nothing is linked and the status does not move; only the error is recorded.
      if (!CONNECTABLE_STATUSES.includes(c.status)) throw bad();
      return { ...c, lastErrorCode: code(e.code) };
    case 'review_approved':
      if (c.status !== 'pending_review') throw bad();
      return { ...c, status: 'connected', statusReason: null, connectedAt: c.connectedAt ?? e.at };
    case 'health_degraded':
      if (!isLive(c.status)) throw bad();
      return { ...c, status: 'degraded', statusReason: code(e.code), lastErrorCode: code(e.code) };
    case 'health_ok':
      if (c.status !== 'degraded') throw bad();
      return { ...c, status: 'connected', statusReason: null };
    case 'token_revoked':
      if (keyed || !RESERVING_STATUSES.includes(c.status)) throw bad();
      return { ...c, status: 'revoked', statusReason: code(e.code), capabilities: {} };
    case 'keyed_enabled':
      if (!keyed) throw bad('KIND_MISMATCH');
      if (c.status !== 'not_configured') throw bad();
      return { ...c, status: 'connected', statusReason: null, connectedAt: e.at };
    case 'disconnect':
      // capabilities stay as the adapter last reported them (only the system writes them); a connection
      // that is not live offers nothing anyway (R-INT-2).
      return { ...c, status: 'disconnected', statusReason: 'DISCONNECTED_BY_USER', disconnectedAt: e.at };
  }
}
