// Module 45's contract with modules 46 (the client portal app) and 55 (the staff portal surfaces): every portal route
// with the JSON Schema of its request (body, query) and of its success response, generated from the very Zod schemas
// the routes validate and serialize with, the error codes with their HTTP status (errors.ts) and their sentence
// (copy.ts), and the fixed pieces of the sign-in flow (the page, the token's place, the session policy).
// webContract.test.ts fails when the committed JSON is not exactly what this generates, and checks every route against
// the server's own route table.
//
//   regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/portal/shared/webContract.ts --write
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '../../errors.js';
import { zodInputKeys } from '../../rbac.js';
import { CODE_SENTENCES, PORTAL_PAGE, SIGNIN_ACCEPTED } from './copy.js';
import * as S from './schemas.js';
import { SESSION_POLICY } from './session.js';

export const PORTAL_WEB_CONTRACT_FILE = fileURLToPath(new URL('./webContract.json', import.meta.url));

interface RouteSpec {
  body?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType | null;
  /** the success status when it is not 200 */
  status?: number;
  side: 'signin' | 'client' | 'staff';
}

/** Keyed "METHOD url" exactly as the route table lists it, without the /api prefix. */
export const PORTAL_CONTRACT_ROUTES: Readonly<Record<string, RouteSpec>> = {
  'POST /portal/login': { body: S.LoginBody, response: S.LoginAccepted, status: 202, side: 'signin' },
  'POST /portal/session': { body: S.SessionBody, response: S.SessionResponse, side: 'signin' },
  'GET /portal/me': { response: S.MeResponse, side: 'client' },
  'POST /portal/logout': { response: null, status: 204, side: 'client' },
  'GET /portal/timeline': { query: S.GrantQuery, response: S.TimelineResponse, side: 'client' },
  'GET /portal/documents': { query: S.GrantQuery, response: S.DocumentsResponse, side: 'client' },
  'POST /portal/documents/:itemId/stream-token': { response: S.StreamTokenResponse, side: 'client' },
  'GET /portal/files/:token': { response: null, side: 'client' },
  'POST /deals/:id/portal/invite': { body: S.InviteBody, response: S.InviteResponse, side: 'staff' },
  'POST /listings/:id/portal/invite': { body: S.InviteBody, response: S.InviteResponse, side: 'staff' },
  'GET /deals/:id/portal': { response: S.PortalStateResponse, side: 'staff' },
  'GET /listings/:id/portal': { response: S.PortalStateResponse, side: 'staff' },
  'GET /portal-grants/:id/preview': { response: S.PreviewResponse, side: 'staff' },
  'POST /portal-items/preview': { body: S.ItemPreviewBody, response: S.ItemPreviewResponse, side: 'staff' },
  'POST /portal-items': { body: S.PublishBody, response: S.PublishResponse, side: 'staff' },
  'POST /portal-items/:id/retract': { response: S.OkResponse, side: 'staff' },
  'POST /portal-grants/:id/revoke': { response: S.OkResponse, side: 'staff' },
  'POST /portal-accounts/:id/disable': { body: S.DisableBody, response: S.OkResponse, side: 'staff' },
  'POST /portal-accounts/:id/login-point': { body: S.LoginPointBody, response: S.OkResponse, side: 'staff' },
  'PATCH /portal-grants/:id/display': { body: S.DisplayBody, response: S.OkResponse, side: 'staff' },
};

/** Every code a portal route answers with a sentence, as errors.ts answers it. */
export const PORTAL_ERRORS = Object.keys(CODE_SENTENCES).filter((c): c is ErrorCode => Object.hasOwn(ERROR_STATUS, c)).sort();

const json = (s: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, reused: 'ref' }) as Record<string, unknown>;
  return rest;
};
const params = (url: string) => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

export function portalWebContract() {
  return {
    $comment: 'GENERATED from the API Zod schemas by apps/api/src/portal/shared/webContract.ts (--write). Do not edit: apps/api/src/portal/shared/webContract.test.ts fails when this file drifts.',
    routes: Object.fromEntries(
      Object.entries(PORTAL_CONTRACT_ROUTES).map(([key, r]) => {
        const url = key.split(' ')[1]!;
        const inputKeys = [...new Set([...params(url), ...zodInputKeys(r.body), ...zodInputKeys(r.query)])].sort();
        return [key, { side: r.side, status: r.status ?? 200, inputKeys, body: r.body ? json(r.body, 'input') : null, query: r.query ? json(r.query, 'input') : null, response: r.response ? json(r.response, 'output') : null }];
      }),
    ),
    errors: Object.fromEntries(PORTAL_ERRORS.map((c) => [c, { status: ERROR_STATUS[c], sentence: (CODE_SENTENCES as Record<string, string>)[c]! }])),
    signin: { page: PORTAL_PAGE, tokenInFragment: '#token=', teamInQuery: '?team=', acceptedMessage: SIGNIN_ACCEPTED, csrfHeader: 'x-csrf-token', session: SESSION_POLICY },
  };
}

export const portalWebContractText = (): string => `${JSON.stringify(portalWebContract(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = portalWebContractText();
  if (process.argv.includes('--write')) writeFileSync(PORTAL_WEB_CONTRACT_FILE, text);
  else if (readFileSync(PORTAL_WEB_CONTRACT_FILE, 'utf8') !== text) {
    console.error('portal webContract.json is stale: run with --write');
    process.exit(1);
  }
}
