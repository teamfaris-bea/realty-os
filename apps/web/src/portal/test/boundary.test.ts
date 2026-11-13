// @vitest-environment node
// module 46 (R-PORTALWEB-1, R-PORTALWEB-9, R-PORTALWEB-10; E697): the trust boundary in the source, both ways.
//   - portal code names only /api/portal/ API paths, and never document.cookie, the staff cookie, /auth/, raw HTML
//     sinks, eval, sessionStorage, console or import.meta.env; localStorage only in link.ts (the team slug);
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
  ['import.meta.env', /import\.meta\.env/],
];

describe('the portal boundary in the source (R-PORTALWEB-1)', () => {
  it('the scan is not vacuous: it reads every portal file, the view and the staff app', () => {
    expect(PORTAL_FILES.length).toBeGreaterThan(15);
    expect(VIEW_FILES.map(rel)).toEqual(expect.arrayContaining(['portal/view/index.ts', 'portal/view/parse.ts', 'portal/view/components.tsx']));
    expect(STAFF_FILES.length).toBeGreaterThan(200);
    expect(stripComments("const a = '//x'; // gone\n/* gone */ const b = `/*y*/`;")).toBe("const a = '//x'; \n const b = `/*y*/`;");
    expect(importsOf("import { a } from './a.js';\nexport * from '../b.js';\nconst c = await import('./c.js');\nimport './d.css';")).toEqual(['./a.js', '../b.js', './c.js', './d.css']);
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
      for (const s of importsOf(src)) if (!(s === 'react' || s.startsWith('./'))) problems.push(`${rel(f)} imports ${s}`);
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
    expect(previewImports).toBeGreaterThanOrEqual(0); // > 0 once the staff preview exists (deliverable 7)
  });

  it('E697, R-PORTALWEB-9: no staff file names a client portal path (staff code never calls the client API)', () => {
    const problems: string[] = [];
    for (const f of STAFF_FILES) {
      const hit = /['"`](?:\/api)?\/portal\/[^'"`]*/.exec(code(f));
      if (hit) problems.push(`${rel(f)} names ${hit[0]}`);
    }
    expect(problems).toEqual([]);
  });
});
