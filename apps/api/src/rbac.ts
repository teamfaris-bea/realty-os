// Route authorization (ARCHITECTURE §3 step 6; R-PERM-1, R-PERM-5, R-PERM-13).
//
// Every route declares how it is authorized in its config:
//
//   app.post('/leads/:id/claim', {
//     config: { auth: 'lead.claim' },                         // a core Action ...
//     preHandler: authorize('lead.claim', (req) => claimFacts(req)),
//     schema: { ... },
//   }, handler);
//
//   config.auth: 'public'   no session (login, signup, password reset, invite acceptance)
//                'webhook'  provider-signed; no session, no CSRF/Origin check (see providers/webhooks.ts)
//                'session'  a valid session, tenant optional (session info, tenant switch, MFA)
//                'self'     a valid session in a tenant, acting only on the caller's own rows (RLS self-only)
//                <Action>   a valid session in a tenant AND core.can(actor, action, facts)
//
//   config.capabilityUrl: true   ('public' routes only) the route's ONLY authority is an unguessable,
//                MAC-signed token in its URL; it reads no cookie and no session. Such a route is exempt
//                from the Origin allowlist, because a cross-site request can do nothing the token holder
//                could not (e.g. RFC 8058 one-click unsubscribe, POSTed by the mailbox provider with no
//                Origin). server.ts refuses the flag on any other kind of route.
//
// server.ts installs the session guard in front of every non-public route from this declaration,
// and REFUSES TO START if a route has no declaration, or declares an Action without an
// authorize(<that action>, …) preHandler. The route-table test lists every route and its declaration.
//
// authorize(): the resource function returns the facts it established from RLS-visible rows, or
// null when the resource is invisible or does not exist. Both null and every can() permission denial
// are 404 NOT_FOUND (R-PERM-5); re-authentication is checked last by can() and is 401
// REAUTH_REQUIRED (R-PERM-13).
import { type Action, type ResourceFacts, can, isAction } from '@realty/core/foundation';
import type { FastifyRequest, RouteOptions, preHandlerHookHandler } from 'fastify';
import { AppError, isErrorCode } from './errors.js';

export type RouteAuth = Action | 'public' | 'webhook' | 'session' | 'self';
/** Session states a route still serves: MFA not yet verified, or enrollment-only (R-PERM-14). */
export type PartialAllowance = 'mfa_pending' | 'enrollment';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
    allowPartial?: readonly PartialAllowance[];
    capabilityUrl?: true;
  }
}

export const AUTHORIZE_TAG = Symbol.for('realty.authorize');
export const GUARD_TAG = Symbol.for('realty.guard');

type Tagged = preHandlerHookHandler & { [AUTHORIZE_TAG]?: Action; [GUARD_TAG]?: 'session' | 'actor' };

export type FactsFn = (req: FastifyRequest) => Promise<ResourceFacts | null> | ResourceFacts | null;

export function authorize(action: Action, resource: FactsFn): preHandlerHookHandler {
  if (!isAction(action)) throw new TypeError(`authorize: unknown action ${String(action)}`);
  const h: Tagged = async function authorizeHandler(req) {
    const actor = req.actor;
    const state = req.authState;
    if (!actor || !state) throw new AppError('UNAUTHENTICATED');
    const facts = await resource(req);
    if (facts === null) throw new AppError('NOT_FOUND');
    const r = can(actor, action, { ...facts, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } });
    if (!r.ok) throw new AppError(isErrorCode(r.code) ? r.code : 'NOT_FOUND');
    req.authorizedAction = action;
  };
  h[AUTHORIZE_TAG] = action;
  return h;
}

export function tagGuard(h: preHandlerHookHandler, kind: 'session' | 'actor'): preHandlerHookHandler {
  (h as Tagged)[GUARD_TAG] = kind;
  return h;
}

function handlers(v: RouteOptions['preHandler']): Tagged[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]) as Tagged[];
}

export interface RouteTableEntry {
  method: string;
  url: string;
  auth: RouteAuth;
  authorizes: Action | null;
  /** every key the route's Zod input schemas (body, params, querystring) accept, nested as a.b */
  inputKeys: string[];
  /** a public route authorized only by a token in its URL (exempt from the Origin allowlist) */
  capabilityUrl?: true;
}

