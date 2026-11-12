// The module 22 contract the web app is built against: every route the inbox surfaces (compose, thread) and the
// website chat widget call for web chat, with the JSON Schema of its request (body, query) and of its 200 response,
// generated from the very Zod schemas those routes validate and serialize with, plus the error codes the web turns
// into words, with their HTTP status (errors.ts). apps/web may not import @realty/api code, so it reads the
// generated JSON (webContract.json, next to this file) in its contract tests: the requests its clients send are
// validated against these schemas and its fakes may only answer with responses these schemas accept.
// webContract.test.ts fails when the committed JSON is not exactly what this generates, and checks every route
// against the server's own route table, so an API change cannot land without the web's contract tests seeing it.
//
//   regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/channels/webContract.ts --write
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as A from '../assistant/schemas.js';
import * as S from '../comms/schemas.js';
import { ERROR_STATUS, type ErrorCode } from '../errors.js';
import { zodInputKeys } from '../rbac.js';
import { ConfigResponse, MessageBody, MessageResponse, PollQuery, PollResponse, StartBody, StartResponse } from './routes.js';
import { MESSAGE_MAX, NAME_MAX, SESSION_TOKEN_RE, WIDGET_KEY_RE } from './webchat.js';

export const WEB_CONTRACT_FILE = fileURLToPath(new URL('./webContract.json', import.meta.url));

interface RouteSpec {
  body?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
}

/**
 * Keyed "METHOD url" exactly as the route table lists it, without the /api prefix. webContract.test.ts proves each spec
 * holds the very schema objects its route registered (a route bound to another object fails there, finding F4).
 */
export const CONTRACT_ROUTES: Readonly<Record<string, RouteSpec>> = {
  // the website chat widget (public, credential-less)
  'GET /public/chat/:widgetToken': { response: ConfigResponse },
  'POST /public/chat/:widgetToken/start': { body: StartBody, response: StartResponse },
  'POST /public/chat/session/:token/messages': { body: MessageBody, response: MessageResponse },
  'GET /public/chat/session/:token/poll': { query: PollQuery, response: PollResponse },
  // an agent's reply in web chat: the one human send path, its preview, and an approved draft moved to web chat
  'POST /contacts/:id/messages': { body: S.ComposeBody, response: S.ComposeResponse },
  'POST /contacts/:id/messages/preview': { body: S.PreviewBody, response: S.PreviewResponse },
  'POST /assistant/actions/:id/approve': { body: A.ApproveBody, response: A.ApproveResponse },
  // whether the chat can be answered before anyone types (channels.web_chat)
  'GET /contacts/:id/reachability': { response: S.ReachabilityResponse },
  'GET /reachability': { query: S.ReachabilityManyQuery, response: S.ReachabilityManyResponse },
  // D5a: the compose box's photo and video uploads (comms/outboundMedia.ts)
  'POST /contacts/:id/outbound-media': { body: S.UploadMediaBody, response: S.UploadMediaResponse },
  'DELETE /contacts/:id/outbound-media/:uploadId': { response: S.NoContent },
};

/** The error codes the web's chat clients handle, with the status the API answers them with. */
const ERRORS = [
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CHANNEL_NOT_CONNECTED',
  'WEBCHAT_DISCLOSURE_STALE',
  'WEBCHAT_SESSION_CLOSED',
  'CONTACT_POINT_MISSING',
  'DRAFT_STALE',
  'DRAFT_INVALIDATED',
  'MEDIA_NOT_ALLOWED',
  'MEDIA_TOO_LARGE',
  'MEDIA_LOCATION_NOT_REMOVED',
  'MEDIA_UPLOAD_GONE',
  'MEDIA_UPLOAD_LIMIT',
] as const satisfies readonly ErrorCode[];

