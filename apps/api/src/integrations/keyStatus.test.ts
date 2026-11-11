// The API-key connection events of the status machine (Spark MLS; R-INT-2, R-INT-3).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONNECTION_STATUSES, type ConnectionStatus } from '../providers/integrations/types.js';
import { type ConnectionEvent, type ConnectionRow, ConnectionTransitionError, LIVE_STATUSES, transitionConnection } from './status.js';

const AT = '2026-11-11T12:00:00.000Z';
const row = (status: ConnectionStatus, o: Partial<ConnectionRow> = {}): ConnectionRow => ({ kind: 'mls_feed', status, statusReason: null, externalAccountId: null, credentialId: null, capabilities: {}, connectedAt: null, disconnectedAt: null, lastErrorCode: null, ...o });
const saved: ConnectionEvent = { type: 'key_saved', externalAccountId: 'spark:c1', credentialId: 'cred-1' };
const ok: ConnectionEvent = { type: 'key_validated', capabilities: { read_listings: true }, at: AT };
const tryT = (r: ConnectionRow, e: ConnectionEvent) => {
  try {
    return transitionConnection(r, e);
  } catch (err) {
    if (err instanceof ConnectionTransitionError) return null;
    throw err;
  }
};

describe('API-key connections (mls_feed)', () => {
  it('R-INT-3: a saved key links the credential but stays not_configured until validated; validation makes it live', () => {
    const s = transitionConnection(row('not_configured'), saved);
    expect(s).toMatchObject({ status: 'not_configured', statusReason: 'KEY_NOT_VALIDATED', externalAccountId: 'spark:c1', credentialId: 'cred-1', capabilities: {} });
    expect(transitionConnection(s, ok)).toMatchObject({ status: 'connected', connectedAt: AT, capabilities: { read_listings: true }, lastErrorCode: null });
    expect(() => transitionConnection(row('not_configured'), ok)).toThrow(ConnectionTransitionError); // no key, no proof
  });

  it('a new key on a live connection drops it back to not_configured with no capabilities; the account id never changes', () => {
    const live = row('connected', { externalAccountId: 'spark:c1', credentialId: 'cred-1', capabilities: { read_listings: true }, connectedAt: AT });
    expect(transitionConnection(live, { ...saved, credentialId: 'cred-2' } as ConnectionEvent)).toMatchObject({ status: 'not_configured', credentialId: 'cred-2', capabilities: {} });
    expect(() => transitionConnection(live, { ...saved, externalAccountId: 'spark:other' } as ConnectionEvent)).toThrow(/CONNECTION_ACCOUNT_IMMUTABLE/);
  });

  it('rejections: not live → only the code is recorded; live → 401 revokes, anything else degrades', () => {
    const pending = row('not_configured', { externalAccountId: 'spark:c1', credentialId: 'cred-1' });
    expect(transitionConnection(pending, { type: 'key_rejected', code: 'INVALID_CREDENTIALS', revoke: true })).toMatchObject({ status: 'not_configured', lastErrorCode: 'INVALID_CREDENTIALS' });
    const live = transitionConnection(pending, ok);
    expect(transitionConnection(live, { type: 'key_rejected', code: 'INVALID_CREDENTIALS', revoke: true })).toMatchObject({ status: 'revoked', capabilities: {}, statusReason: 'INVALID_CREDENTIALS' });
    expect(transitionConnection(live, { type: 'key_rejected', code: 'RATE_LIMITED', revoke: false })).toMatchObject({ status: 'degraded', statusReason: 'RATE_LIMITED' });
  });

  it('key events are refused for OAuth and keyed kinds, and after a disconnect', () => {
    for (const kind of ['messenger_page', 'gbp_location', 'web_chat_widget'] as const) {
      expect(tryT({ ...row('not_configured'), kind }, saved)).toBeNull();
      expect(tryT({ ...row('connected', { externalAccountId: 'x', credentialId: 'y', connectedAt: AT }), kind }, ok)).toBeNull();
    }
    expect(tryT(row('disconnected', { disconnectedAt: AT }), saved)).toBeNull();
  });

  it('R-INT-3 (property): an mls_feed connection enters a live status only through key_validated, always with an account and a credential', () => {
    const events = fc.oneof(
      fc.constant(saved),
      fc.constant(ok),
      fc.record({ type: fc.constant('key_rejected' as const), code: fc.constantFrom('INVALID_CREDENTIALS', 'RATE_LIMITED', 'UNREACHABLE'), revoke: fc.boolean() }),
      fc.constant<ConnectionEvent>({ type: 'disconnect', at: AT }),
      fc.constant<ConnectionEvent>({ type: 'health_ok' }),
    );
    fc.assert(
      fc.property(fc.constantFrom(...CONNECTION_STATUSES), fc.array(events, { maxLength: 12 }), (s0, es) => {
        let r = row(s0, s0 === 'disconnected' ? { disconnectedAt: AT } : LIVE_STATUSES.includes(s0) ? { externalAccountId: 'spark:c1', credentialId: 'cred-0', connectedAt: AT } : {});
        for (const e of es) {
          const n = tryT(r, e as ConnectionEvent);
          if (!n) continue;
          if (LIVE_STATUSES.includes(n.status) && !LIVE_STATUSES.includes(r.status)) {
            expect(['key_validated', 'health_ok']).toContain(e.type);
            expect(n.credentialId).not.toBeNull();
            expect(n.externalAccountId).not.toBeNull();
          }
          r = n;
        }
      }),
      { numRuns: 2000 },
    );
  });
});
