// The module 75/76 contract the web's AI care surface (apps/web/src/surfaces/aiCare) is built against: every AI ISA
// route it calls, with the JSON Schema of its request (body, query) and of its 200 response, generated from the very
// Zod schemas those routes register (isa/schemas.ts and isaWeb/routes.ts), plus the module-75 error codes with their
// HTTP status (errors.ts). apps/web may not import @realty/api code, so it reads the generated JSON (webContract.json,
// next to this file) in aiCare/api.contract.test.tsx; webContract.test.ts fails when the JSON drifts and checks every
// route against the server's own route table. The channels/webContract.ts pattern (module 22).
//
//   regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/isaWeb/webContract.ts --write
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '../errors.js';
import * as S from '../isa/schemas.js';
import { zodInputKeys } from '../rbac.js';
import { HandoffView } from './routes.js';

export const ISA_WEB_CONTRACT_FILE = fileURLToPath(new URL('./webContract.json', import.meta.url));

interface RouteSpec {
  body?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
}

export const ISA_CONTRACT_ROUTES: Readonly<Record<string, RouteSpec>> = {
  'GET /admin/ai-isa': { response: S.AdminView },
  'PUT /admin/ai-isa': { body: S.AdminPutBody, response: S.AdminView },
  'GET /me/ai-isa': { response: S.MeView },
  'PUT /me/ai-isa/opt-in': { body: S.OptInBody, response: S.OptInResult },
  'POST /me/ai-isa/opt-in/revoke': { body: S.EmptyBody, response: S.RevokeResult },
  'POST /me/ai-isa/pause-all': { body: S.EmptyBody, response: S.PauseAllResult },
  'POST /me/ai-isa/re-attest': { body: S.ReattestBody, response: S.ReattestResult },
  'GET /ai-isa/assignments': { query: S.ListQuery, response: S.ListResponse },
  'GET /contacts/:id/ai-isa': { response: S.PanelResponse },
  'GET /contacts/:id/ai-isa/turns': { response: S.TurnsResponse },
  'POST /contacts/:id/ai-isa/start': { body: S.StartBody, response: S.StartResult },
  'POST /contacts/:id/ai-isa/pause': { body: S.PauseBody, response: S.ControlResult },
  'POST /contacts/:id/ai-isa/resume': { body: S.EmptyBody, response: S.ControlResult },
  'POST /contacts/:id/ai-isa/take-over': { body: S.EmptyBody, response: S.ControlResult },
  'POST /contacts/:id/ai-isa/end': { body: S.EmptyBody, response: S.ControlResult },
  'POST /contacts/:id/ai-isa/undo': { body: S.EmptyBody, response: S.ControlResult },
  'POST /contacts/:id/ai-isa/continue': { body: S.EmptyBody, response: S.StartResult },
  'POST /contacts/:id/ai-isa/lift-block': { body: S.LiftBlockBody, response: S.LiftBlockResult },
  'POST /ai-isa/handoffs/:id/ack': { body: S.EmptyBody, response: S.AckResult },
  'POST /ai-isa/escalations/:id/resolve': { body: S.ResolveBody, response: S.ResolveResult },
  'GET /ai-isa/handoffs/:id': { response: HandoffView },
};

/** The module-75 codes (errors.ts, between its "module 75" header and the next header or the registry marker), plus the shell codes the surface meets. */
export function module75Codes(): string[] {
  const text = readFileSync(fileURLToPath(new URL('../errors.ts', import.meta.url)), 'utf8');
  const start = text.indexOf('// ---- module 75');
  const next = text.indexOf('// ----', start + 10);
  const marker = text.indexOf('// registry: add new entries above this line', start);
  const end = next !== -1 && next < marker ? next : marker;
  return [...text.slice(start, end).matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}
const SHELL = ['NOT_FOUND', 'VALIDATION_FAILED', 'REAUTH_REQUIRED', 'OWNER_REQUIRED', 'ATTESTATION_REQUIRED'] as const satisfies readonly ErrorCode[];

const json = (s: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, reused: 'ref', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
};
const params = (url: string) => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

export interface IsaWebContract {
  $comment: string;
  routes: Record<string, { inputKeys: string[]; body: unknown; query: unknown; response: unknown }>;
  errors: Record<string, number>;
}

export function isaWebContract(): IsaWebContract {
  const codes = [...SHELL, ...module75Codes()] as ErrorCode[];
  return {
    $comment: 'GENERATED from the API Zod schemas by apps/api/src/isaWeb/webContract.ts (--write). Do not edit: apps/api/src/isaWeb/webContract.test.ts fails when this file drifts.',
    routes: Object.fromEntries(
      Object.entries(ISA_CONTRACT_ROUTES).map(([key, r]) => {
        const url = key.split(' ')[1]!;
        const inputKeys = [...new Set([...params(url), ...zodInputKeys(r.body), ...zodInputKeys(r.query)])].sort();
        return [key, { inputKeys, body: r.body ? json(r.body, 'input') : null, query: r.query ? json(r.query, 'input') : null, response: json(r.response, 'output') }];
      }),
    ),
    errors: Object.fromEntries(codes.map((c) => [c, ERROR_STATUS[c]])),
  };
}

export const isaWebContractText = (): string => `${JSON.stringify(isaWebContract(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = isaWebContractText();
  if (process.argv.includes('--write')) writeFileSync(ISA_WEB_CONTRACT_FILE, text);
  else if (readFileSync(ISA_WEB_CONTRACT_FILE, 'utf8') !== text) {
    console.error('webContract.json is stale: run with --write');
    process.exit(1);
  }
}
