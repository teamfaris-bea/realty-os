// @vitest-environment node
// R-STAFF-10 (module 55), as a source scan over every staff screen file module 55 owns: the surfaces voice, ads,
// documents, likely, gbp and coaching-trends, and its five Approvals cards. None imports src/portal (or any module
// named portal) and none names a portal route, client (/portal/…, /api/portal/…) or staff (/portal-accounts,
// /portal-grants, /portal-items: module 46's screens, not these). The scan is not vacuous: every folder and card is
// read, and the patterns fire on the forms they must catch. Batch 14 audit T1 (the scan covered documents only).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTAL_DIR = join(SRC, 'portal');
const SURFACES = ['voice', 'ads', 'documents', 'likely', 'gbp', 'coaching-trends'];
const APPROVALS = ['Phase3Approvals.tsx', 'AdShiftApproval.tsx', 'ReviewReplyApproval.tsx', 'ExtractionPointers.tsx', 'VoiceHandback.tsx'];

const isTest = (f: string) => /\.test\.tsx?$/.test(f);
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return filesUnder(p);
    return /\.tsx?$/.test(n) && !isTest(n) ? [p] : [];
  });
}
const OWNED = [...SURFACES.flatMap((d) => filesUnder(join(SRC, 'surfaces', d))), ...APPROVALS.map((f) => join(SRC, 'surfaces', 'approvals', f))];
const rel = (f: string) => relative(SRC, f).replaceAll('\\', '/');

/** Import specifiers: static, re-export, side-effect, dynamic and type imports. */
function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"`;]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|import\s+['"]([^'"]+)['"]/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
/** An import into src/portal, or of any module named portal (an alias or a package path). */
function portalImport(file: string, spec: string): boolean {
  if (spec.startsWith('.')) {
    const to = resolve(dirname(file), spec);
    return to === PORTAL_DIR || to.startsWith(PORTAL_DIR + '/') || /(^|\/)portal(\/|\.|$)/.test(relative(SRC, to).replaceAll('\\', '/'));
  }
  return /(^|\/)portal(\/|\.|$)/.test(spec);
}
/** A quoted path that names a portal route: /portal…, /api/portal…, /portal-grants…, in any quote or a template. */
const PORTAL_ROUTE = /['"`](?:https?:\/\/[^'"`/]*)?(?:\/api)?\/portal(?:\b|-)/;

describe('R-STAFF-10: staff screens never import src/portal or name a portal route', () => {
  it('the scan reads every module 55 surface folder and Approvals card', () => {
    for (const d of SURFACES) expect(OWNED.filter((f) => rel(f).startsWith(`surfaces/${d}/`)).length, d).toBeGreaterThan(1);
    for (const f of APPROVALS) expect(statSync(join(SRC, 'surfaces', 'approvals', f)).isFile(), f).toBe(true);
    expect(OWNED.length).toBeGreaterThan(40);
  });

  it('the patterns fire on the forms they must catch, and not on ordinary staff paths', () => {
    const f = join(SRC, 'surfaces', 'documents', 'x.ts');
    for (const s of ['../../portal/client.js', '../../portal', '@realty/web/portal', '../portal/index.js']) expect(portalImport(f, s), s).toBe(true);
    for (const s of ['../../shell/index.js', './words.js', '../admin/integrations/words.js']) expect(portalImport(f, s), s).toBe(false);
    expect(importsOf("import { x } from '../../portal/a.js';\nconst m = await import('../../portal/b.js');\nexport * from '../../portal/c.js';\nimport '../../portal/d.js';")).toEqual(['../../portal/a.js', '../../portal/b.js', '../../portal/c.js', '../../portal/d.js']);
    for (const s of ["api.get('/portal/session')", 'fetch("/api/portal/documents")', 'api.post(`/portal-grants/${id}/revoke`)', "'/portal-items/preview'", "'https://app.example.test/portal/me'"]) expect(s, s).toMatch(PORTAL_ROUTE);
    for (const s of ["api.get('/documents/extractions')", "'/likely'", "'/gbp/reviews'", 'the client portal is module 45']) expect(s, s).not.toMatch(PORTAL_ROUTE);
  });

  it('no module 55 screen file imports src/portal or names a portal route', () => {
    const offenders: string[] = [];
    for (const f of OWNED) {
      const src = readFileSync(f, 'utf8');
      for (const s of importsOf(src)) if (portalImport(f, s)) offenders.push(`${rel(f)} imports ${s}`);
      const hit = src.match(PORTAL_ROUTE);
      if (hit) offenders.push(`${rel(f)} names ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
