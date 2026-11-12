// The paths whose URL carries a capability (findings chat-token-in-access-log, F2-invite-token-access-log). nginx must
// log none of their secrets: apps/web/src/security-headers.nginx.test.ts checks deploy/nginx.conf for every path in
// capabilityPaths.json, and this file proves that JSON is exactly what the live route table generates, and pins the
// rule that decides which path parameters are secrets. A new route with a secret in its path therefore fails here
// until the JSON is regenerated, and then in the nginx test until nginx redacts it.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITY_PATHS_FILE, DOCUMENT_ROUTES, PUBLIC_PATH_PARAMS, capabilityPaths, capabilityPathsText, liveRouteTable, liveRoutesOutsideApi, secretParams } from './capabilityPaths.js';
import type { RouteTableEntry } from './rbac.js';

let table: RouteTableEntry[];
beforeAll(async () => {
  table = await liveRouteTable();
}, 120_000);

describe('the paths that carry a capability (capabilityPaths.json, read by the nginx test)', () => {
  it('is exactly what the live route table generates (regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/capabilityPaths.ts --write)', () => {
    expect(table.length).toBeGreaterThan(300);
    expect(readFileSync(CAPABILITY_PATHS_FILE, 'utf8')).toBe(capabilityPathsText(table));
  });

  it('F2-invite-token-access-log: the invite acceptance is a capability path, next to the chat session routes, the one-click unsubscribe and the lead intake, each with its secret', () => {
    expect(capabilityPaths(table).map((p) => `${p.methods.join(',')} ${p.path} [${p.secrets.join(',')}]`)).toEqual([
      'POST /api/auth/invites/:token/accept [token]',
      'GET,HEAD,POST /api/email/unsubscribe/:token [token]',
      'POST /api/intake/:sourceToken [sourceToken]',
      'POST /api/public/chat/session/:token/messages [token]',
      'GET,HEAD /api/public/chat/session/:token/poll [token]',
      // b7 db-public/F1: module 29's signed image link (handed to Meta; the token carries the tenant and object ids)
      'GET,HEAD /api/public/marketing-assets/:assetToken [assetToken]',
    ]);
  });

  it('F2-invite-token-access-log: the rule: a parameter named …token on any route, and every parameter of a route without a session, is a secret; the widget key, an OAuth callback’s kind and a session route’s ids are not', () => {
    const secret = (url: string, auth: RouteTableEntry['auth']) => secretParams({ url, auth });
    // today's routes that are no capability path
    expect(secret('/api/public/chat/:widgetToken', 'public')).toEqual([]);
    expect(secret('/api/public/chat/:widgetToken/start', 'public')).toEqual([]);
    expect(secret('/api/admin/integrations/:kind/callback', 'public')).toEqual([]);
    expect(secret('/api/contacts/:id/thread', 'contact.view')).toEqual([]);
    expect(secret('/api/recordings/:id/stream', 'recording.play')).toEqual([]);
    // a new route is a capability path unless its parameter is named public on purpose
    expect(secret('/api/auth/invites/:token/accept', 'public')).toEqual(['token']);
    expect(secret('/api/portal/login/:code', 'public')).toEqual(['code']);
    expect(secret('/api/webhooks/partner/:hookId/events', 'webhook')).toEqual(['hookId']);
    expect(secret('/api/devices/:id/pair/:pairingToken', 'self')).toEqual(['pairingToken']);
    // a parameter shape the rule cannot read is refused, not skipped
    expect(() => secret('/api/files/*', 'public')).toThrow(/wildcard or regular-expression/);
    expect(() => secret('/api/x/:id(^\\d+)', 'public')).toThrow(/wildcard or regular-expression/);
  });

  it('deploy-R2-public-param-exemption-by-name: a parameter is public on the routes it was decided for only, never by its name on another route', () => {
    const secret = (url: string, auth: RouteTableEntry['auth']) => secretParams({ url, auth });
    expect(Object.entries(PUBLIC_PATH_PARAMS).map(([url, ps]) => `${url} [${Object.keys(ps).join(',')}]`).sort()).toEqual([
      '/api/admin/integrations/:kind/callback [kind]',
      '/api/public/chat/:widgetToken [widgetToken]',
      '/api/public/chat/:widgetToken/start [widgetToken]',
    ]);
    // the same names on any other route are secrets
    expect(secret('/api/public/listings/:kind/:slug', 'public')).toEqual(['kind', 'slug']);
    expect(secret('/api/webhooks/:kind/events', 'webhook')).toEqual(['kind']);
    expect(secret('/api/public/forms/:widgetToken', 'public')).toEqual(['widgetToken']);
    expect(secret('/api/public/chat/:widgetToken/rotate', 'public')).toEqual(['widgetToken']);
    expect(secret('/api/admin/widgets/:widgetToken', 'session')).toEqual(['widgetToken']);
  });

  it('deploy-R2-public-param-exemption-by-name: every exemption names a route of the live table and one of its parameters, which would be a secret without it (no stale or needless exemption)', () => {
    for (const [url, params] of Object.entries(PUBLIC_PATH_PARAMS)) {
      const routes = table.filter((r) => r.url === url);
      expect(routes.length, url).toBeGreaterThan(0);
      for (const p of Object.keys(params)) {
        expect(url, p).toContain(`:${p}`);
        expect(
          routes.some((r) => r.auth === 'public' || r.auth === 'webhook' || /token$/i.test(p)),
          `${url} :${p} is no secret even without its exemption`,
        ).toBe(true);
      }
    }
  });

  it('every listed secret is a parameter of its path, and every route of the table with a secret parameter is listed', () => {
    const listed = capabilityPaths(table);
    for (const p of listed) for (const s of p.secrets) expect(p.path, s).toContain(`:${s}`);
    const urls = new Set(listed.map((p) => p.path));
    for (const r of table) if (secretParams(r).length > 0) expect(urls.has(r.url), r.url).toBe(true);
  });
});

describe('routes outside /api (b7 db-public/F2)', () => {
  it('R-MKT-7 b7 db-public/F2: the only routes outside /api are the public listing pages, every parameter of which is a declared public slug; nginx proxies /p/ to the API', async () => {
    const all = await liveRoutesOutsideApi();
    // the CORS plugin's catch-all preflight (no handler of ours, server.ts) is the one non-document route
    expect(all.map((r) => `${r.methods.join(',')} ${r.path}`)).toEqual(['OPTIONS *', 'GET,HEAD /p/:tenantSlug/:pageSlug', 'GET,HEAD /p/:tenantSlug/:pageSlug/photos/:position']);
    const live = all.filter((r) => r.path !== '*');
    for (const r of live) {
      const params = [...r.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
      expect(Object.keys(DOCUMENT_ROUTES[r.path] ?? {}).sort(), r.path).toEqual([...params].sort());
      // a token on such a route would be a capability the access log keeps: refused
      for (const p of params) expect(p, r.path).not.toMatch(/token$/i);
    }
    const nginx = readFileSync(new URL('../../../deploy/nginx.conf', import.meta.url), 'utf8');
    for (const prefix of new Set(live.map((r) => `/${r.path.split('/')[1]}/`))) {
      const at = nginx.indexOf(`\n  location ${prefix} {`);
      expect(at, prefix).toBeGreaterThan(0);
      expect(nginx.slice(at, nginx.indexOf('\n  }', at)), prefix).toContain('proxy_pass $api_upstream;');
    }
  }, 120_000);
});
