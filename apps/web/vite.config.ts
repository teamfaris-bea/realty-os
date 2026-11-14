import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig } from 'vite';
import { cspMetaTag, portalCspMetaTag, portalSecurityHeaders, webSecurityHeaders } from './security-headers.js';
import { loadRootEnv } from '../../vitest.shared.js';

loadRootEnv();
const apiPort = Number(process.env.API_PORT ?? 3001);

// Build only: the CSP as a <meta> tag right after <meta charset>, before any script (security-headers.ts). Not applied to the dev
// server, whose React refresh preamble and CSS injection are inline.
// module 46: each HTML entry gets its own policy (index.html the staff one, portal.html the portal one); any other HTML
// file fails the build, so a later entry must register its policy here first.
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const CSP_FOR_ENTRY: Record<string, () => string> = { 'index.html': cspMetaTag, 'portal.html': portalCspMetaTag };
export function cspTagFor(filename: string): string {
  const name = basename(filename);
  const tag = CSP_FOR_ENTRY[name];
  if (!tag || resolve(webRoot, name) !== resolve(filename)) throw new Error(`realty-csp-meta: ${filename} is not a known HTML entry; give it a policy in vite.config.ts first (module 46)`);
  return tag();
}
const cspMeta: Plugin = {
  name: 'realty-csp-meta',
  apply: 'build',
  transformIndexHtml: { order: 'post', handler: (html, ctx) => html.replace(/<meta charset=[^>]*>/i, (m) => `${m}\n    ${cspTagFor(ctx.filename)}`) },
};

// module 46 (R-PORTALWEB-2): `vite preview` serves /portal.html (any query) itself, with portalSecurityHeaders and
// no-store, before Vite's static middleware (which would send the staff headers); /portal is the staff app, as in
// nginx (Vite's HTML fallback would otherwise rewrite /portal to /portal.html). Dev keeps no CSP (SECURITY.md).
export const portalPreview: Plugin = {
  name: 'realty-portal-preview',
  // the dev server too: /portal is the staff app (Vite's HTML fallback would serve portal.html for it)
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if ((req.url ?? '/').split('?')[0] === '/portal') req.url = '/index.html';
      next();
    });
  },
  configurePreviewServer(server) {
    const outDir = resolve(server.config.root, server.config.build.outDir);
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? '/').split('?')[0]!;
      if (pathname === '/portal') {
        req.url = '/index.html';
        return next();
      }
      if (pathname !== '/portal.html' || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
      const file = resolve(outDir, 'portal.html');
      let html: Buffer;
      try {
        if (!statSync(file).isFile()) return next();
        html = readFileSync(file);
      } catch {
        return next();
      }
      for (const [k, v] of Object.entries(portalSecurityHeaders)) res.setHeader(k, v);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', String(html.length));
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? undefined : html);
    });
  },
};

// The API serves every route under /api (docs/CONVENTIONS.md); in dev Vite proxies it so the
// session cookie is same-origin, exactly as in production.
export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta, portalPreview],
  resolve: {
    conditions: ['@realty/source', 'module', 'browser', 'development|production'],
  },
  server: {
    port: 5173,
    strictPort: true,
    // GitHub Codespaces serves the dev server at <name>-5173.app.github.dev.
    allowedHosts: process.env.CODESPACES ? [`.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev'}`] : undefined,
    // /p: module 29's public listing pages, served by the API outside /api (as deploy/nginx.conf proxies them)
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false }, '/p/': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  // `vite preview` serves the production build with the same headers a deployed server must send
  preview: { headers: { ...webSecurityHeaders } },
  build: {
    target: 'es2022',
    sourcemap: true,
    // module 46: two HTML entries, the staff app and the client portal (a separate bundle, R-PORTALWEB-1)
    rolldownOptions: { input: { app: resolve(webRoot, 'index.html'), portal: resolve(webRoot, 'portal.html') } },
  },
});
