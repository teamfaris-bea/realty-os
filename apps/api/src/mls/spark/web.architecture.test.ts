// No web code path reads the Spark token back (docs/SECURITY.md "Spark MLS (read-only)"): the browser sends it
// once, from the form's own input, and no response shape, store or property read in apps/web carries it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../../../web/src', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !p.includes(`${'/'}testing${'/'}`) ? [p] : [];
  });
}
const SOURCES = files(WEB).map((p) => ({ rel: relative(WEB, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));

describe('apps/web never reads the Spark token', () => {
  it('only the Connect MLS form mentions accessToken, and nothing reads it as a property (no response field, store or cache)', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.filter((f) => /accessToken/.test(f.text)).map((f) => f.rel)).toEqual(['surfaces/integrations/mls/SparkPage.tsx']);
    const reads = SOURCES.filter((f) => /\.\s*accessToken\b|\[\s*['"`]accessToken['"`]\s*\]/.test(f.text)).map((f) => f.rel);
    expect(reads).toEqual([]);
  });

  it('the Spark page reads the token only from its own input and persists nothing to browser storage', () => {
    const page = SOURCES.find((f) => f.rel === 'surfaces/integrations/mls/SparkPage.tsx')!.text;
    expect(page).toMatch(/const accessToken = input\.value/);
    for (const f of SOURCES.filter((x) => x.rel.startsWith('surfaces/integrations/'))) {
      expect(f.text, f.rel).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.(log|info|debug|warn|error)/);
    }
    const shapes = SOURCES.find((f) => f.rel === 'surfaces/integrations/mls/types.ts')!.text;
    const code = shapes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/token/i); // no response shape has a token field (comments aside)
  });
});
