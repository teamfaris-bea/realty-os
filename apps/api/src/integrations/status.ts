// The honest connection status machine (PHASE2_3_PLAN §5.4 #21; R-INT-2, R-INT-3).
//
// Pure: no clock, no I/O. Instants come in on the event. Every live status is reached ONLY through
// `oauth_proved` (the provider callback after proving control) or, for the keyed kinds that have no
// external account (web-chat widget, lead inbox), `keyed_enabled`. A different external account is a new
// row: `oauth_proved` for another account id throws. `disconnected` is final (a reconnect is a new row,
// which keeps the same HMAC identities and opt-outs, E134).
//
// Owner decision D2: the out-of-scope kinds (OUT_OF_SCOPE_KINDS: Messenger, Instagram DMs, Meta Lead Ads, Meta
// ads) never move toward a connection: `partner_access_required`, `oauth_proved` and `review_approved` throw
// KIND_MISMATCH for them. A row of such a kind made before D2 can still degrade, be revoked or be disconnected
// (R-INT-5), so an Owner can retire it.
import type { Capabilities, ConnectionKind, ConnectionStatus } from '../providers/integrations/types.js';
import { OUT_OF_SCOPE_KINDS } from './catalog.js';

export const KEYED_KINDS: readonly ConnectionKind[] = ['web_chat_widget', 'lead_email'];
/**
 * External kinds connected with an API key instead of OAuth (Spark MLS, read-only). The key is saved by an
 * Owner/Admin and linked by the system actor (`key_saved`); the connection goes live only when the system's
 * validation probe proved the key works (`key_validated`), the API-key analogue of `oauth_proved`.
 */
export const API_KEY_KINDS: readonly ConnectionKind[] = ['mls_feed'];
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
  | { type: 'key_saved'; externalAccountId: string; credentialId: string }
  | { type: 'key_validated'; capabilities: Capabilities; at: string }
  | { type: 'key_rejected'; code: string; revoke: boolean }
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
  const outOfScope = OUT_OF_SCOPE_KINDS.includes(c.kind);
  switch (e.type) {
    case 'partner_access_required':
      if (outOfScope) throw bad('KIND_MISMATCH');
      if (keyed || c.status !== 'not_configured') throw bad();
      return { ...c, status: 'needs_partner_access', statusReason: 'PARTNER_ACCESS_REQUIRED' };
    case 'oauth_proved': {
      if (keyed || outOfScope) throw bad('KIND_MISMATCH');
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
      if (outOfScope) throw bad('KIND_MISMATCH');
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
    case 'key_saved': {
      // a new key replaces the old one and must be validated again before anything is read
      if (!API_KEY_KINDS.includes(c.kind)) throw bad('KIND_MISMATCH');
      if (![...CONNECTABLE_STATUSES, ...LIVE_STATUSES].includes(c.status)) throw bad();
      if (c.externalAccountId !== null && c.externalAccountId !== e.externalAccountId) throw bad('CONNECTION_ACCOUNT_IMMUTABLE');
      if (e.externalAccountId.length === 0 || e.credentialId.length === 0) throw bad();
      return { ...c, status: 'not_configured', statusReason: 'KEY_NOT_VALIDATED', externalAccountId: e.externalAccountId, credentialId: e.credentialId, capabilities: {}, lastErrorCode: null };
    }
    case 'key_validated':
      if (!API_KEY_KINDS.includes(c.kind)) throw bad('KIND_MISMATCH');
      if (![...CONNECTABLE_STATUSES, ...LIVE_STATUSES].includes(c.status) || c.credentialId === null || c.externalAccountId === null) throw bad();
      return { ...c, status: 'connected', statusReason: null, capabilities: { ...e.capabilities }, connectedAt: c.connectedAt ?? e.at, lastErrorCode: null };
    case 'key_rejected':
      // not live: nothing moves, only the result code is recorded (like proof_failed). Live: a rejected key
      // (401) is revoked; anything else degrades the connection until a later validation succeeds.
      if (!API_KEY_KINDS.includes(c.kind)) throw bad('KIND_MISMATCH');
      if (!isLive(c.status)) return { ...c, lastErrorCode: code(e.code) };
      if (e.revoke) return { ...c, status: 'revoked', statusReason: code(e.code), capabilities: {}, lastErrorCode: code(e.code) };
      return { ...c, status: 'degraded', statusReason: code(e.code), lastErrorCode: code(e.code) };
    case 'disconnect':
      // capabilities stay as the adapter last reported them (only the system writes them); a connection
      // that is not live offers nothing anyway (R-INT-2).
      return { ...c, status: 'disconnected', statusReason: 'DISCONNECTED_BY_USER', disconnectedAt: e.at };
  }
}
