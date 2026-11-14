// @vitest-environment node
// module 46 (R-PORTALWEB-2, E717): `vite preview` (vite.config.ts realty-portal-preview) serves /portal.html, with any
// query, with portalSecurityHeaders and no-store; /portal, /portal/ and /portal.html/x are the staff app with the staff
// headers, as in nginx. The build refuses an HTML entry with no policy (cspTagFor).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type PreviewServer, build, preview } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portalSecurityHeaders, webSecurityHeaders } from '../../../security-headers.js';
import { cspTagFor } from '../../../vite.config.js';

const webRoot = resolve(__dirname, '../../..');
let out = '';
let server: PreviewServer;
let base = '';

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'portal-preview-'));
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), mode: 'production', logLevel: 'silent', build: { outDir: out, emptyOutDir: true, sourcemap: false } });
  } finally {
    process.env.NODE_ENV = env;
  }
  server = await preview({ root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out }, preview: { port: 0, host: '127.0.0.1', strictPort: false } });
  const addr = server.httpServer.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const headersOf = (r: Response) => Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
function expectSet(h: Record<string, string>, set: Readonly<Record<string, string>>) {
  for (const [k, v] of Object.entries(set)) expect(h[k.toLowerCase()], k).toBe(v);
}

describe('vite preview serves the portal like nginx (R-PORTALWEB-2)', () => {
  it('R-PORTALWEB-2: /portal.html and /portal.html?team=x get the portal header set, no-store and the portal page', async () => {
    for (const path of ['/portal.html', '/portal.html?team=harbor']) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(200);
      const h = headersOf(r);
      expectSet(h, portalSecurityHeaders);
      expect(h['cache-control']).toBe('no-store');
      const body = await r.text();
      expect(body).toContain('<title>Your client portal</title>');
      expect(body).toContain("form-action 'none'");
    }
    const head = await fetch(base + '/portal.html', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expectSet(headersOf(head), portalSecurityHeaders);
  });

  it('E717: /portal, /portal/ and / are the staff app with the staff headers; nothing else serves the portal', async () => {
    for (const path of ['/', '/portal', '/portal/', '/portal.html/x', '/login']) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(200);
      expectSet(headersOf(r), webSecurityHeaders);
      const body = await r.text();
      expect(body, path).toContain('<title>Realty OS</title>');
      expect(body, path).not.toContain('Your client portal');
    }
  });

  it('the build refuses an HTML entry with no policy of its own', () => {
    expect(cspTagFor(resolve(webRoot, 'portal.html'))).toContain("trusted-types 'none'");
    expect(cspTagFor(resolve(webRoot, 'index.html'))).not.toContain('trusted-types');
    expect(() => cspTagFor(resolve(webRoot, 'other.html'))).toThrow(/not a known HTML entry/);
    expect(() => cspTagFor(resolve(webRoot, 'src/portal.html'))).toThrow(/not a known HTML entry/);
  });
});
