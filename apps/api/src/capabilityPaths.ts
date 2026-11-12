// The URL paths that carry a capability, generated from the server's own route table (findings
// chat-token-in-access-log, F2-invite-token-access-log). A capability path has a secret in a path segment that is
// the request's only authority: the invite token, the chat session token, the one-click unsubscribe ref, a lead
// source's intake token. Whoever reads such a URL can act with it, so the `web` image's nginx (deploy/nginx.conf)
// writes none of them to a log: its access log writes "-" in place of each secret ($log_uri), and its error log
// writes no request at all. apps/web does not depend on @realty/api, so the nginx test
// (apps/web/src/security-headers.nginx.test.ts) reads the generated capabilityPaths.json, next to this file, and
// checks every path in it against the nginx config. capabilityPaths.test.ts fails while the committed JSON is not
// what the live route table generates, so a new capability route fails there until the JSON is regenerated, and
// then in the nginx test until nginx redacts it.
//
//   regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/capabilityPaths.ts --write
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RouteTableEntry } from './rbac.js';

export const CAPABILITY_PATHS_FILE = fileURLToPath(new URL('./capabilityPaths.json', import.meta.url));

const WIDGET_KEY = 'the website chat widget key: it is in the embed code of every website that shows the widget (module 37)';

/**
 * Path parameters that are no secret although the rule below would make them one, and why, by route path (as the
 * route table lists it) and parameter name: an exemption covers the routes it was decided for, never the same name on
 * another route (finding deploy-R2-public-param-exemption-by-name). Adding one decides that whoever reads the access
 * log may see its value on that route. capabilityPaths.test.ts fails while one names a path the route table has not.
 */
export const PUBLIC_PATH_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/api/public/chat/:widgetToken': { widgetToken: WIDGET_KEY },
  '/api/public/chat/:widgetToken/start': { widgetToken: WIDGET_KEY },
  '/api/admin/integrations/:kind/callback': { kind: "the integration kind in an OAuth callback's path (a fixed list)" },
};

/** The parameters PUBLIC_PATH_PARAMS names public on this route path (none on any other). */
const publicParamsOf = (url: string): Readonly<Record<string, string>> => (Object.hasOwn(PUBLIC_PATH_PARAMS, url) ? PUBLIC_PATH_PARAMS[url]! : {});

/** A path parameter: `:name` in a route's URL. */
const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The parameters of a route's path that are a secret. A parameter named …token is one on any route (the convention
 * `capabilityUrl` relies on, rbac.ts), and so is every parameter of a route without a session ('public', 'webhook'),
 * where the URL may be the only authority. PUBLIC_PATH_PARAMS lists the exceptions, route by route.
 */
export function secretParams(route: Pick<RouteTableEntry, 'url' | 'auth'>): string[] {
  // a wildcard or a regular-expression parameter would slip past the rule: refuse it until the rule covers it
  if (/[*(]/.test(route.url)) throw new Error(`capabilityPaths: ${route.url} has a wildcard or regular-expression parameter, which the secret rule does not cover`);
  const unauthenticated = route.auth === 'public' || route.auth === 'webhook';
  const exempt = publicParamsOf(route.url);
  return [...route.url.matchAll(PARAM)].map((m) => m[1]!).filter((p) => !Object.hasOwn(exempt, p) && (/token$/i.test(p) || unauthenticated));
}

export interface CapabilityPath {
  /** the route's path as the route table lists it, /api prefix included */
  path: string;
  methods: string[];
  /** its parameters that are a secret */
  secrets: string[];
}

/** Every path of the route table with at least one secret parameter, sorted by path. */
export function capabilityPaths(table: readonly Pick<RouteTableEntry, 'method' | 'url' | 'auth'>[]): CapabilityPath[] {
  const byPath = new Map<string, { methods: Set<string>; secrets: Set<string> }>();
  for (const r of table) {
    const secrets = secretParams(r);
    if (secrets.length === 0) continue;
    const e = byPath.get(r.url) ?? { methods: new Set<string>(), secrets: new Set<string>() };
    for (const m of r.method.split(',')) e.methods.add(m);
    for (const s of secrets) e.secrets.add(s);
    byPath.set(r.url, e);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, e]) => ({ path, methods: [...e.methods].sort(), secrets: [...e.secrets].sort() }));
}

export const capabilityPathsText = (table: readonly Pick<RouteTableEntry, 'method' | 'url' | 'auth'>[]): string =>
  `${JSON.stringify(
    {
      $comment:
        'GENERATED from the API route table by apps/api/src/capabilityPaths.ts (--write). Do not edit: apps/api/src/capabilityPaths.test.ts fails when this file drifts, and apps/web/src/security-headers.nginx.test.ts fails while deploy/nginx.conf would log a secret of any path listed here.',
      publicParams: PUBLIC_PATH_PARAMS,
      paths: capabilityPaths(table),
    },
    null,
    2,
  )}\n`;

/**
 * The live route table: the server registers every route module (routes.ts) and nothing listens. Registering routes
 * reads no row, so the database handle is never connected.
 */
async function withLiveServer<T>(fn: (app: import('fastify').FastifyInstance) => T): Promise<T> {
  const [{ instant, uuidv7Generator }, { createDatabase }, { testConfig }, { createFakeProviders }, { buildServer }] = await Promise.all([
    import('@realty/core/foundation'),
    import('@realty/db'),
    import('./auth/testHarness.js'),
    import('./providers/index.js'),
    import('./server.js'),
  ]);
  const clock = { now: () => instant(Date.now()) };
  const db = createDatabase({ url: 'postgres://route-table.invalid/unused', max: 1 });
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids, db });
  try {
    await app.ready();
    return fn(app);
  } finally {
    await app.close();
    await db.close();
  }
}

export async function liveRouteTable(): Promise<RouteTableEntry[]> {
  return withLiveServer((app) => [...app.platform.routeTable]);
}

/**
 * Routes served OUTSIDE /api (b7 db-public/F2). They are not in the route table, so neither the authorization
 * declaration nor this file's capability rule sees them; capabilityPaths.test.ts pins them to this list, so a new
 * one (or a new parameter) is a decision, not an accident. deploy/nginx.conf proxies each prefix to the API.
 * Every parameter here is public: it names a published page, not an authority (R-MKT-7).
 */
export const DOCUMENT_ROUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/p/:tenantSlug/:pageSlug': { tenantSlug: "the tenant's public slug", pageSlug: "a published listing page's public slug" },
  '/p/:tenantSlug/:pageSlug/photos/:position': { tenantSlug: "the tenant's public slug", pageSlug: "a published listing page's public slug", position: "a photo's position on that page" },
};

/** Every route of the built server outside /api, with its methods (from Fastify's route tree). */
export async function liveRoutesOutsideApi(): Promise<{ path: string; methods: string[] }[]> {
  return withLiveServer((app) => {
    const out: { path: string; methods: string[] }[] = [];
    const stack: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)(?: \(([^)]*)\))?/.exec(line);
      if (!m) continue;
      const depth = m[1]!.length / 4;
      stack.length = depth;
      stack.push(m[2]!);
      const path = stack.join('');
      if (m[3] && !path.startsWith('/api')) out.push({ path, methods: m[3].split(',').map((x) => x.trim()).sort() });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void liveRouteTable().then((table) => {
    const text = capabilityPathsText(table);
    if (process.argv.includes('--write')) writeFileSync(CAPABILITY_PATHS_FILE, text);
    else if (readFileSync(CAPABILITY_PATHS_FILE, 'utf8') !== text) {
      console.error('capabilityPaths.json is stale: run with --write');
      process.exit(1);
    }
  });
}
