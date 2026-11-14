// @vitest-environment node
// module 46 (R-PORTALWEB-1, R-PORTALWEB-9, R-PORTALWEB-10; E717): the trust boundary in the source, both ways.
//   - portal code names only /api/portal/ API paths, and never document.cookie, the staff cookie, /auth/, raw HTML
//     sinks, eval, sessionStorage, console or import.meta (env, glob, url); localStorage only in link.ts (the team slug);
//   - shipped portal code imports no test helper (test/, testing/, *.test.*: exempt from lint and from these scans, so
//     a helper could carry staff code or an env value into the bundle) and no computed dynamic import (b15 audit P46-SEC-1);
//   - view/** (what staff code may import) imports only react and itself, and touches no window, document, fetch,
//     location or history;
//   - only surfaces/client-portal/** imports from src/portal, and only src/portal/view/index.ts;
//   - no staff file names a client portal path (/portal/…, /api/portal/…).
// ESLint (realty/isolated-bundle) polices the portal's own imports; this test polices the other direction, which a
// second no-restricted-imports block in eslint.config.js would not (it would replace the apps/web one).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');
const PORTAL = join(SRC, 'portal');
const VIEW_INDEX = join(PORTAL, 'view', 'index.ts');

const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /[\\/](test|testing)[\\/]/.test(f);
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return filesUnder(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(SRC, f).replaceAll('\\', '/');
const ALL = filesUnder(SRC).filter((f) => !isTest(f));
const PORTAL_FILES = ALL.filter((f) => f.startsWith(PORTAL + '/'));
const VIEW_FILES = PORTAL_FILES.filter((f) => f.startsWith(join(PORTAL, 'view') + '/'));
const STAFF_FILES = ALL.filter((f) => !f.startsWith(PORTAL + '/'));

/** Source without comments (strings and template literals kept). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (q) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === q) q = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      q = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Import specifiers: static, re-export, side-effect, dynamic and type imports. */
export function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"`;]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|import\s+['"]([^'"]+)['"]/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** b15 audit P46-SEC-1: whether a relative specifier from `file` names test code (a test/ or testing/ directory, or a .test file). */
export function intoTestCode(file: string, spec: string): boolean {
  if (!spec.startsWith('.')) return false;
  const to = relative(SRC, resolve(dirname(file), spec)).replaceAll('\\', '/');
  return /(^|\/)(test|testing)(\/|$)/.test(to) || /\.test\.[cm]?[jt]sx?$/.test(to);
}

/** b15 audit P46-TEST-1: whether a view/** file's import stays inside view/ once resolved ('./../link.js' does not), or is react. */
export function viewImportOk(file: string, spec: string): boolean {
  if (spec === 'react') return true;
  if (!spec.startsWith('.')) return false;
  const to = resolve(dirname(file), spec);
  const view = join(PORTAL, 'view');
  return to === view || to.startsWith(view + '/');
}

/** b15 audit P46-SEC-1: a dynamic import whose module is not a plain string (a computed specifier no scan can read). */
export const computedImport = (src: string): boolean => /\bimport\s*\((?!\s*(?:'[^'\n]*'|"[^"\n]*"|`[^`$]*`)\s*[,)])/.test(src);

const code = (f: string) => stripComments(readFileSync(f, 'utf8'));
const FORBIDDEN: [string, RegExp][] = [
  ['document.cookie', /document\s*\.\s*cookie/],
  ['the staff cookie', /__Host-sid/],
  ['an /auth/ path', /['"`]\/(?:api\/)?auth\//],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['innerHTML', /\b(?:inner|outer)HTML\b/],
  ['eval', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['console', /\bconsole\s*\./],
  ['import.meta (env, glob or url)', /import\.meta\b/],
];

describe('the portal boundary in the source (R-PORTALWEB-1)', () => {
  it('the scan is not vacuous: it reads every portal file, the view and the staff app', () => {
    expect(PORTAL_FILES.length).toBeGreaterThan(15);
    expect(VIEW_FILES.map(rel)).toEqual(expect.arrayContaining(['portal/view/index.ts', 'portal/view/parse.ts', 'portal/view/components.tsx']));
    expect(STAFF_FILES.length).toBeGreaterThan(200);
    expect(stripComments("const a = '//x'; // gone\n/* gone */ const b = `/*y*/`;")).toBe("const a = '//x'; \n const b = `/*y*/`;");
    expect(importsOf("import { a } from './a.js';\nexport * from '../b.js';\nconst c = await import('./c.js');\nimport './d.css';")).toEqual(['./a.js', '../b.js', './c.js', './d.css']);
    // b15 audit P46-SEC-1: the test-helper and computed-import checks catch what they must, and only that
    const api = join(PORTAL, 'api.ts');
    const home = join(PORTAL, 'screens', 'Home.tsx');
    expect(['./test/fixtures.js', './testing/x.js', './link.test.js', './view/../test/render.js'].map((s) => intoTestCode(api, s))).toEqual([true, true, true, true]);
    expect([intoTestCode(home, '../test/fixtures.js'), intoTestCode(home, './test'), intoTestCode(api, './testids.js'), intoTestCode(api, './contest/x.js'), intoTestCode(api, './view/index.js'), intoTestCode(api, 'react')]).toEqual([true, true, false, false, false, false]);
    expect(['import(name)', 'import(`./${n}.js`)', "import('./a' + b)", 'import (x)'].map(computedImport)).toEqual([true, true, true, true]);
    // b15 audit P46-TEST-1: a view import is resolved, so './../x' (which leaves view/) is caught
    const parse = join(PORTAL, 'view', 'parse.ts');
    expect(['./../link.js', '../api.js', './x/../../copy.js', 'react-dom', '@tanstack/react-query'].map((s) => viewImportOk(parse, s))).toEqual([false, false, false, false, false]);
    expect(['react', './words.js', './x/../dates.js', '.'].map((s) => viewImportOk(parse, s))).toEqual([true, true, true, true]);
    expect(["import('./a.js')", 'import("./a.js")', 'import(`./a.js`)', "import('./a.js', { with: {} })", "import { a } from './a.js'", 'imported(x)'].map(computedImport)).toEqual([false, false, false, false, false, false]);
  });

  it('b15 audit P46-SEC-1: shipped portal code imports no test helper (test/, testing/, *.test.*) and no computed module', () => {
    const problems: string[] = [];
    for (const f of PORTAL_FILES) {
      const src = code(f);
      for (const s of importsOf(src)) if (intoTestCode(f, s)) problems.push(`${rel(f)} imports test code ${s}`);
      if (computedImport(src)) problems.push(`${rel(f)} has a computed dynamic import`);
    }
    expect(problems).toEqual([]);
  });

  it('R-PORTALWEB-1, R-PORTALWEB-9: portal code names only /api/portal/ API paths and no staff cookie, auth path, raw HTML sink, eval, sessionStorage, console or env', () => {
    const problems: string[] = [];
    for (const f of PORTAL_FILES) {
      const src = code(f);
      for (const m of src.matchAll(/['"`](\/api\/[^'"`]*)/g)) if (!m[1]!.startsWith('/api/portal/')) problems.push(`${rel(f)} names ${m[1]}`);
      for (const [what, re] of FORBIDDEN) if (re.test(src)) problems.push(`${rel(f)} uses ${what}`);
      if (/\blocalStorage\b/.test(src) && rel(f) !== 'portal/link.ts') problems.push(`${rel(f)} uses localStorage`);
    }
    expect(problems).toEqual([]);
  });

  it('R-PORTALWEB-1: view/** imports only react and itself, and touches no window, document, fetch, location or history', () => {
    const problems: string[] = [];
    for (const f of VIEW_FILES) {
      const src = code(f);
      const bare = src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
      for (const s of importsOf(src)) if (!viewImportOk(f, s)) problems.push(`${rel(f)} imports ${s}`);
      for (const g of ['window', 'document', 'fetch', 'location', 'history', 'localStorage', 'globalThis']) if (new RegExp(`(?<![.\\w])${g}\\b`).test(bare)) problems.push(`${rel(f)} touches ${g}`);
    }
    expect(problems).toEqual([]);
  });

  it('R-PORTALWEB-10: only surfaces/client-portal/** imports from src/portal, and only src/portal/view/index.ts', () => {
    const problems: string[] = [];
    let previewImports = 0;
    for (const f of STAFF_FILES) {
      for (const s of importsOf(code(f))) {
        const to = s.startsWith('.') ? resolve(dirname(f), s) : null;
        const intoPortal = to ? to === PORTAL || to.startsWith(PORTAL + '/') : /(^|\/)portal(\/|$)/.test(s) && !s.startsWith('@tanstack');
        if (!intoPortal) continue;
        const ok = rel(f).startsWith('surfaces/client-portal/') && to !== null && to.replace(/\.js$/, '.ts') === VIEW_INDEX;
        if (ok) previewImports += 1;
        else problems.push(`${rel(f)} imports ${s}`);
      }
    }
    expect(problems).toEqual([]);
    expect(previewImports).toBeGreaterThan(0);
  });

  it('E717, R-PORTALWEB-9: no staff file names a client portal path (staff code never calls the client API)', () => {
    const problems: string[] = [];
    for (const f of STAFF_FILES) {
      const hit = /['"`](?:\/api)?\/portal\/[^'"`]*/.exec(code(f));
      if (hit) problems.push(`${rel(f)} names ${hit[0]}`);
    }
    expect(problems).toEqual([]);
  });
});
