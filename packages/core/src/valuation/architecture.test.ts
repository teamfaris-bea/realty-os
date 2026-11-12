// R-CMA-2 / R-PRED-4 import boundary of core/valuation. Comp selection reads only the strict input facts:
// no non-test file under core/valuation imports core/listings (V1-C maps listings to CmaSale, F10),
// core/predict (R-PRED-4: prediction never feeds pricing) or any contact module. The rule is an
// allowlist: a non-test file imports only its siblings in core/valuation and zod.
//
// The test reads files, so it loads node:fs through a dynamic import with a non-literal specifier and
// a local type (packages/core has no Node types; see coaching/architecture.test.ts).
import { describe, expect, it } from 'vitest';

interface FileUrl {
  readonly pathname: string;
}
const Url = (globalThis as unknown as { URL: new (path: string, base: string | FileUrl) => FileUrl }).URL;
interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
interface FsLike {
  readdirSync(p: FileUrl, o: { withFileTypes: true }): Dirent[];
  readFileSync(p: FileUrl, enc: 'utf8'): string;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;
const HERE = (import.meta as unknown as { url: string }).url;

function files(dir: FileUrl): FileUrl[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__snapshots__' ? [] : files(new Url(`${e.name}/`, dir));
    return e.isFile() && /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [new Url(e.name, dir)] : [];
  });
}

/** Every module specifier in `src`: static imports and exports, and dynamic import(). */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  return out;
}

/** Allowed: a sibling inside core/valuation ('./x.js', '../x.js' from testing/) and zod. */
function allowed(spec: string, fileDepth: number): boolean {
  if (spec === 'zod') return true;
  if (spec.startsWith('./')) return !spec.includes('/../');
  if (fileDepth === 1 && spec.startsWith('../')) return !spec.slice(3).includes('/');
  return false;
}

describe('R-CMA-2 R-PRED-4: core/valuation reads only its own facts', () => {
  it('the specifier check catches listings, predict and contact imports', () => {
    const src = [
      "import { addressKey } from '../listings/index.js';",
      "import type { Score } from '@realty/core/predict';",
      "const m = await import('../import/contacts.js');",
      "export * from '../ownership/index.js';",
      "import { z } from 'zod';",
      "import { screen } from './select.js';",
    ].join('\n');
    const specs = specifiers(src);
    expect(specs).toEqual(['../listings/index.js', '@realty/core/predict', '../import/contacts.js', '../ownership/index.js', 'zod', './select.js']);
    expect(specs.filter((s) => !allowed(s, 0))).toEqual(['../listings/index.js', '@realty/core/predict', '../import/contacts.js', '../ownership/index.js']);
  });

  it('R-CMA-2: no non-test file under core/valuation imports core/listings, core/predict or any contact module', () => {
    const root = new Url('./', HERE);
    const all = files(root);
    expect(all.length).toBeGreaterThanOrEqual(8);
    const offenders: string[] = [];
    for (const f of all) {
      const depth = f.pathname.slice(root.pathname.length).split('/').length - 1;
      for (const s of specifiers(fs.readFileSync(f, 'utf8'))) if (!allowed(s, depth)) offenders.push(`${f.pathname}: ${s}`);
    }
    expect(offenders).toEqual([]);
  });
});
