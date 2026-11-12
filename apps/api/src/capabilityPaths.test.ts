// The paths whose URL carries a capability (findings chat-token-in-access-log, F2-invite-token-access-log). nginx must
// log none of their secrets: apps/web/src/security-headers.nginx.test.ts checks deploy/nginx.conf for every path in
// capabilityPaths.json, and this file proves that JSON is exactly what the live route table generates, and pins the
// rule that decides which path parameters are secrets. A new route with a secret in its path therefore fails here
// until the JSON is regenerated, and then in the nginx test until nginx redacts it.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITY_PATHS_FILE, PUBLIC_PATH_PARAMS, capabilityPaths, capabilityPathsText, liveRouteTable, secretParams } from './capabilityPaths.js';
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
    expect(Object.keys(PUBLIC_PATH_PARAMS).sort()).toEqual(['kind', 'widgetToken']);
    // a new route is a capability path unless its parameter is named public on purpose
    expect(secret('/api/auth/invites/:token/accept', 'public')).toEqual(['token']);
    expect(secret('/api/portal/login/:code', 'public')).toEqual(['code']);
    expect(secret('/api/webhooks/partner/:hookId/events', 'webhook')).toEqual(['hookId']);
    expect(secret('/api/devices/:id/pair/:pairingToken', 'self')).toEqual(['pairingToken']);
    expect(secret('/api/public/listings/:kind/:slug', 'public')).toEqual(['slug']);
    // a parameter shape the rule cannot read is refused, not skipped
    expect(() => secret('/api/files/*', 'public')).toThrow(/wildcard or regular-expression/);
    expect(() => secret('/api/x/:id(^\\d+)', 'public')).toThrow(/wildcard or regular-expression/);
  });

  it('every listed secret is a parameter of its path, and every route of the table with a secret parameter is listed', () => {
    const listed = capabilityPaths(table);
    for (const p of listed) for (const s of p.secrets) expect(p.path, s).toContain(`:${s}`);
    const urls = new Set(listed.map((p) => p.path));
    for (const r of table) if (secretParams(r).length > 0) expect(urls.has(r.url), r.url).toBe(true);
  });
});