/** Collects the object keys a Zod schema accepts (unwrapping optional/nullable/arrays/unions/pipes). */
export function zodInputKeys(schema: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (!schema || typeof schema !== 'object' || depth > 8) return out;
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return out;
  switch (def.type) {
    case 'object': {
      const shape = (def.shape ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(shape)) {
        out.push(prefix + k);
        zodInputKeys(v, `${prefix}${k}.`, depth + 1, out);
      }
      return out;
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
      return zodInputKeys(def.innerType, prefix, depth + 1, out);
    case 'array':
      return zodInputKeys(def.element, prefix, depth + 1, out);
    case 'pipe':
      zodInputKeys(def.in, prefix, depth + 1, out);
      return zodInputKeys(def.out, prefix, depth + 1, out);
    case 'union':
      for (const o of (def.options ?? []) as unknown[]) zodInputKeys(o, prefix, depth + 1, out);
      return out;
    case 'intersection':
      zodInputKeys(def.left, prefix, depth + 1, out);
      return zodInputKeys(def.right, prefix, depth + 1, out);
    case 'record':
      out.push(`${prefix}*`);
      return zodInputKeys(def.valueType, `${prefix}*.`, depth + 1, out);
    default:
      return out;
  }
}

export class RouteAuthorizationError extends Error {
  override readonly name = 'RouteAuthorizationError';
}

/**
 * Validates a route's declaration and returns its guard and its own preHandler chain. server.ts
 * installs the guard FIRST in the route's preValidation, so the session/CSRF/MFA or webhook
 * signature check runs before input validation (an anonymous or mis-signed request never reaches
 * the schema: 401/403, not 422), and authorize() (preHandler) runs after it with validated input.
 * Throws RouteAuthorizationError (the server does not start) when the declaration is missing, an
 * Action route lacks its authorize(), or a non-'session' route opts into the MFA partial states
 * (R-PERM-14: enrollment-only and MFA-pending sessions reach only the session routes).
 */
export function securedPreHandlers(
  route: Pick<RouteOptions, 'method' | 'url' | 'preHandler' | 'config' | 'schema'>,
  guards: { session: preHandlerHookHandler; actor: preHandlerHookHandler; webhook: preHandlerHookHandler },
): { guard: preHandlerHookHandler | null; chain: preHandlerHookHandler[]; entry: RouteTableEntry } {
  const cfg = (route.config ?? {}) as { auth?: RouteAuth; allowPartial?: readonly PartialAllowance[]; capabilityUrl?: boolean };
  const method = Array.isArray(route.method) ? route.method.join(',') : String(route.method);
  const where = `${method} ${route.url}`;
  const auth = cfg.auth;
  if (auth === undefined) throw new RouteAuthorizationError(`${where}: route declares no authorization (config.auth)`);
  const own = handlers(route.preHandler).filter((h) => h[GUARD_TAG] === undefined);
  const tagged = own.map((h) => h[AUTHORIZE_TAG]).filter((a): a is Action => a !== undefined);
  let guard: preHandlerHookHandler | null;
  if (auth === 'public') guard = null;
  else if (auth === 'webhook') guard = guards.webhook;
  else if (auth === 'session') guard = guards.session;
  else if (auth === 'self') guard = guards.actor;
  else if (isAction(auth)) {
    if (!tagged.includes(auth)) throw new RouteAuthorizationError(`${where}: declares '${auth}' but has no authorize('${auth}', …) preHandler`);
    guard = guards.actor;
  } else throw new RouteAuthorizationError(`${where}: unknown authorization '${String(auth)}'`);
  if ((cfg.allowPartial ?? []).length > 0 && auth !== 'session') {
    throw new RouteAuthorizationError(`${where}: only 'session' routes may serve MFA-pending or enrollment-only sessions (allowPartial)`);
  }
  if (cfg.capabilityUrl !== undefined && (cfg.capabilityUrl !== true || auth !== 'public' || !/:[A-Za-z]*token/i.test(route.url))) {
    throw new RouteAuthorizationError(`${where}: only a 'public' route with a :token URL parameter may declare capabilityUrl`);
  }
  if (tagged.some((a) => a !== auth)) throw new RouteAuthorizationError(`${where}: authorize() for a different action than declared`);
  const sch = (route.schema ?? {}) as { body?: unknown; params?: unknown; querystring?: unknown };
  const inputKeys = [...new Set([sch.body, sch.params, sch.querystring].flatMap((x) => zodInputKeys(x)))].sort();
  return { guard, chain: own, entry: { method, url: route.url, auth, authorizes: tagged[0] ?? null, inputKeys, ...(cfg.capabilityUrl ? { capabilityUrl: true as const } : {}) } };
}
