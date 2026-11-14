/// <reference types="node" />
// module 46: module 45's contract (apps/api/src/portal/shared/webContract.json, generated from the API's own Zod
// schemas and kept current by webContract.test.ts there), read as data like module 22's (src/test/contract.ts). For
// constants the JSON does not carry, 45's shared/copy.ts is read as TEXT (never imported: apps/web does not depend on
// @realty/api). Only `violations` is reused from src/test/contract.ts.
//
// `portalContractFetch` plays the API by its contract for the portal's tests: a URL that is no contract route is 404;
// a request the API would refuse is 422 VALIDATION_FAILED and recorded in `problems`; and `answer` may only reply with
// what the API can send (a success body its response schema accepts at the route's status, or an error whose status
// is the contract's for its code), else the call throws, so a fake can never drift from the real API.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Schema, violations } from '../../test/contract.js';

export interface PortalRoute {
  side: 'signin' | 'client' | 'staff';
  status: number;
  inputKeys: string[];
  body: Schema | null;
  query: Schema | null;
  response: Schema | null;
}
export interface PortalContract {
  routes: Record<string, PortalRoute>;
  errors: Record<string, { status: number; sentence: string }>;
  signin: { page: string; tokenInFragment: string; teamInQuery: string; acceptedMessage: string; csrfHeader: string; session: { idleHours: number; absoluteDays: number } };
}

const here = dirname(fileURLToPath(import.meta.url));
export const PORTAL_CONTRACT_FILE = resolve(here, '../../../../api/src/portal/shared/webContract.json');
export const PORTAL_COPY_FILE = resolve(here, '../../../../api/src/portal/shared/copy.ts');
export const portalContract: PortalContract = JSON.parse(readFileSync(PORTAL_CONTRACT_FILE, 'utf8')) as PortalContract;
/** 45's copy.ts as text (for the sentences and constants the JSON does not carry). */
export const portalCopySource: string = readFileSync(PORTAL_COPY_FILE, 'utf8');

const PATTERNS = Object.keys(portalContract.routes)
  .map((key) => {
    const [m, pattern] = key.split(' ') as [string, string];
    return { key, m, re: new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`), params: (pattern.match(/:/g) ?? []).length };
  })
  .sort((a, b) => a.params - b.params);

/** The contract route of a concrete request ("GET", "/api/portal/timeline?grantId=x" → "GET /portal/timeline"). */
export function portalRouteFor(method: string, path: string): string | null {
  const p = path.replace(/^\/api(?=\/)/, '').split('?')[0]!;
  return PATTERNS.find((x) => x.m === method.toUpperCase() && x.re.test(p))?.key ?? null;
}

/** What the API would refuse in this request (422 VALIDATION_FAILED); [] when it accepts it. */
export function portalRequestViolations(key: string, body: unknown, query: Record<string, string>): string[] {
  const r = portalContract.routes[key];
  if (!r) return [`${key}: not a portal contract route`];
  const out: string[] = [];
  if (r.body) out.push(...violations(r.body, body).map((v) => `body ${v}`));
  else if (body !== undefined) out.push('body: this route takes none');
  if (r.query) out.push(...violations(r.query, query).map((v) => `query ${v}`));
  else if (Object.keys(query).length > 0) out.push('query: this route takes none');
  return out;
}

/** What in this success body the API could never send for the route; [] when it could. */
export function portalResponseViolations(key: string, body: unknown): string[] {
  const r = portalContract.routes[key];
  if (!r) return [`${key}: not a portal contract route`];
  if (r.response === null) return body === undefined ? [] : ['this route answers no JSON body'];
  return violations(r.response, body);
}

export interface PortalExchange {
  key: string;
  method: string;
  url: URL;
  body: unknown;
  query: Record<string, string>;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

export interface PortalAnswer {
  status: number;
  body?: unknown;
  /** a raw response (GET /portal/files/:token: the bytes) */
  raw?: Response;
}

/** An error exactly as the API sends it: the contract's status for the code, `{error: {code, requestId, details?}}`. */
export function portalApiError(code: string, details?: Record<string, unknown>): { status: number; body: { error: { code: string; requestId: string; details?: Record<string, unknown> } } } {
  const status = portalContract.errors[code]?.status;
  if (status === undefined) throw new Error(`${code} is not an error code of the portal contract`);
  return { status, body: { error: { code, requestId: '01900000-0000-7000-8000-0000000000ee', ...(details ? { details } : {}) } } };
}

const headersOf = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
};

/** A fetch that plays module 45 by its contract (see the file comment). */
export function portalContractFetch(
  answer: (x: PortalExchange) => PortalAnswer | Promise<PortalAnswer>,
  seen: PortalExchange[] = [],
  problems: string[] = [],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(input, 'https://app.example.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const key = portalRouteFor(method, url.pathname);
    const reply = (a: PortalAnswer) => a.raw ?? new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: a.body === undefined ? {} : { 'content-type': 'application/json' } });
    if (!key || !url.pathname.startsWith('/api/')) {
      problems.push(`${method} ${url.pathname}: not a portal contract route`);
      return reply(portalApiError('NOT_FOUND'));
    }
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const query = Object.fromEntries(url.searchParams);
    const x: PortalExchange = { key, method, url, body, query, headers: headersOf(init.headers), credentials: init.credentials };
    seen.push(x);
    const bad = portalRequestViolations(key, body, query);
    if (bad.length > 0) {
      problems.push(...bad.map((b) => `${key} ${b}`));
      return reply(portalApiError('VALIDATION_FAILED', { issues: bad.map((b) => ({ path: b.split(' ')[1]!.replace(/:$/, ''), code: 'invalid' })) }));
    }
    const a = await answer(x);
    const route = portalContract.routes[key]!;
    if (a.status < 400) {
      if (a.status !== route.status) throw new Error(`the fake answered ${key} with ${a.status}; the API answers ${route.status}`);
      if (!a.raw) {
        const wrong = portalResponseViolations(key, a.body);
        if (wrong.length > 0) throw new Error(`the fake answered ${key} with a body the API never sends: ${wrong.join('; ')}`);
      }
    } else if (!a.raw || a.status !== 404) {
      const code = (a.body as { error?: { code?: unknown } } | undefined)?.error?.code;
      if (typeof code !== 'string' || portalContract.errors[code]?.status !== a.status) throw new Error(`the fake answered ${key} with ${a.status} ${String(code)}, which is not how the API answers that code`);
    }
    return reply(a);
  };
}

/** The sentence 45 gives a code (webContract.json). */
export const contractSentence = (code: string): string => {
  const s = portalContract.errors[code]?.sentence;
  if (s === undefined) throw new Error(`${code} has no sentence in the portal contract`);
  return s;
};

/** A string constant of 45's copy.ts, read from its source text (`export const NAME = '…';`). */
export function copyConstant(name: string): string {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(portalCopySource);
  if (!m) throw new Error(`${name} is not a string constant of 45's copy.ts`);
  return m[1]!.replace(/\\'/g, "'");
}

/** One NOT_VISIBLE / CHANNEL_WORDS style entry of 45's copy.ts: `KEY: '…'` inside the named object. */
export function copyEntry(object: string, key: string): string {
  const start = portalCopySource.indexOf(`export const ${object} =`);
  if (start < 0) throw new Error(`${object} is not in 45's copy.ts`);
  const end = portalCopySource.indexOf('} as const', start);
  const block = portalCopySource.slice(start, end);
  const m = new RegExp(`\\b${key}:\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`).exec(block);
  if (!m) throw new Error(`${object}.${key} is not in 45's copy.ts`);
  return m[2]!.replace(/\\'/g, "'");
}
