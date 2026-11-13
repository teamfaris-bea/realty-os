/// <reference types="node" />
// The module 55 staff contract (apps/api/src/staffWeb/contract.json, generated from the API's Zod schemas and kept
// current by contract.test.ts there), read as data like module 22's contract (src/test/contract.ts).
//
// `StaffFake` is the FakeFetch the staff screens' tests use. Every request to a contract route is checked against what
// the API's validation accepts: a JSON body against the body schema (a commandId on a strict body fails), a query
// against the query schema (numbers coerced as Zod's z.coerce does), and a multipart form against the fields the
// route reads (documents/upload.ts refuses any other). Every answer the test scripts is checked too: a success body
// against the response schema, an error against the contract's status for its code. A request the API would refuse is
// answered 422 VALIDATION_FAILED, and any problem fails the test when it finishes (and `problems` lists them).
// Routes outside the contract (the session, the feed, a contact) pass through unchecked.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { FakeFetch, type Reply } from '../shell/testing/fakeApi.js';
import { type Schema, violations } from './contract.js';

export interface StaffRoute {
  inputKeys: string[];
  body: Schema | null;
  query: Schema | null;
  response: Schema;
  status: number;
  multipart: string[] | null;
}

export interface StaffContract {
  routes: Record<string, StaffRoute>;
  errors: Record<string, number>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const STAFF_CONTRACT_FILE = resolve(here, '../../../api/src/staffWeb/contract.json');
export const staffContract: StaffContract = JSON.parse(readFileSync(STAFF_CONTRACT_FILE, 'utf8')) as StaffContract;

const PATTERNS = Object.keys(staffContract.routes).map((key) => {
  const [m, pattern] = key.split(' ') as [string, string];
  // static segments first, as Fastify matches them (GET /documents/extractions before /documents/:id)
  return { key, m, re: new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`), params: (pattern.match(/:/g) ?? []).length };
}).sort((a, b) => a.params - b.params);

/** The contract route of a concrete request, or null when the contract does not cover it. */
export function staffRouteFor(method: string, path: string): string | null {
  const p = path.replace(/^\/api(?=\/)/, '').split('?')[0]!;
  return PATTERNS.find((x) => x.m === method.toUpperCase() && x.re.test(p))?.key ?? null;
}

/** Query values as Zod's z.coerce.number sees them (a query string carries only strings). */
function coerceQuery(schema: Schema | null, q: Record<string, string>): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, Schema>;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, props[k] && (props[k]!.type === 'integer' || props[k]!.type === 'number') && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v]));
}

/** What the API would refuse in this request; [] when it accepts it. */
export function staffRequestViolations(key: string, body: unknown, query: Record<string, string>): string[] {
  const r = staffContract.routes[key];
  if (!r) return [`${key}: not a staff contract route`];
  const out: string[] = [];
  if (r.multipart) {
    if (!(body instanceof FormData)) out.push('body: a multipart route takes a FormData');
    else {
      for (const k of new Set([...body.keys()])) if (!r.multipart.includes(k)) out.push(`form /${k}: not a field the route reads`);
      if (!body.has('file')) out.push('form /file: required');
      if (r.multipart.includes('kind') && !body.has('kind')) out.push('form /kind: required');
    }
  } else if (r.body) out.push(...violations(r.body, body).map((v) => `body ${v}`));
  else if (body !== undefined && !(body !== null && typeof body === 'object' && Object.keys(body).length === 0)) out.push('body: this route takes none');
  if (r.query) out.push(...violations(r.query, coerceQuery(r.query, query)).map((v) => `query ${v}`));
  else if (Object.keys(query).length > 0) out.push('query: this route takes none');
  return out;
}

/** What in this success body the API could never send for the route; [] when it could. */
export function staffResponseViolations(key: string, body: unknown): string[] {
  const r = staffContract.routes[key];
  return r ? violations(r.response, body) : [`${key}: not a staff contract route`];
}

/** An error exactly as the API sends it: the contract's status for the code. */
export function staffError(code: string, details?: Record<string, unknown>): Reply {
  const status = staffContract.errors[code];
  if (status === undefined) throw new Error(`${code} is not an error code of the staff contract`);
  return { status, body: { error: { code, requestId: '01900000-0000-7000-8000-0000000000ee', ...(details ? { details } : {}) } } };
}

/** A FakeFetch that plays the API by the staff contract (see the header). */
export class StaffFake extends FakeFetch {
  problems: string[] = [];

  constructor(o: { failOnFinish?: boolean } = {}) {
    super();
    const inner = this.fetch;
    if (o.failOnFinish !== false) {
      try {
        onTestFinished(() => {
          if (this.problems.length > 0) throw new Error(`the staff contract was broken:\n${this.problems.join('\n')}`);
        });
      } catch {
        // constructed outside a test (a describe body): call assertClean() yourself
      }
    }
    this.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, 'https://app.example.test');
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = staffRouteFor(method, url.pathname);
      if (!key) return inner(input, init);
      const body = init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const bad = staffRequestViolations(key, body, Object.fromEntries(url.searchParams));
      if (bad.length > 0) {
        this.problems.push(...bad.map((b) => `${key} ${b}`));
        await inner(input, init); // recorded as a call, answer dropped
        return new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', requestId: 'r', details: { issues: bad } } }), { status: 422, headers: { 'content-type': 'application/json' } });
      }
      const res = await inner(input, init);
      const text = await res.clone().text();
      const r = staffContract.routes[key]!;
      if (res.ok) {
        if (res.status !== r.status) this.problems.push(`${key}: the fake answered ${res.status}, the API answers ${r.status}`);
        else if (text !== '') {
          const wrong = staffResponseViolations(key, JSON.parse(text) as unknown);
          if (wrong.length > 0) this.problems.push(`${key}: the fake answered a body the API never sends: ${wrong.slice(0, 5).join('; ')}`);
        }
      } else if (text !== '') {
        const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
        // NOT_FOUND from an unscripted route is the FakeFetch default; any other code must be answered with its status
        if (typeof code !== 'string' || (staffContract.errors[code] !== undefined && staffContract.errors[code] !== res.status) || (staffContract.errors[code] === undefined && code !== 'NOT_FOUND' && res.status < 500)) {
          this.problems.push(`${key}: the fake answered ${res.status} ${String(code)}, which is not how the API answers that code`);
        }
      }
      return res;
    };
  }

  assertClean(): void {
    if (this.problems.length > 0) throw new Error(`the staff contract was broken:\n${this.problems.join('\n')}`);
  }
}
