// R-COACH-5 architecture test: call scores never feed routing, ownership, prediction, the scoreboard
// or any automatic consequence. No source file under the routing/ownership/priority (feed and
// scoreboard)/prediction code may import anything coaching ('core/coaching', '../coaching/',
// '@realty/core/coaching', the api coaching module).
//
// This test reads files, so it needs node:fs. packages/core is pure: its tsconfig has no Node types
// and lint forbids runtime Node imports. The test therefore loads node:fs through a dynamic import
// with a non-literal specifier and a minimal local type: test-only, never shipped (tests are
// excluded from the build), and the purity rules for runtime code stay untouched.
import { describe, expect, it } from 'vitest';

// Node's WHATWG URL (not in core's lib types either); fs accepts it as a path.
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
  existsSync(p: FileUrl): boolean;
  readdirSync(p: FileUrl, o: { withFileTypes: true }): Dirent[];
  readFileSync(p: FileUrl, enc: 'utf8'): string;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;

const HERE = (import.meta as unknown as { url: string }).url;
const repo = (rel: string) => new Url(`../../../../${rel}`, HERE);

/** Directories R-COACH-5 protects (those that do not exist yet are skipped). */
const GUARDED = [
  'packages/core/src/ownership/',
  'packages/core/src/priority/',
  'packages/core/src/predict/',
  'apps/api/src/leads/',
  'apps/api/src/ownership/',
  'apps/api/src/accountability/',
  'apps/api/src/predict/',
];

function tsFiles(dir: FileUrl): FileUrl[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__snapshots__' ? [] : tsFiles(new Url(`${e.name}/`, dir));
    return e.isFile() && /\.tsx?$/.test(e.name) ? [new Url(e.name, dir)] : [];
  });
}

/** Every module specifier in `src`: static imports/exports and dynamic import(). */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  return out;
}

const COACHING = /(^|[/@])coaching(\/|\.js$|$)/;

describe('R-COACH-5 call scores never reach routing, ownership, prediction or the scoreboard', () => {
  it('the specifier check catches every way of importing coaching', () => {
    const src = [
      "import { dailyFix } from '@realty/core/coaching';",
      "import type { CallScore } from '../coaching/index.js';",
      "export * from '../../coaching/types.js';",
      "const m = await import('../coaching/index.js');",
      "import '../coaching';",
      "import { x } from './coachingless.js';",
    ].join('\n');
    expect(specifiers(src).filter((s) => COACHING.test(s))).toEqual(['@realty/core/coaching', '../coaching/index.js', '../../coaching/types.js', '../coaching/index.js', '../coaching']);
  });

  it('R-COACH-5: no file under ownership, priority, leads, accountability or predict imports coaching', () => {
    const present = GUARDED.filter((d) => fs.existsSync(repo(d)));
    // the core routing/feed modules exist today; the test must not pass vacuously
    expect(present).toEqual(expect.arrayContaining(['packages/core/src/ownership/', 'packages/core/src/priority/', 'apps/api/src/leads/']));
    const offenders: string[] = [];
    let scanned = 0;
    for (const d of present) {
      for (const f of tsFiles(repo(d))) {
        scanned += 1;
        const bad = specifiers(fs.readFileSync(f, 'utf8')).filter((s) => COACHING.test(s));
        if (bad.length > 0) offenders.push(`${f.pathname}: ${bad.join(', ')}`);
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
