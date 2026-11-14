// @vitest-environment node
// module 46 (R-PORTALWEB-1, R-PORTALWEB-2, R-PORTALWEB-11): the PRODUCTION build (vite.config.ts, both HTML entries) is
// read as a module graph. The portal's entry chunk is found from portal.html's own module script (cross-checked with
// isEntry and facadeModuleId), and its closure over `imports` and `dynamicImports` must hold only src/portal and the
// three allowed packages (react, react-dom with scheduler, @tanstack/react-query with query-core) and no portal test
// helper (src/portal/**/test/**, **/testing/**, *.test.*; b15 audit P46-SEC-1), no staff API path,
// staff cookie name, session call or env value; its CSS comes from portal.css only. The staff closure holds no
// src/portal module outside view/**. Each HTML file carries its own meta CSP before every script and stylesheet.
// Budgets: portal JS ≤ 100 kB and CSS ≤ 15 kB gzip. Re-run after every staging merge (VERIFY 7).
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type Rollup, build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { cspMetaTag, portalCspMetaTag } from '../../../security-headers.js';

const webRoot = resolve(__dirname, '../../..');
const portalDir = resolve(webRoot, 'src/portal') + sep;
const viewDir = resolve(webRoot, 'src/portal/view') + sep;
const JS_BUDGET = 100 * 1024;
const CSS_BUDGET = 15 * 1024;
const PACKAGES = new Set(['react', 'react-dom', 'scheduler', '@tanstack/react-query', '@tanstack/query-core']);

let files: (Rollup.OutputChunk | Rollup.OutputAsset)[] = [];
const chunk = (name: string) => files.find((f): f is Rollup.OutputChunk => f.type === 'chunk' && f.fileName === name);
const asset = (name: string) => files.find((f): f is Rollup.OutputAsset => f.type === 'asset' && f.fileName === name);
const html = (name: string) => String(asset(name)!.source);

/** The package a module id belongs to (pnpm: the segment after the last node_modules/), or null for source. */
export function packageOf(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = id.slice(at + '/node_modules/'.length).split('/');
  return rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
}

/** The chunk an HTML entry's module script names, and its static and dynamic closure. */
function closureOf(htmlName: string): Rollup.OutputChunk[] {
  const src = /<script type="module"[^>]*\ssrc="\/([^"]+)"/.exec(html(htmlName))?.[1];
  const entry = src ? chunk(src) : undefined;
  if (!entry) throw new Error(`${htmlName}: no module script chunk`);
  expect(entry.isEntry).toBe(true);
  expect(entry.facadeModuleId).toBe(resolve(webRoot, htmlName));
  const seen = new Map<string, Rollup.OutputChunk>();
  const walk = (c: Rollup.OutputChunk) => {
    if (seen.has(c.fileName)) return;
    seen.set(c.fileName, c);
    for (const n of [...c.imports, ...c.dynamicImports]) {
      const next = chunk(n);
      if (next) walk(next);
    }
  };
  walk(entry);
  return [...seen.values()];
}

beforeAll(async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const out = (await build({ root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), mode: 'production', logLevel: 'silent', build: { write: false, sourcemap: false } })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    files = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  } finally {
    process.env.NODE_ENV = before;
  }
}, 180_000);

