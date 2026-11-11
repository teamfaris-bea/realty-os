// The website chat widget as its own bundle (module 37): src/widget/main.ts → dist/widget/chat.js, one classic
// IIFE script a brokerage's site loads with the embed snippet (src/widget/config.ts). It shares no code with the
// staff app (lint: realty/isolated-bundle) and has a 30 kB gzip budget (src/widget/size.test.ts measures this
// exact production build). Run after the app build, which empties dist/: `vite build -c vite.widget.config.ts`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2019',
    outDir: resolve(here, 'dist/widget'),
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    lib: { entry: resolve(here, 'src/widget/main.ts'), formats: ['iife'], name: 'RealtyChat', fileName: () => 'chat.js' },
  },
});
