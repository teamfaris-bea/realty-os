// b18 item a (Q-PORTAL-16): the pure redactor of quoted sign-in token values. Synthetic tokens only.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { portalLinkUrl } from './copy.js';
import { SIGNIN_TOKEN_HIDDEN, SIGNIN_TOKEN_PLACEHOLDER, hideForDisplay, redactNullable, redactSignInTokens } from './redact.js';

const token = () => randomBytes(32).toString('base64url');
const origin = 'https://app.realty-os.invalid';

describe('R-PORTAL-20 redactSignInTokens', () => {
  it('R-PORTAL-20: removes the value of the link portalLinkUrl builds, keeps the rest of the text and the link recognisable', () => {
    const t = token();
    const r = redactSignInTokens(`Thanks! > Sign in here: ${portalLinkUrl(origin, t)}\n> See you`);
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain(t);
    expect(r.text).toBe(`Thanks! > Sign in here: ${origin}/portal.html#token=${SIGNIN_TOKEN_PLACEHOLDER}\n> See you`);
  });

  it('R-PORTAL-20: every encoding of # and = a mail client, a link wrapper or an HTML body uses, and several links in one text', () => {
    const forms = (t: string) => [
      `${origin}/portal.html#token=${t}`,
      `${origin}/portal.html%23token%3D${t}`,
      `https://wrapper.example/?url=https%3A%2F%2Fapp.realty-os.invalid%2Fportal.html%2523token%253D${t}&data=x`,
      `${origin}/portal.html&#35;token&#61;${t}`,
      `${origin}/portal.html&#x23;token=${t}`,
      `${origin}/portal.html&num;token&equals;${t}`,
      `${origin}/portal.html#TOKEN=${t}`,
    ];
    for (const f of forms('VALUE')) {
      const t = token();
      const r = redactSignInTokens(`a ${f.replace('VALUE', t)} b`);
      expect(r.removed, f).toBe(1);
      expect(r.text, f).not.toContain(t);
      expect(r.text, f).toContain(SIGNIN_TOKEN_PLACEHOLDER);
    }
    const [a, b] = [token(), token()];
    const both = redactSignInTokens(`${portalLinkUrl(origin, a)} and again ${portalLinkUrl(origin, b)}`);
    expect(both.removed).toBe(2);
    expect(both.text).not.toContain(a);
    expect(both.text).not.toContain(b);
  });

  it('R-PORTAL-20: a text with no token is returned unchanged (same string), and null stays null', () => {
    for (const s of ['', 'STOP', 'Sign in at https://app.realty-os.invalid/portal.html?team=acme', 'token=abc without a hash', '#tokens=abc']) {
      const r = redactSignInTokens(s);
      expect(r).toEqual({ text: s, removed: 0 });
    }
    expect(redactNullable(null)).toEqual({ text: null, removed: 0 });
    expect(redactNullable(`x ${portalLinkUrl(origin, token())}`).removed).toBe(1);
  });

  it('R-PORTAL-20: the opt-out words around a quoted link survive the redaction', () => {
    const r = redactSignInTokens(`STOP ${portalLinkUrl(origin, token())}`);
    expect(r.text.startsWith('STOP ')).toBe(true);
  });
});

describe('R-PORTAL-20 hideForDisplay (b18 review F4)', () => {
  it('R-PORTAL-20 (b18 review F4): an older record read back for display says hidden, never removed; a value already removed at storage is not matched again; null stays null', () => {
    const t = token();
    const r = hideForDisplay(`Earlier: ${portalLinkUrl(origin, t)}`);
    expect(r.removed).toBe(1);
    expect(r.text).toBe(`Earlier: ${origin}/portal.html#token=${SIGNIN_TOKEN_HIDDEN}`);
    expect(r.text).not.toContain(SIGNIN_TOKEN_PLACEHOLDER);
    const stored = redactSignInTokens(`See ${portalLinkUrl(origin, token())}`).text;
    expect(hideForDisplay(stored)).toEqual({ text: stored, removed: 0 });
    expect(hideForDisplay(null)).toEqual({ text: null, removed: 0 });
  });
});
