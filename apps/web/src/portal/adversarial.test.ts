// module 46 adversarial cases (critical module; R-PORTALWEB-1…9; E702, E703, E708, E713, E714, E715): a hostile
// link, query, stream answer, file name, contact or body never gets the portal to post, fetch, link or render what it
// must not.
import { describe, expect, it, vi } from 'vitest';
import { isPortalPath, portalApi } from './api.js';
import { FILE_URL_RE, downloadDocument, safeFileName } from './download.js';
import { classifyHash, readLink, resetLinkForTests, teamFromSearch } from './link.js';
import * as F from './test/fixtures.js';
import { portalContractFetch } from './test/portalContract.js';
import { ParseError, mailtoHref, parseMe, parseTimeline, smsHref } from './view/index.js';

describe('adversarial (module 46)', () => {
  it('E702: #token=…&next=//evil is incomplete; nothing navigates, nothing is kept', () => {
    resetLinkForTests();
    const h = { state: null, replaceState: vi.fn() };
    const r = readLink({ pathname: '/portal.html', search: '?team=harbor', hash: `#token=${F.TOKEN}&next=//evil.example.test` }, h, null);
    expect(r.link).toBe('incomplete');
    expect(h.replaceState).toHaveBeenCalledWith(null, '', '/portal.html?team=harbor');
    expect(classifyHash(`#next=//evil.example.test#token=${F.TOKEN}`).kind).toBe('incomplete');
    resetLinkForTests();
  });

  it('a team slug cannot carry a path, a query or a script', () => {
    for (const q of ['?team=../../api', '?team=harbor%26x%3D1', '?team=<script>', '?team=harbor/evil', '?team=%E2%80%AEharbor']) expect(teamFromSearch(q).slug, q).toBeNull();
  });

  it('a foreign or non-UUID ?grant= is ignored by the parser path (the client only opens ids /me listed)', () => {
    // Home picks the grant from /me only; the parsers refuse a non-UUID id from the API itself
    expect(() => parseTimeline({ ...F.timeline(), grantId: "' OR 1=1 --" })).toThrow(ParseError);
    expect(() => parseMe(F.me([{ ...F.grant(), id: '../../me' }]))).toThrow(ParseError);
  });

  it('E714: off-origin, protocol-relative, dot-segment or encoded stream URLs are refused, and the API refuses any non-portal path', async () => {
    for (const u of ['https://evil.example.test/api/portal/files/' + 'a'.repeat(43), '//evil.example.test/api/portal/files/' + 'a'.repeat(43), '/api/portal/files/../me' + 'a'.repeat(36), '/api/portal/files/%2e%2e' + 'a'.repeat(37), '/api/portal/files/' + 'a'.repeat(43) + '#x', '/API/portal/files/' + 'a'.repeat(43)]) {
      expect(FILE_URL_RE.test(u), u).toBe(false);
      const fetchSpy = vi.fn(portalContractFetch((x) => (x.key.includes('stream-token') ? { status: 200, body: F.streamToken({ url: u }) } : { status: 500, body: undefined })));
      const api = portalApi(fetchSpy);
      api.setCsrf(F.CSRF);
      const saved: string[] = [];
      expect(await downloadDocument(api, F.DOC_1, async () => undefined, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined, clickDownload: (_h, n) => saved.push(n), later: (fn) => fn() })).toEqual({ ok: false, reason: 'unavailable' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(saved).toEqual([]);
    }
    for (const p of ['/api/portal/../auth/session', '/api/portal/%2E%2E/me', '/api/portal/me\\..\\x', '/api/portalx/me', 'http:/api/portal/me']) expect(isPortalPath(p), p).toBe(false);
  });

  it('a hostile item id never leaves the stream-token path segment', async () => {
    const seen: string[] = [];
    const api = portalApi(async (u) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', requestId: 'r' } }), { status: 404 });
    });
    api.setCsrf(F.CSRF);
    // the id is encoded into one segment ("..%2F..%2Flogout"), which the client API then refuses outright
    expect(await downloadDocument(api, '../../logout', async () => undefined, { createObjectURL: () => '', revokeObjectURL: () => undefined, clickDownload: () => undefined, later: () => undefined })).toEqual({ ok: false, reason: 'unavailable' });
    expect(seen).toEqual([]);
  });

  it('E713: ../../x, CRLF and bidi file names are only names', () => {
    expect(safeFileName('../../x')).toBe('x');
    expect(safeFileName('a\r\nContent-Type: text/html')).toBe('html');
    expect(safeFileName('a\r\nContent-Type: x.pdf')).toBe('aContent-Type_ x.pdf');
    expect(safeFileName('‮fdp.exe')).toBe('fdp.exe');
  });

  it('E715: contacts carrying a scheme or parameters give no link', () => {
    for (const v of ['tel:+15555550123', 'sms:+15555550123', 'data:text/html,x', 'javascript:alert(1)//@example.test']) {
      expect(smsHref(v), v).toBeNull();
      expect(mailtoHref(v), v).toBeNull();
    }
  });

  it('E708: huge JSON is refused by the parsers, not rendered', () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...F.timeline().items[0], itemId: `01900000-0000-7000-8000-${String(i).padStart(12, '0')}` }));
    expect(() => parseTimeline({ ...F.timeline(), items: many })).toThrow(ParseError);
    expect(() => parseMe(F.me(Array.from({ length: 201 }, () => F.grant())))).toThrow(ParseError);
    expect(() => parseTimeline({ ...F.timeline(), items: [{ ...F.timeline().items[0], title: 'x'.repeat(201) }] })).toThrow(ParseError);
  });
});
