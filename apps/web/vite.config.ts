import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { loadRootEnv } from '../../vitest.shared.js';

loadRootEnv();
const apiPort = Number(process.env.API_PORT ?? 3001);

// The API serves every route under /api (docs/CONVENTIONS.md); in dev Vite proxies it so the
// session cookie is same-origin, exactly as in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@realty/source', 'module', 'browser', 'development|production'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  build: { target: 'es2022', sourcemap: true },
});
