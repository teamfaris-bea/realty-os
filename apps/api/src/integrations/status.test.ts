// The honest connection status machine (R-INT-2, R-INT-3, E134, E160): vectors and properties.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONNECTION_KINDS, CONNECTION_STATUSES, type ConnectionKind, type ConnectionStatus } from '../providers/integrations/types.js';
import { OUT_OF_SCOPE_KINDS } from './catalog.js';
import { CONNECTABLE_STATUSES, type ConnectionEvent, type ConnectionRow, ConnectionTransitionError, KEYED_KINDS, LIVE_STATUSES, RESERVING_STATUSES, transitionConnection } from './status.js';

const AT = '2026-11-11T12:00:00.000Z';
function row(kind: ConnectionKind, status: ConnectionStatus, o: Partial<ConnectionRow> = {}): ConnectionRow {
  return { kind, status, statusReason: null, externalAccountId: null, credentialId: null, capabilities: {}, connectedAt: null, disconnectedAt: null, lastErrorCode: null, ...o };
}
const proved = (o: Partial<Extract<ConnectionEvent, { type: 'oauth_proved' }>> = {}): ConnectionEvent => ({
  type: 'oauth_proved',
  externalAccountId: 'page-1',
  credentialId: 'cred-1',
  capabilities: { publish_posts: true },
  reviewPending: false,
  at: AT,
  ...o,
});

