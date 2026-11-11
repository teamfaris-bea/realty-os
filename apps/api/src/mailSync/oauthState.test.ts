// Unit tests of the Gmail OAuth state (R-GMAIL-2): MAC, expiry, own key purpose, derived PKCE.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { signState } from '../integrations/oauthState.js';
import { mailPkceVerifier, newNonce, pkceChallenge, signMailState, verifyMailState } from './oauthState.js';

const secret = new Uint8Array(32).fill(7);
const s = { tenantId: '01a1cc2e-917a-7af9-884e-b52d8a717d29', userId: '01a1cc2e-917a-7af9-884e-b52d8a717d30', disclosureSha256: 'a'.repeat(64), expiresAt: 2_000_000_000_000, nonce: newNonce() };

describe('mail OAuth state', () => {
  it('R-GMAIL-2: round-trips; expired is refused; another secret is refused', () => {
    const t = signMailState(secret, s);
    expect(verifyMailState(secret, t, 1)).toEqual({ ok: true, state: s });
    expect(verifyMailState(secret, t, s.expiresAt + 1)).toEqual({ ok: false, code: 'STATE_EXPIRED' });
    expect(verifyMailState(new Uint8Array(32).fill(8), t, 1)).toEqual({ ok: false, code: 'STATE_INVALID' });
  });

  it('property: any single-character change of a state is refused', () => {
    const t = signMailState(secret, s);
    fc.assert(
      fc.property(fc.nat(t.length - 1), fc.constantFrom('A', 'b', '0', '-', '_'), (i, ch) => {
        if (t[i] === ch) return;
        const bad = t.slice(0, i) + ch + t.slice(i + 1);
        expect(verifyMailState(secret, bad, 1).ok).toBe(false);
      }),
    );
  });

  it('a module 21 integrations state is never a Gmail state (separate key purpose)', () => {
    const integ = signState(secret, { tenantId: s.tenantId, connectionId: s.userId, userId: s.userId, kind: 'gbp_location', externalAccountId: 'x', fence: '1', expiresAt: s.expiresAt, nonce: 'n' });
    expect(verifyMailState(secret, integ, 1).ok).toBe(false);
  });

  it('the PKCE verifier is bound to the nonce, the tenant and the user', () => {
    const v = mailPkceVerifier(secret, s);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mailPkceVerifier(secret, { ...s, userId: s.tenantId })).not.toBe(v);
    expect(mailPkceVerifier(secret, { ...s, nonce: newNonce() })).not.toBe(v);
    expect(pkceChallenge(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
