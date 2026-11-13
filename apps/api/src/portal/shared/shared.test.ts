// Pure parts of module 45: file names, the copy table, the grant display copy, the portal CSRF derivation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csrfTokenFor } from '../../auth/tokens.js';
import { downloadNames } from '../../documents/read.js';
import { ERROR_STATUS } from '../../errors.js';
import { renderSealedLink } from '../../comms/dispatch.js';
import { CODE_SENTENCES, inviteBody, linkLine } from './copy.js';
import { attachmentDisposition, portalFileNames } from './fileNames.js';
import { portalCsrfToken, portalCsrfValid } from './session.js';
import { displayOf, grantView, timelineView } from './view.js';

const SECRET = new Uint8Array(32).fill(7);

describe('R-PORTAL-17 file names', () => {
  it('R-PORTAL-17: the portal file names equal module 42\'s staff download names on a corpus (fast-check)', () => {
    const corpus = ['Purchase contract.pdf', 'Inspection', 'Überweisung.PDF', 'photo.jpeg', 'scan.png', '', '   ', '"quoted";name%.pdf', 'a\\b.pdf', 'line\r\nSet-Cookie: x=1', '🏠 home.pdf'];
    for (const n of corpus) for (const t of ['application/pdf', 'image/jpeg', 'image/png', 'text/plain']) expect(portalFileNames(n, t), `${n} ${t}`).toEqual(downloadNames(n, t));
    fc.assert(fc.property(fc.string({ maxLength: 60 }), fc.constantFrom('application/pdf', 'image/jpeg', 'image/png'), (n, t) => {
      expect(portalFileNames(n, t)).toEqual(downloadNames(n, t));
    }), { numRuns: 2000 });
  });

  it('R-PORTAL-17: a display name can never inject a header or a second parameter (control characters, quotes, semicolons)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (n) => {
        const d = attachmentDisposition(n, 'application/pdf');
        expect(d).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%\-_.!~*'()]*$/);
        expect(d.match(/"/g)!.length).toBe(2);
        expect(d).not.toMatch(/[\r\n\0]/);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('honest copy (R-PORTAL-10, R-PORTAL-11, R-PORTAL-13)', () => {
  it('R-PORTAL-10: every PORTAL_* error code has one sentence, and every sentence names a real code', () => {
    const portalCodes = Object.keys(ERROR_STATUS).filter((c) => c.startsWith('PORTAL_'));
    for (const c of portalCodes) expect((CODE_SENTENCES as Record<string, string>)[c], c).toMatch(/\.$/);
    for (const c of Object.keys(CODE_SENTENCES)) expect(Object.hasOwn(ERROR_STATUS, c) || c === 'PORTAL_PERSON_ONLY' || c === 'PORTAL_RULE_MILESTONES_ONLY', c).toBe(true);
  });

  it('R-PORTAL-11 E683 (b14 F2): the stored line names whose portal it opens and holds no link; the client gets the line with the link rendered after it', () => {
    const url = 'https://app.example.test/portal.html#token=AAAA';
    const sms = linkLine({ brokerage: 'Sample Realty', name: 'Jane', channel: 'sms' });
    expect(sms).toBe("Sample Realty: sign-in link for Jane's client portal. It works once, for 15 minutes; if you did not ask for it, ignore this text. Sign in here (the link itself is not kept in the message history):");
    const mail = linkLine({ brokerage: 'Sample Realty', name: 'Jane', channel: 'email' });
    expect(mail).toContain('ignore this message.');
    for (const l of [sms, mail]) expect(l).not.toMatch(/token|portal\.html|https?:/);
    expect(renderSealedLink(sms, url, 'sms')).toBe(`${sms} ${url}`);
    expect(renderSealedLink(mail, url, 'email')).toBe(`${mail}\n\n${url}`);
  });

  it('R-PORTAL-13: the invite notice names the page and the sign-in address kind, never a token', () => {
    const t = inviteBody({ agent: 'Sam Agent', scope: 'sale', url: 'https://app.example.test/portal.html?team=t-1', kind: 'phone' });
    expect(t).toBe('Sam Agent invited you to follow your sale online. Sign in at https://app.example.test/portal.html?team=t-1 with this phone number.');
    expect(t).not.toMatch(/#token=/);
  });
});

describe('R-PORTAL-18 the grant display copy', () => {
  it('R-PORTAL-18: only allowlisted keys and well-formed values survive; a personal phone key never reaches the client', () => {
    expect(displayOf({ title: 'Our home', scope: 'sale', agentName: 'Sam', textTo: '+14155550100', emailTo: 'r+x@in.example.test', personalCell: '+14155550199' })).toEqual({ title: 'Our home', scope: 'sale', agentName: 'Sam', textTo: '+14155550100', emailTo: 'r+x@in.example.test' });
    expect(displayOf({ title: 'a\u0007b', scope: 'rental', textTo: '555', emailTo: 'nope' })).toEqual({});
    expect(displayOf(null)).toEqual({});
    expect(displayOf([1])).toEqual({});
    expect(grantView({ id: 'g', display: { scope: 'purchase' }, expiresAt: new Date('2031-01-02T03:04:05Z') })).toEqual({ id: 'g', scope: 'purchase', title: 'Your home purchase', contact: null, expiresOn: '2031-01-02' });
  });

  it('R-PORTAL-16: the timeline orders by date then publication and keeps next steps apart; documents are not on it', () => {
    const at = (s: string) => new Date(s);
    const rows = [
      { id: '3', grantId: 'g', kind: 'next_step' as const, title: 'Sign', body: null, occursOn: '2031-01-01', publishedAt: at('2030-01-01T00:00:00Z') },
      { id: '2', grantId: 'g', kind: 'milestone' as const, title: 'B', body: null, occursOn: null, publishedAt: at('2030-01-01T00:00:00Z') },
      { id: '1', grantId: 'g', kind: 'milestone' as const, title: 'A', body: null, occursOn: '2031-02-01', publishedAt: at('2030-01-02T00:00:00Z') },
      { id: '4', grantId: 'g', kind: 'document' as const, title: 'Doc', body: null, occursOn: null, publishedAt: at('2030-01-01T00:00:00Z') },
    ];
    const v = timelineView(rows);
    expect(v.items.map((i) => i.itemId)).toEqual(['1', '2']);
    expect(v.nextSteps.map((i) => i.itemId)).toEqual(['3']);
  });
});

describe('R-PORTAL-9 the portal CSRF token', () => {
  it('E687 R-PORTAL-9: derived under a portal-only key: the staff token for the same id never validates; a portal token validates only for its session', () => {
    const sid = '01a1d527-588b-713f-914b-8241c9cbd2ba';
    const t = portalCsrfToken(SECRET, sid);
    expect(portalCsrfValid(SECRET, sid, t)).toBe(true);
    expect(portalCsrfValid(SECRET, sid, csrfTokenFor(SECRET, sid))).toBe(false);
    expect(portalCsrfValid(SECRET, '01a1d527-588b-713f-914b-8241c9cbd2bb', t)).toBe(false);
    expect(portalCsrfValid(SECRET, sid, undefined)).toBe(false);
    expect(portalCsrfValid(SECRET, sid, 'x'.repeat(500))).toBe(false);
    expect(t).not.toBe(csrfTokenFor(SECRET, sid));
  });
});