describe('transitionConnection vectors', () => {
  it('R-INT-3: only oauth_proved links an account and moves an external kind live; it records what the adapter reported', () => {
    const r = transitionConnection(row('facebook_page', 'not_configured'), proved());
    expect(r).toMatchObject({ status: 'connected', externalAccountId: 'page-1', credentialId: 'cred-1', capabilities: { publish_posts: true }, connectedAt: AT, lastErrorCode: null });
  });

  it('R-INT-3: a platform still reviewing the account ends in pending_review (reserves, routes nothing)', () => {
    const r = transitionConnection(row('instagram_business', 'not_configured'), proved({ reviewPending: true }));
    expect(r).toMatchObject({ status: 'pending_review', statusReason: 'PLATFORM_REVIEW_PENDING', connectedAt: null });
    expect(transitionConnection(r, { type: 'review_approved', at: AT })).toMatchObject({ status: 'connected', connectedAt: AT });
  });

  it('E160: a failed proof links nothing and leaves the status where it was', () => {
    const before = row('facebook_page', 'not_configured');
    const r = transitionConnection(before, { type: 'proof_failed', code: 'ACCOUNT_NOT_MANAGED' });
    expect(r).toEqual({ ...before, lastErrorCode: 'ACCOUNT_NOT_MANAGED' });
  });

  it('R-INT-3: the account id never changes; a different account is a new row', () => {
    const revoked = row('facebook_page', 'revoked', { externalAccountId: 'page-1', credentialId: 'c' });
    expect(() => transitionConnection(revoked, proved({ externalAccountId: 'page-2' }))).toThrow(/CONNECTION_ACCOUNT_IMMUTABLE/);
    expect(transitionConnection(revoked, proved({ credentialId: 'c2' }))).toMatchObject({ status: 'connected', credentialId: 'c2' });
  });

  it('E134: disconnected is final (a reconnect is a new row with the same HMAC identities)', () => {
    const d = transitionConnection(row('facebook_page', 'connected', { externalAccountId: 'p', credentialId: 'c' }), { type: 'disconnect', at: AT });
    expect(d).toMatchObject({ status: 'disconnected', disconnectedAt: AT, statusReason: 'DISCONNECTED_BY_USER' });
    for (const e of [proved(), { type: 'disconnect', at: AT } as const, { type: 'health_ok' } as const]) expect(() => transitionConnection(d, e)).toThrow(ConnectionTransitionError);
  });

  it('degraded and health', () => {
    const c = row('facebook_page', 'connected', { externalAccountId: 'p', credentialId: 'c' });
    const g = transitionConnection(c, { type: 'health_degraded', code: 'PROVIDER_5XX' });
    expect(g).toMatchObject({ status: 'degraded', statusReason: 'PROVIDER_5XX' });
    expect(transitionConnection(g, { type: 'health_ok' }).status).toBe('connected');
    expect(() => transitionConnection(row('facebook_page', 'not_configured'), { type: 'health_degraded', code: 'X' })).toThrow();
    expect(() => transitionConnection(c, { type: 'health_degraded', code: 'not a code' })).toThrow(TypeError);
  });

  it('token revoked at the provider clears what the adapter reported', () => {
    const c = row('facebook_page', 'connected', { externalAccountId: 'p', credentialId: 'c', capabilities: { publish_posts: true } });
    expect(transitionConnection(c, { type: 'token_revoked', code: 'TOKEN_INVALID' })).toMatchObject({ status: 'revoked', capabilities: {} });
  });

  it('partner feeds say needs_partner_access; keyed kinds never take an OAuth proof', () => {
    expect(transitionConnection(row('zillow_feed', 'not_configured'), { type: 'partner_access_required' }).status).toBe('needs_partner_access');
    expect(() => transitionConnection(row('web_chat_widget', 'not_configured'), proved())).toThrow(/KIND_MISMATCH/);
    expect(transitionConnection(row('web_chat_widget', 'not_configured'), { type: 'keyed_enabled', at: AT }).status).toBe('connected');
    expect(() => transitionConnection(row('facebook_page', 'not_configured'), { type: 'keyed_enabled', at: AT })).toThrow(/KIND_MISMATCH/);
  });

  it('a live connection cannot be "re-proved" in place (no silent account swap or credential overwrite)', () => {
    for (const s of ['pending_review', 'connected', 'degraded'] as const) {
      expect(() => transitionConnection(row('facebook_page', s, { externalAccountId: 'page-1', credentialId: 'c' }), proved())).toThrow(ConnectionTransitionError);
    }
  });

  it('R-INT-3 (D2): an out-of-scope kind never moves toward a connection (KIND_MISMATCH); a row made before D2 can still degrade, be revoked or be disconnected', () => {
    for (const kind of OUT_OF_SCOPE_KINDS) {
      const linked = { externalAccountId: 'page-1', credentialId: 'c' };
      expect(() => transitionConnection(row(kind, 'not_configured'), proved()), kind).toThrow(/KIND_MISMATCH/);
      expect(() => transitionConnection(row(kind, 'revoked', linked), proved()), kind).toThrow(/KIND_MISMATCH/);
      expect(() => transitionConnection(row(kind, 'not_configured'), { type: 'partner_access_required' }), kind).toThrow(/KIND_MISMATCH/);
      expect(() => transitionConnection(row(kind, 'pending_review', linked), { type: 'review_approved', at: AT }), kind).toThrow(/KIND_MISMATCH/);
      const live = row(kind, 'connected', linked);
      expect(transitionConnection(live, { type: 'health_degraded', code: 'PROVIDER_5XX' }).status, kind).toBe('degraded');
      expect(transitionConnection(live, { type: 'token_revoked', code: 'TOKEN_INVALID' }).status, kind).toBe('revoked');
      expect(transitionConnection(live, { type: 'disconnect', at: AT }).status, kind).toBe('disconnected');
      expect(transitionConnection(row(kind, 'not_configured'), { type: 'disconnect', at: AT }).status, kind).toBe('disconnected');
    }
    // D2: Meta connects for publishing only, through the 0025 kinds
    for (const kind of ['facebook_page', 'instagram_business'] as const) expect(transitionConnection(row(kind, 'not_configured'), proved()).status, kind).toBe('connected');
  });
});

// ---- properties -------------------------------------------------------------------------------------

