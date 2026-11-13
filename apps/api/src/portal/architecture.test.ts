// The portal boundary (R-PORTAL-8; R-TEN-14): one encapsulated plugin, client routes reach the database only through
// withPortalTx and the portal wrappers, pre-session and staff code never import client code, and every /api/portal
// route is marked and (client routes) guarded. Static checks over the source plus the live route table.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { clientGuard } from './client/guard.js';
import { checkPortalRoute, portalRouteTable } from './plugin.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../../../..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
const importsOf = (file: string): { spec: string; typeOnly: boolean }[] => {
  const src = readFileSync(file, 'utf8');
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)'/gms)) out.push({ spec: m[3]!, typeOnly: m[2] !== undefined });
  for (const m of src.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
};

const CLIENT_ALLOWED = [
  /^@realty\/db$/, // lint-limited to the portal wrappers (realty/portal-tx-separation mode client)
  /^@realty\/core\/(portal|foundation)$/,
  /^\.\.\/shared\//,
  /^\.\/[a-zA-Z]+\.js$/, // client/** itself
  /^\.\.\/\.\.\/errors\.js$/,
  /^\.\.\/\.\.\/crypto\/(objects|kek|envelope|primitives)\.js$/,
  /^fastify$/,
  /^fastify-type-provider-zod$/,
  /^zod$/,
  /^kysely$/, // the sql tag only: it runs nothing by itself, every statement goes to the withPortalTx transaction
];
const CLIENT_TYPE_ONLY = [/^\.\.\/\.\.\/providers\/types\.js$/];

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('R-PORTAL-8 the portal boundary', () => {
  it('R-PORTAL-8: portal/client/** imports only the portal wrappers, core portal/foundation, shared, errors, crypto, fastify, zod and the sql tag', () => {
    const bad: string[] = [];
    for (const f of walk(join(here, 'client'))) {
      for (const i of importsOf(f)) {
        const ok = CLIENT_ALLOWED.some((r) => r.test(i.spec)) || (i.typeOnly && CLIENT_TYPE_ONLY.some((r) => r.test(i.spec)));
        if (!ok) bad.push(`${relative(here, f)}: ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('R-PORTAL-8: portal/signin/**, portal/staff/**, portal/sync/** and portal/shared/** never import portal/client/**; shared/** imports no database', () => {
    const bad: string[] = [];
    for (const dir of ['signin', 'staff', 'sync', 'shared']) {
      for (const f of walk(join(here, dir))) {
        for (const i of importsOf(f)) {
          if (/(^|\/)client\//.test(i.spec)) bad.push(`${relative(here, f)}: ${i.spec}`);
          if (dir === 'shared' && !i.typeOnly && /^@realty\/db|^kysely$|^pg$|\/comms\/|\/workspace\//.test(i.spec)) bad.push(`${relative(here, f)}: ${i.spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('R-PORTAL-8: lint runs portal/client/** in client mode and every other portal file in staff mode (eslint.config.js)', () => {
    const cfg = readFileSync(join(repo, 'eslint.config.js'), 'utf8');
    expect(cfg).toMatch(/files: \['apps\/api\/src\/portal\/client\/\*\*\/\*\.\{ts,tsx\}'\][\s\S]{0,120}mode: 'client'/);
    expect(cfg).toMatch(/ignores: \['packages\/db\/src\/portalTx\.ts', 'apps\/api\/src\/portal\/client\/\*\*'[\s\S]{0,120}mode: 'staff'/);
  });

  it('R-PORTAL-8: every /api/portal route is marked, every client route has the client guard, and no route outside the portal claims the marker', () => {
    const marked = portalRouteTable(h.app.platform);
    const urls = h.app.platform.routeTable.filter((r) => r.url === '/api/portal' || r.url.startsWith('/api/portal/'));
    expect(urls.length).toBeGreaterThan(0);
    for (const r of urls.filter((x) => x.method !== 'HEAD')) {
      const e = marked.find((m) => m.url === r.url && m.method === r.method);
      expect(e, `${r.method} ${r.url}`).toBeDefined();
      expect(r.auth, r.url).toBe('public');
      if (e!.portal === 'client') expect(e!.guarded, r.url).toBe(true);
    }
    expect(marked.filter((m) => m.portal === 'client').map((m) => `${m.method} ${m.url}`).sort()).toEqual([
      'GET /api/portal/documents', 'GET /api/portal/files/:token', 'GET /api/portal/me', 'GET /api/portal/timeline',
      'POST /api/portal/documents/:itemId/stream-token', 'POST /api/portal/logout',
    ]);
    expect(marked.filter((m) => m.portal === 'signin').map((m) => `${m.method} ${m.url}`).sort()).toEqual(['POST /api/portal/login', 'POST /api/portal/session']);
    const outside = walk(resolve(here, '..')).filter((f) => !f.startsWith(here) && /portal:\s*'(client|signin)'/.test(readFileSync(f, 'utf8')));
    expect(outside).toEqual([]);
    // staff routes of the module are ordinary Action routes under the staff guard
    for (const r of h.app.platform.routeTable.filter((x) => /\/portal(-items|-grants|-accounts)?(\/|$)/.test(x.url) && !x.url.startsWith('/api/portal/'))) {
      expect(r.auth, r.url).toMatch(/^portal\.(view|manage)$/);
      expect(r.authorizes, r.url).toBe(r.auth);
    }
  });

  it('R-PORTAL-8: a /api/portal route without its marker, not public, or a client route without the guard refuses to start', () => {
    const ok = { method: 'GET', url: '/api/portal/x', config: { auth: 'public', portal: 'client' }, preValidation: [clientGuard] } as never;
    expect(checkPortalRoute(ok)).toEqual([{ method: 'GET', url: '/api/portal/x', portal: 'client', guarded: true }]);
    expect(() => checkPortalRoute({ method: 'GET', url: '/api/portal/x', config: { auth: 'public' } } as never)).toThrow(/no config.portal marker/);
    expect(() => checkPortalRoute({ method: 'GET', url: '/api/portal/x', config: { auth: 'contact.view', portal: 'signin' } } as never)).toThrow(/must be config.auth 'public'/);
    expect(() => checkPortalRoute({ method: 'POST', url: '/api/portal/x', config: { auth: 'public', portal: 'client' } } as never)).toThrow(/lacks the client guard/);
    expect(checkPortalRoute({ method: 'HEAD', url: '/api/portal/x', config: {} } as never)).toEqual([]);
  });
});
