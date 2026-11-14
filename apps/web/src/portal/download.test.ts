// module 46 (R-PORTALWEB-7; E649, E693, E694, E696): downloads through 45's re-checked stream only.
import { describe, expect, it, vi } from 'vitest';
import { portalApi } from './api.js';
import { type SaveDeps, downloadDocument, essence, safeFileName } from './download.js';
import * as F from './test/fixtures.js';
import { type PortalAnswer, type PortalExchange, portalApiError, portalContractFetch } from './test/portalContract.js';

function harness(o: { token?: () => PortalAnswer; file?: () => Response; me?: () => PortalAnswer } = {}) {
  const seen: PortalExchange[] = [];
  const problems: string[] = [];
  const fetchSpy = vi.fn(
    portalContractFetch(
      (x) => {
        if (x.key === 'POST /portal/documents/:itemId/stream-token') return o.token ? o.token() : { status: 200, body: F.streamToken() };
        if (x.key === 'GET /portal/files/:token') return { status: 200, raw: o.file ? o.file() : new Response(F.PDF, { headers: { 'content-type': 'application/pdf', 'content-length': '8' } }) };
        if (x.key === 'GET /portal/me') return o.me ? o.me() : { status: 200, body: F.me() };
        throw new Error(`unexpected ${x.key}`);
      },
      seen,
      problems,
    ),
  );
  const api = portalApi(fetchSpy);
  api.setCsrf(F.CSRF);
  const saved: { href: string; name: string }[] = [];
  const revoked: string[] = [];
  const save: SaveDeps = { createObjectURL: () => 'blob:portal-1', revokeObjectURL: (u) => revoked.push(u), clickDownload: (href, name) => saved.push({ href, name }), later: (fn) => fn() };
  return { api, seen, problems, saved, revoked, save, fetchSpy };
}

describe('download.ts (R-PORTALWEB-7)', () => {
  it('R-PORTALWEB-7: one tap asks one stream token (CSRF) and fetches the one file it names; the bytes are saved and the object URL revoked', async () => {
    const h = harness();
    expect(h.fetchSpy).not.toHaveBeenCalled(); // nothing on render: only the call below fetches
    const r = await downloadDocument(h.api, F.DOC_1, async () => undefined, h.save);
    expect(r).toEqual({ ok: true, fileName: 'Purchase contract.pdf', bytes: 8 });
    expect(h.seen.map((x) => x.key)).toEqual(['POST /portal/documents/:itemId/stream-token', 'GET /portal/files/:token']);
    expect(h.seen[0]!.headers['x-csrf-token']).toBe(F.CSRF);
    expect(h.saved).toEqual([{ href: 'blob:portal-1', name: 'Purchase contract.pdf' }]);
    expect(h.revoked).toEqual(['blob:portal-1']);
    expect(h.problems).toEqual([]);
  });

  it('E694: a stream URL other than /api/portal/files/<43 characters> is refused and nothing is fetched', async () => {
    for (const url of ['https://evil.example.test/api/portal/files/' + 'a'.repeat(43), '//evil.example.test/x', '/api/portal/files/' + 'a'.repeat(42), '/api/portal/files/../../me', '/api/files/' + 'a'.repeat(43), '/api/portal/files/' + 'a'.repeat(43) + '?x=1', 'javascript:alert(1)']) {
      const h = harness({ token: () => ({ status: 200, body: F.streamToken({ url }) }) });
      expect(await downloadDocument(h.api, F.DOC_1, async () => undefined, h.save), url).toEqual({ ok: false, reason: 'unavailable' });
      expect(h.seen.map((x) => x.key), url).toEqual(['POST /portal/documents/:itemId/stream-token']);
      expect(h.saved).toEqual([]);
    }
  });

  it('E693: a 404, a 500, a wrong type, a short or long body, a larger Content-Length or a network cut saves nothing', async () => {
    const pdf = (body: BodyInit | null, headers: Record<string, string>, status = 200) => () => new Response(body, { status, headers });
    const cases: [string, () => Response][] = [
      ['404', () => new Response(JSON.stringify(portalApiError('NOT_FOUND').body), { status: 404 })],
      ['500', pdf(F.PDF, { 'content-type': 'application/pdf' }, 500)],
      ['wrong type', pdf(F.PDF, { 'content-type': 'text/html' })],
      ['no type', pdf(F.PDF, {})],
      ['short', pdf(F.PDF.slice(0, 7), { 'content-type': 'application/pdf' })],
      ['long', pdf(new Uint8Array(9), { 'content-type': 'application/pdf' })],
      ['larger content-length', pdf(F.PDF, { 'content-type': 'application/pdf', 'content-length': '9000' })],
    ];
    for (const [what, file] of cases) {
      const h = harness({ file });
      expect(await downloadDocument(h.api, F.DOC_1, async () => undefined, h.save), what).toEqual({ ok: false, reason: 'unavailable' });
      expect(h.saved, what).toEqual([]);
    }
    const h404 = harness({ token: () => portalApiError('NOT_FOUND') });
    expect(await downloadDocument(h404.api, F.DOC_1, async () => undefined, h404.save)).toEqual({ ok: false, reason: 'unavailable' });
    const cut = harness();
    const api = portalApi(async (u, i) => (String(u).includes('/files/') ? Promise.reject(new TypeError('network')) : cut.fetchSpy(u, i)));
    api.setCsrf(F.CSRF);
    expect(await downloadDocument(api, F.DOC_1, async () => undefined, cut.save)).toEqual({ ok: false, reason: 'unavailable' });
    expect(cut.saved).toEqual([]);
  });

  it('a type with parameters matches by its essence', async () => {
    const h = harness({ file: () => new Response(F.PDF, { headers: { 'content-type': 'Application/PDF; charset=binary' } }) });
    expect((await downloadDocument(h.api, F.DOC_1, async () => undefined, h.save)).ok).toBe(true);
    expect(essence('application/pdf; x=y')).toBe('application/pdf');
  });

  it('E696: CSRF_INVALID refetches /me and retries once; a second CSRF_INVALID is reported; a session 401 is "session"', async () => {
    let n = 0;
    const h = harness({ token: () => (n++ === 0 ? portalApiError('CSRF_INVALID') : { status: 200, body: F.streamToken() }) });
    const refresh = vi.fn(async () => undefined);
    expect((await downloadDocument(h.api, F.DOC_1, refresh, h.save)).ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const twice = harness({ token: () => portalApiError('CSRF_INVALID') });
    expect(await downloadDocument(twice.api, F.DOC_1, async () => undefined, twice.save)).toEqual({ ok: false, reason: 'csrf' });
    expect(twice.seen.filter((x) => x.key.includes('stream-token'))).toHaveLength(2);
    const out = harness({ token: () => portalApiError('PORTAL_SESSION_REQUIRED') });
    expect(await downloadDocument(out.api, F.DOC_1, async () => undefined, out.save)).toEqual({ ok: false, reason: 'session' });
  });

  it('the file name is only a name: no path, control, reserved character or leading dot', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\x.pdf')).toBe('x.pdf');
    expect(safeFileName('a\r\nb.pdf')).toBe('ab.pdf');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('a<b>:"c|?*.pdf')).toBe('a_b___c___.pdf');
    expect(safeFileName('re‮port.pdf')).toBe('report.pdf');
    expect(safeFileName('')).toBe('document');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });
});
