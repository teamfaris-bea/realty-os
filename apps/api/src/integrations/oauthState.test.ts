// OAuth state and PKCE (R-INT-3, R-TEN-3): forged, altered, expired and cross-secret states are refused.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OAuthState, STATE_TTL_MS, pkceChallengeOf, pkceVerifier, signState, verifyState } from './oauthState.js';

const secret = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(8);
const base: OAuthState = {
  tenantId: '0190d1a4-0000-7000-8000-000000000001',
  connectionId: '0190d1a4-0000-7000-8000-000000000002',
  userId: '0190d1a4-0000-7000-8000-000000000003',
  kind: 'messenger_page',
  externalAccountId: 'page-123',
  fence: '1762862400000000',
  expiresAt: 1_000_000 + STATE_TTL_MS,
  nonce: 'bm9uY2Vub25jZW5vbmNl',
};

describe('OAuth state', () => {
  it('round-trips and expires', () => {
    const t = signState(secret, base);
    expect(verifyState(secret, t, 1_000_000)).toEqual({ ok: true, state: base });
    expect(verifyState(secret, t, base.expiresAt + 1)).toEqual({ ok: false, code: 'STATE_EXPIRED' });
  });

  it('R-TEN-3: a state signed with another secret, or with any byte changed, is refused (the tenant cannot be chosen by the request)', () => {
    const t = signState(secret, base);
    expect(verifyState(other, t, 1_000_000)).toEqual({ ok: false, code: 'STATE_INVALID' });
    const [body, mac] = t.split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), t: '0190d1a4-0000-7000-8000-00000000dead' })).toString('base64url');
    expect(verifyState(secret, `${forgedBody}.${mac}`, 1_000_000)).toEqual({ ok: false, code: 'STATE_INVALID' });
    fc.assert(
      fc.property(fc.nat({ max: t.length - 1 }), fc.constantFrom('A', 'b', '-', '_', '0'), (i, ch) => {
        if (t[i] === ch || t[i] === '.') return;
        const m = t.slice(0, i) + ch + t.slice(i + 1);
        expect(verifyState(secret, m, 1_000_000).ok).toBe(false);
      }),
      { numRuns: 500 },
    );
    for (const junk of ['', '.', 'a.b', `${body}.`, `.${mac}`, `${body}.${mac}x`]) expect(verifyState(secret, junk, 1_000_000).ok).toBe(false);
  });

  it('PKCE verifier is derived per flow, 43 chars, S256 challenge; it is never in the state', () => {
    const v = pkceVerifier(secret, base);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceVerifier(secret, { ...base, nonce: 'other' })).not.toBe(v);
    expect(pkceVerifier(other, base)).not.toBe(v);
    expect(signState(secret, base)).not.toContain(v);
    expect(pkceChallengeOf(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
