// @vitest-environment node
// module 46 (R-PORTALWEB-4, R-PORTALWEB-9): the portal client against module 45's contract, as data. Every route the
// portal calls is a contract route and its requests satisfy the route's request schema; the fixtures the tests answer
// with are bodies the API can send; each code the portal meets has the contract's status; 45's sentences and the
// link, team and token constants equal 45's (webContract.json, shared/copy.ts as text, the migrations as text).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noBody, portalApi } from './api.js';
import { API_SENTENCES, CSRF_HEADER, LINK_TOKEN_RE, PORTAL_PAGE, TEAM_IN_QUERY, TEAM_SLUG_RE, TOKEN_IN_FRAGMENT } from './copy.js';
import { downloadDocument } from './download.js';
import * as F from './test/fixtures.js';
import { type PortalExchange, contractSentence, copyConstant, portalApiError, portalContract, portalContractFetch, portalResponseViolations, portalRouteFor } from './test/portalContract.js';
import { parseDocuments, parseLoginAccepted, parseMe, parseSession, parseTimeline } from './view/index.js';

const here = __dirname;
const repo = resolve(here, '../../../..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'test' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

/** Every "METHOD /api/portal/…" the portal source calls (api.request and the file fetch). */
function calledRoutes(): string[] {
  const out = new Set<string>();
  for (const f of sourceFiles(here)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/request\(\s*'(GET|POST)',\s*[`'"](\/api\/portal\/[^`'"?$]*)(?:\$\{[^}]*\}([^`'"?]*))?/g)) {
      // a template value in a path segment stands for one segment; after the path it is the query
      const path = m[2]!.endsWith('/') ? m[2]! + 'x' + (m[3] ?? '') : m[2]!;
      const key = portalRouteFor(m[1]!, path);
      out.add(key ?? `${m[1]} ${path} (NOT IN THE CONTRACT)`);
    }
  }
  if (/fetchFile\(/.test(readFileSync(join(here, 'download.ts'), 'utf8'))) out.add('GET /portal/files/:token');
  return [...out].sort();
}

describe('the portal client and module 45 contract (R-PORTALWEB-9)', () => {
  it('R-PORTALWEB-9: every route the portal calls is a client or sign-in route of the contract; it calls no staff route', () => {
    const called = calledRoutes();
    expect(called).toEqual(
      ['GET /portal/documents', 'GET /portal/files/:token', 'GET /portal/me', 'GET /portal/timeline', 'POST /portal/documents/:itemId/stream-token', 'POST /portal/login', 'POST /portal/logout', 'POST /portal/session'].sort(),
    );
    for (const k of called) expect(['client', 'signin'], k).toContain(portalContract.routes[k]!.side);
  });

  it('R-PORTALWEB-9: the requests the client sends satisfy the contract, and the fixtures are answers the API can send', async () => {
    const seen: PortalExchange[] = [];
    const problems: string[] = [];
    const answers: Record<string, () => { status: number; body?: unknown; raw?: Response }> = {
      'POST /portal/login': () => ({ status: 202, body: F.accepted() }),
      'POST /portal/session': () => ({ status: 200, body: F.session() }),
      'GET /portal/me': () => ({ status: 200, body: F.me([F.grant(), F.grant({ id: F.GRANT_2, title: 'Your home sale', scope: 'sale', expiresOn: '2027-03-01', contact: null })]) }),
      'POST /portal/logout': () => ({ status: 204 }),
      'GET /portal/timeline': () => ({ status: 200, body: F.timeline() }),
      'GET /portal/documents': () => ({ status: 200, body: F.documents() }),
      'POST /portal/documents/:itemId/stream-token': () => ({ status: 200, body: F.streamToken() }),
      'GET /portal/files/:token': () => ({ status: 200, raw: new Response(F.PDF, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '8' } }) }),
    };
    const api = portalApi(portalContractFetch((x) => answers[x.key]!(), seen, problems));
    await api.request('POST', '/api/portal/login', parseLoginAccepted, { team: 'harbor', address: 'jane@example.test' });
    const s = await api.request('POST', '/api/portal/session', parseSession, { token: F.TOKEN });
    api.setCsrf(s.csrfToken);
    await api.request('GET', '/api/portal/me', parseMe);
    await api.request('GET', `/api/portal/timeline?grantId=${F.GRANT_ID}`, parseTimeline);
    await api.request('GET', `/api/portal/documents?grantId=${F.GRANT_ID}`, parseDocuments);
    const saved: string[] = [];
    const r = await downloadDocument(api, F.DOC_1, async () => undefined, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined, clickDownload: (_h, n) => saved.push(n), later: (fn) => fn() });
    expect(r).toEqual({ ok: true, fileName: 'Purchase contract.pdf', bytes: 8 });
    await api.request('POST', '/api/portal/logout', noBody);
    expect(problems).toEqual([]);
    expect(seen.map((x) => x.key)).toEqual(['POST /portal/login', 'POST /portal/session', 'GET /portal/me', 'GET /portal/timeline', 'GET /portal/documents', 'POST /portal/documents/:itemId/stream-token', 'GET /portal/files/:token', 'POST /portal/logout']);
    for (const x of seen) expect(x.credentials, x.key).toBe('same-origin');
    expect(seen.filter((x) => x.method === 'POST' && portalContract.routes[x.key]!.side === 'client').every((x) => x.headers[CSRF_HEADER] === F.CSRF)).toBe(true);
    expect(seen.filter((x) => portalContract.routes[x.key]!.side === 'signin').every((x) => x.headers[CSRF_HEADER] === undefined)).toBe(true);
    // the fixtures every portal test answers with are bodies the API can send
    expect(portalResponseViolations('GET /portal/timeline', F.timeline())).toEqual([]);
    expect(portalResponseViolations('GET /portal/me', F.me([]))).toEqual([]);
  });

  it('the fake refuses what the API would never send (a wrong body, a wrong status for a code)', async () => {
    const f = portalContractFetch(() => ({ status: 200, body: { ...F.me(), notes: 'internal' } }));
    await expect(f('/api/portal/me')).rejects.toThrow(/never sends/);
    const g = portalContractFetch(() => ({ status: 404, body: portalApiError('PORTAL_LINK_INVALID').body }));
    await expect(g('/api/portal/session', { method: 'POST', body: JSON.stringify({ token: F.TOKEN }) })).rejects.toThrow(/not how the API answers/);
    const problems: string[] = [];
    const h = portalContractFetch(() => ({ status: 202, body: F.accepted() }), [], problems);
    await h('/api/portal/login', { method: 'POST', body: JSON.stringify({ team: 'harbor', address: 'x@example.test', extra: 1 }) });
    expect(problems.join()).toMatch(/extra: not allowed/);
  });

  it('R-PORTALWEB-4: each code the portal meets has the contract status it handles', () => {
    const want: Record<string, number> = {
      PORTAL_NOT_AVAILABLE: 503,
      PORTAL_LINK_INVALID: 401,
      PORTAL_SESSION_REQUIRED: 401,
      RATE_LIMITED: 429,
      PAYLOAD_TOO_LARGE: 413,
      VALIDATION_FAILED: 422,
      EMAIL_INVALID: 422,
      PHONE_INVALID: 422,
      CSRF_INVALID: 403,
      NOT_FOUND: 404,
    };
    for (const [code, status] of Object.entries(want)) expect(portalContract.errors[code]?.status, code).toBe(status);
  });

  it("R-PORTALWEB-4: 45's sentences are verbatim (webContract.json and shared/copy.ts)", () => {
    expect(API_SENTENCES.SIGNIN_ACCEPTED).toBe(portalContract.signin.acceptedMessage);
    expect(API_SENTENCES.SIGNIN_ACCEPTED).toBe(copyConstant('SIGNIN_ACCEPTED'));
    for (const [code, sentence] of Object.entries(API_SENTENCES)) if (code !== 'SIGNIN_ACCEPTED') expect(sentence, code).toBe(contractSentence(code));
  });

  it("the link, team, CSRF and token constants equal 45's and the database's", () => {
    expect(PORTAL_PAGE).toBe(portalContract.signin.page);
    expect(PORTAL_PAGE).toBe(copyConstant('PORTAL_PAGE'));
    expect(TOKEN_IN_FRAGMENT).toBe(portalContract.signin.tokenInFragment);
    expect(TEAM_IN_QUERY).toBe(portalContract.signin.teamInQuery);
    expect(CSRF_HEADER).toBe(portalContract.signin.csrfHeader);
    const sessionBody = portalContract.routes['POST /portal/session']!.body as { properties: { token: { pattern: string } } };
    expect(LINK_TOKEN_RE.source).toBe(sessionBody.properties.token.pattern);
    // 32 random bytes, base64url: 43 characters (packages/db portalTx.ts)
    expect(readFileSync(resolve(repo, 'packages/db/src/portalTx.ts'), 'utf8')).toContain("randomBytes(32).toString('base64url')");
    expect(Buffer.alloc(32).toString('base64url')).toHaveLength(43);
    // the tenants slug pattern (0001_init.sql), a subset of what POST /portal/login accepts
    expect(readFileSync(resolve(repo, 'packages/db/migrations/0001_init.sql'), 'utf8')).toContain(`slug ~ '${TEAM_SLUG_RE.source}'`);
    const team = (portalContract.routes['POST /portal/login']!.body as { properties: { team: { pattern: string } } }).properties.team.pattern;
    for (const s of ['harbor', 'a1', 'north-shore-team']) expect(new RegExp(team).test(s), s).toBe(true);
    // the link carries no team (45: portalLinkUrl), the invite notice names ?team= (portalSignInUrl)
    expect(portalCopySourceHas('`${webOrigin}${PORTAL_PAGE}#token=${token}`')).toBe(true);
    expect(portalCopySourceHas('`${webOrigin}${PORTAL_PAGE}?team=${encodeURIComponent(slug)}`')).toBe(true);
  });
});

import { portalCopySource } from './test/portalContract.js';
const portalCopySourceHas = (s: string) => portalCopySource.includes(s);
