import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { cspMetaTag, webSecurityHeaders } from './security-headers.js';
import { loadRootEnv } from '../../vitest.shared.js';

loadRootEnv();
const apiPort = Number(process.env.API_PORT ?? 3001);

// Build only: the CSP as a <meta> tag right after <meta charset>, before any script (security-headers.ts). Not applied to the dev
// server, whose React refresh preamble and CSS injection are inline.
const cspMeta: Plugin = {
  name: 'realty-csp-meta',
  apply: 'build',
  transformIndexHtml: { order: 'post', handler: (html) => html.replace(/<meta charset=[^>]*>/i, (m) => `${m}\n    ${cspMetaTag()}`) },
};

// The API serves every route under /api (docs/CONVENTIONS.md); in dev Vite proxies it so the
// session cookie is same-origin, exactly as in production.
export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta],
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
  build: { target: 'es2022', sourcemap: true },
});
