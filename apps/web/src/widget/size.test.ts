// @vitest-environment node
// Module 37: the chat widget bundle's size budget, measured on the PRODUCTION build (vite.widget.config.ts,
// minified, exactly what `pnpm --filter @realty/web build` writes to dist/widget/chat.js), at most 30 kB gzip.
// It is one file, and it carries none of the staff app (no React, no router, no query client, no shell).
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type Rollup, build } from 'vite';
import { describe, expect, it } from 'vitest';

const BUDGET = 30 * 1024;
const webRoot = resolve(__dirname, '../..');

describe('chat widget bundle (module 37)', () => {
  it('the production build is one script of at most 30 kB gzip, with nothing of the staff app in it', async () => {
    const out = (await build({ configFile: resolve(webRoot, 'vite.widget.config.ts'), logLevel: 'silent', build: { write: false } })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const files = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    const chunks = files.filter((f): f is Rollup.OutputChunk => f.type === 'chunk');
    expect(chunks.map((c) => c.fileName)).toEqual(['chat.js']);
    expect(files.filter((f) => f.type === 'asset')).toEqual([]);
    const code = chunks[0]!.code;
    const gz = gzipSync(code, { level: 9 }).length;
    expect(gz).toBeLessThanOrEqual(BUDGET);
    // the bundle is the widget only
    expect(code).not.toMatch(/react|__SECRET_INTERNALS|QueryClient|createBrowserRouter|tanstack/i);
    expect(code).toContain('/public/chat/');
    console.info(`widget bundle: ${code.length} B minified, ${gz} B gzip (budget ${BUDGET} B)`);
  }, 60_000);
});