/**
 * Rules a route's handler or a Zod transform applies that its JSON Schema cannot carry (finding F3). The web's checker
 * applies them (apps/web/src/test/contract.ts); webContract.test.ts proves the real routes refuse exactly that:
 *   exactlyOneOf  exactly one of these body keys is present (start's claimOf: both, or neither, is 422)
 *   commaList     a query string key holding a comma-separated list, each item checked against `items`
 */
export interface RequestRule {
  exactlyOneOf?: string[];
  commaList?: { key: string; items: unknown; minItems: number; maxItems: number };
}

const RULES: Record<string, RequestRule> = {
  'POST /public/chat/:widgetToken/start': { exactlyOneOf: ['phone', 'email'] },
  'GET /reachability': { commaList: { key: 'contactIds', items: null, minItems: 1, maxItems: 50 } },
};

/**
 * A string schema whose value Zod trims before its length and pattern checks (`.trim()` is an overwrite check that
 * trims). JSON Schema has no keyword for it, so the contract marks it `x-trim` and the web's checker trims first.
 */
function trims(s: unknown): boolean {
  const def = (s as { _zod?: { def?: { type?: string; checks?: { _zod?: { def?: { check?: string; tx?: (v: string) => unknown } } }[] } } })._zod?.def;
  if (def?.type !== 'string') return false;
  return (def.checks ?? []).some((c) => {
    const d = c._zod?.def;
    if (d?.check !== 'overwrite' || typeof d.tx !== 'function') return false;
    try {
      return d.tx('  x  ') === 'x';
    } catch {
      return false;
    }
  });
}

const json = (s: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, {
    io,
    reused: 'ref',
    override: (ctx) => {
      if (io === 'input' && trims(ctx.zodSchema)) (ctx.jsonSchema as Record<string, unknown>)['x-trim'] = true;
    },
  }) as Record<string, unknown>;
  return rest;
};
const params = (url: string) => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

export interface WebContract {
  $comment: string;
  routes: Record<string, { inputKeys: string[]; body: unknown; query: unknown; response: unknown }>;
  /** what each route's handler or Zod transforms check beyond its JSON Schema (finding F3) */
  rules: Record<string, RequestRule>;
  errors: Record<(typeof ERRORS)[number], number>;
  webChat: { widgetKey: string; sessionToken: string; nameMax: number; messageMax: number };
}

export function webContract(): WebContract {
  return {
    $comment: 'GENERATED from the API Zod schemas by apps/api/src/channels/webContract.ts (--write). Do not edit: apps/api/src/channels/webContract.test.ts fails when this file drifts.',
    routes: Object.fromEntries(
      Object.entries(CONTRACT_ROUTES).map(([key, r]) => {
        const url = key.split(' ')[1]!;
        const inputKeys = [...new Set([...params(url), ...zodInputKeys(r.body), ...zodInputKeys(r.query)])].sort();
        return [key, { inputKeys, body: r.body ? json(r.body, 'input') : null, query: r.query ? json(r.query, 'input') : null, response: json(r.response, 'output') }];
      }),
    ),
    rules: Object.fromEntries(
      Object.entries(RULES).map(([k, r]) => [k, r.commaList ? { ...r, commaList: { ...r.commaList, items: json(z.uuid(), 'input') } } : r]),
    ),
    errors: Object.fromEntries(ERRORS.map((c) => [c, ERROR_STATUS[c]])) as WebContract['errors'],
    webChat: { widgetKey: WIDGET_KEY_RE.source, sessionToken: SESSION_TOKEN_RE.source, nameMax: NAME_MAX, messageMax: MESSAGE_MAX },
  };
}

export const webContractText = (): string => `${JSON.stringify(webContract(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = webContractText();
  if (process.argv.includes('--write')) writeFileSync(WEB_CONTRACT_FILE, text);
  else if (readFileSync(WEB_CONTRACT_FILE, 'utf8') !== text) {
    console.error('webContract.json is stale: run with --write');
    process.exit(1);
  }
}