describe('the client portal bundle (R-PORTALWEB-1)', () => {
  it('R-PORTALWEB-1: the portal closure holds only src/portal, react, react-dom, scheduler and TanStack Query (and bundler helpers)', () => {
    const ids = closureOf('portal.html').flatMap((c) => c.moduleIds);
    expect(ids.some((m) => m === resolve(webRoot, 'src/portal/main.tsx'))).toBe(true);
    const outside = ids.filter((m) => {
      if (m.startsWith('\0')) return false;
      if (m === resolve(webRoot, 'portal.html')) return false;
      const pkg = packageOf(m);
      if (pkg) return !PACKAGES.has(pkg);
      // b15 audit P46-SEC-1: a test helper under src/portal is not shipped code (lint and the source scans exempt it)
      return !m.startsWith(portalDir) || /(^|\/)(test|testing)\//.test(m.slice(portalDir.length)) || /\.test\.[cm]?[jt]sx?$/.test(m);
    });
    expect(outside).toEqual([]);
  });

  it('R-PORTALWEB-1: the portal code names no staff API path, staff cookie, session call or env value; its only API prefix is /api/portal/', () => {
    const code = closureOf('portal.html').map((c) => c.code).join('\n');
    expect(code).not.toContain('__Host-sid');
    expect(code).not.toContain('/auth/session');
    expect(code).not.toMatch(/VITE_[A-Z]/);
    const apis = [...code.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/]*)/g)].map((m) => m[1]!);
    expect(apis.length).toBeGreaterThan(0);
    expect(apis.filter((p) => !p.startsWith('/api/portal/'))).toEqual([]);
  });

  it('R-PORTALWEB-1: the portal CSS is portal.css only; the staff closure holds no src/portal module outside view/**', () => {
    const portal = asset(/<link rel="stylesheet"[^>]*href="\/([^"]+)"/.exec(html('portal.html'))![1]!)!;
    expect(portal.originalFileNames).toEqual(['portal.html']);
    expect(html('portal.html').match(/<link rel="stylesheet"/g)).toHaveLength(1);
    const staff = closureOf('index.html').flatMap((c) => c.moduleIds);
    expect(staff.filter((m) => m.startsWith(portalDir) && !m.startsWith(viewDir))).toEqual([]);
  });

  it('R-PORTALWEB-2: each HTML file carries its own meta CSP before every script and stylesheet', () => {
    for (const [name, tag] of [
      ['portal.html', portalCspMetaTag()],
      ['index.html', cspMetaTag()],
    ] as const) {
      const h = html(name);
      const at = h.indexOf(tag);
      expect(at, name).toBeGreaterThan(0);
      expect(h.match(/http-equiv="Content-Security-Policy"/g), name).toHaveLength(1);
      for (const m of h.matchAll(/<(script|link)\b/g)) expect(m.index!, `${name} ${m[0]}`).toBeGreaterThan(at);
    }
    expect(html('portal.html')).toContain('<meta name="referrer" content="same-origin" />');
    expect(html('portal.html')).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('R-PORTALWEB-11: the portal JS is at most 100 kB and its CSS at most 15 kB gzip', () => {
    const js = closureOf('portal.html').reduce((n, c) => n + gzipSync(c.code, { level: 9 }).length, 0);
    const cssName = /<link rel="stylesheet"[^>]*href="\/([^"]+)"/.exec(html('portal.html'))![1]!;
    const css = gzipSync(String(asset(cssName)!.source), { level: 9 }).length;
    console.info(`portal bundle: JS ${js} B gzip (budget ${JS_BUDGET}), CSS ${css} B gzip (budget ${CSS_BUDGET})`);
    expect(js).toBeLessThanOrEqual(JS_BUDGET);
    expect(css).toBeLessThanOrEqual(CSS_BUDGET);
  });

  it('portal.css keeps the staff design tokens: every token value in design/tokens.css is in portal.css', () => {
    const tokens = readFileSync(resolve(webRoot, 'src/design/tokens.css'), 'utf8');
    const portal = readFileSync(resolve(webRoot, 'src/portal/portal.css'), 'utf8');
    const decls = [...tokens.matchAll(/^\s*(--[a-z0-9-]+:\s*[^;]+;)/gm)].map((m) => m[1]!.replace(/\s+/g, ' '));
    expect(decls.length).toBeGreaterThan(30);
    const flat = portal.replace(/\s+/g, ' ');
    expect(decls.filter((d) => !flat.includes(d))).toEqual([]);
    expect(portal).not.toMatch(/@import\s+['"][^'"]*design\/tokens/);
  });
});
