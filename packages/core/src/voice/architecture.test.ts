// Architecture test for core/voice (R-VOICE-6, R-GATE-9, R-PRED-4, R-COACH-5): nothing in core/voice
// imports core/predict or core/coaching (a prediction band or a call score can never decide who is hot,
// who is transferred or what is said), and core/ownership is imported for TYPES only (voice answering
// never changes ownership: no ownership command or engine function is reachable from here).
//
// Like coaching/architecture.test.ts, it loads node:fs through a dynamic import with a non-literal
// specifier (packages/core is pure; tests are excluded from the build).
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
const HERE = new Url('./', (import.meta as unknown as { url: string }).url);

function tsFiles(dir: FileUrl): FileUrl[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__snapshots__' ? [] : tsFiles(new Url(`${e.name}/`, dir));
    // this file quotes forbidden imports as scanner fixtures
    return e.isFile() && /\.ts$/.test(e.name) && e.name !== 'architecture.test.ts' ? [new Url(e.name, dir)] : [];
  });
}

/** Every import/export statement with its specifier and whether it is type-only. */
function statements(src: string): { spec: string; typeOnly: boolean; text: string }[] {
  const out: { spec: string; typeOnly: boolean; text: string }[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const head = m[2] as string;
    const named = /^\{([\s\S]*)\}$/.exec(head.trim());
    const allInlineTypes = named !== null && (named[1] as string).split(',').map((x) => x.trim()).filter((x) => x !== '').every((x) => x.startsWith('type '));
    out.push({ spec: m[3] as string, typeOnly: head.startsWith('type ') || allInlineTypes, text: m[0].trim() });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1] as string, typeOnly: false, text: m[0] });
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1] as string, typeOnly: false, text: m[0].trim() });
  return out;
}

const PREDICT_OR_COACHING = /(^|[/@])(predict|coaching)(\/|\.js$|$)/;
const OWNERSHIP = /(^|[/@])ownership(\/|\.js$|$)/;

describe('core/voice architecture', () => {
  it('the statement scanner sees every form', () => {
    const src = [
      "import { score } from '../predict/index.js';",
      "import type { CallScore } from '@realty/core/coaching';",
      "import { type MemberFacts } from '../ownership/index.js';",
      "import { type MemberFacts, applyOwnershipCommand } from '../ownership/index.js';",
      "export * from '../ownership/index.js';",
      "const m = await import('../coaching/index.js');",
    ].join('\n');
    const s = statements(src);
    expect(s.filter((x) => PREDICT_OR_COACHING.test(x.spec))).toHaveLength(3);
    expect(s.filter((x) => OWNERSHIP.test(x.spec)).map((x) => x.typeOnly)).toEqual([true, false, false]);
  });

  it('R-PRED-4 R-COACH-5 nothing in core/voice imports core/predict or core/coaching', () => {
    const files = tsFiles(HERE);
    expect(files.length).toBeGreaterThan(10);
    const bad = files.flatMap((f) => statements(fs.readFileSync(f, 'utf8')).filter((x) => PREDICT_OR_COACHING.test(x.spec)).map((x) => `${f.pathname}: ${x.text}`));
    expect(bad).toEqual([]);
  });

  it('R-VOICE-6 R-GATE-9 core/voice imports only types from core/ownership (it never changes ownership)', () => {
    const files = tsFiles(HERE);
    const uses = files.flatMap((f) => statements(fs.readFileSync(f, 'utf8')).filter((x) => OWNERSHIP.test(x.spec)).map((x) => ({ f: f.pathname, ...x })));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !u.typeOnly).map((u) => `${u.f}: ${u.text}`)).toEqual([]);
  });
});