const kindArb = fc.constantFrom(...CONNECTION_KINDS);
const statusArb = fc.constantFrom(...CONNECTION_STATUSES);
const codeArb = fc.constantFrom('PROVIDER_5XX', 'TOKEN_INVALID', 'ACCOUNT_NOT_MANAGED');
const eventArb: fc.Arbitrary<ConnectionEvent> = fc.oneof(
  fc.constant({ type: 'partner_access_required' } as const),
  fc.record({ type: fc.constant('oauth_proved' as const), externalAccountId: fc.constantFrom('a', 'b'), credentialId: fc.constantFrom('c1', 'c2'), capabilities: fc.dictionary(fc.constantFrom('publish_posts', 'read_reviews'), fc.boolean()), reviewPending: fc.boolean(), at: fc.constant(AT) }),
  fc.record({ type: fc.constant('proof_failed' as const), code: codeArb }),
  fc.constant({ type: 'review_approved', at: AT } as const),
  fc.record({ type: fc.constant('health_degraded' as const), code: codeArb }),
  fc.constant({ type: 'health_ok' } as const),
  fc.record({ type: fc.constant('token_revoked' as const), code: codeArb }),
  fc.constant({ type: 'keyed_enabled', at: AT } as const),
  fc.constant({ type: 'disconnect', at: AT } as const),
);
const rowArb = fc.record({ kind: kindArb, status: statusArb, acct: fc.option(fc.constantFrom('a', 'b'), { nil: null }) }).map(({ kind, status, acct }) =>
  row(kind, status, { externalAccountId: acct, credentialId: acct ? 'c0' : null }),
);

function tryT(r: ConnectionRow, e: ConnectionEvent): ConnectionRow | null {
  try {
    return transitionConnection(r, e);
  } catch (err) {
    if (err instanceof ConnectionTransitionError || err instanceof TypeError) return null;
    throw err;
  }
}

describe('transitionConnection properties', () => {
  it('deterministic and pure (the input row is never mutated)', () => {
    fc.assert(
      fc.property(rowArb, eventArb, (r, e) => {
        const snap = JSON.stringify(r);
        const a = tryT(r, e);
        const b = tryT(r, e);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(JSON.stringify(r)).toBe(snap);
      }),
      { numRuns: 2000 },
    );
  });

  it('R-INT-3: an external kind enters a reserving status only through oauth_proved, from a connectable status, with an account and a credential', () => {
    fc.assert(
      fc.property(rowArb, eventArb, (r, e) => {
        const n = tryT(r, e);
        if (!n || KEYED_KINDS.includes(r.kind)) return;
        if (RESERVING_STATUSES.includes(n.status) && !RESERVING_STATUSES.includes(r.status)) {
          expect(e.type).toBe('oauth_proved');
          expect(CONNECTABLE_STATUSES).toContain(r.status);
          expect(n.externalAccountId).not.toBeNull();
          expect(n.credentialId).not.toBeNull();
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('R-INT-3: a linked account id never changes, along any event sequence', () => {
    fc.assert(
      fc.property(rowArb, fc.array(eventArb, { maxLength: 12 }), (r0, es) => {
        let r = r0;
        for (const e of es) {
          const n = tryT(r, e);
          if (!n) continue;
          if (r.externalAccountId !== null) expect(n.externalAccountId).toBe(r.externalAccountId);
          if (n.kind !== r.kind) throw new Error('kind changed');
          r = n;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('R-INT-3 (D2): an out-of-scope kind never enters a reserving status, and a pending one is never approved, along any event sequence', () => {
    fc.assert(
      fc.property(fc.constantFrom(...OUT_OF_SCOPE_KINDS), statusArb, fc.array(eventArb, { maxLength: 12 }), (kind, s0, es) => {
        let r = row(kind, s0, RESERVING_STATUSES.includes(s0) ? { externalAccountId: 'a', credentialId: 'c0' } : {});
        for (const e of es) {
          const n = tryT(r, e);
          if (!n) continue;
          if (!RESERVING_STATUSES.includes(r.status)) expect(RESERVING_STATUSES).not.toContain(n.status);
          if (r.status === 'pending_review') expect(n.status).not.toBe('connected');
          r = n;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('E134: once disconnected, every later event is refused', () => {
    fc.assert(
      fc.property(rowArb, eventArb, (r, e) => {
        if (r.status === 'disconnected') expect(tryT(r, e)).toBeNull();
      }),
    );
  });

  it('keyed kinds (web chat, lead inbox) never carry an external account through the machine', () => {
    fc.assert(
      fc.property(kindArb.filter((k) => KEYED_KINDS.includes(k)), fc.array(eventArb, { maxLength: 10 }), (kind, es) => {
        let r = row(kind, 'not_configured');
        for (const e of es) r = tryT(r, e) ?? r;
        expect(r.externalAccountId).toBeNull();
        expect(LIVE_STATUSES.includes(r.status) ? r.connectedAt : AT).toBe(AT);
      }),
    );
  });
});
