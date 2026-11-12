// Architecture test for core/isa (R-PRED-4, R-GMAIL-14, R-ISA-20; docs/AI_ISA.md §6.1, §7.1): nothing core/isa
// reaches, directly or transitively, is core/predict, core/coaching, a mail-sync module or anything under apps/**,
// and core/ownership is reachable only for types (the AI ISA never changes ownership, R-OWN-21). It also proves the
// module is pure: no clock, no randomness, no I/O in its sources.
//
// Like voice/architecture.test.ts, it loads node:fs through a dynamic import with a non-literal specifier.
import { describe, expect, it } from 'vitest';

interface FileUrl {
  readonly pathname: string;
  readonly href: string;
}
const Url = (globalThis as unknown as { URL: new (path: string, base: string | FileUrl) => FileUrl }).URL;
interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
interface FsLike {
  readdirSync(p: FileUrl, o: { withFileTypes: true }): Dirent[];
  readFileSync(p: FileUrl | string, enc: 'utf8'): string;
  existsSync(p: string): boolean;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;
const HERE = new Url('./', (import.meta as unknown as { url: string }).url);

function tsFiles(dir: FileUrl, tests: boolean): FileUrl[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return tests || e.name !== 'testing' ? tsFiles(new Url(`${e.name}/`, dir), tests) : [];
    if (!e.isFile() || !/\.ts$/.test(e.name) || e.name === 'architecture.test.ts') return [];
    if (!tests && /\.test\.ts$/.test(e.name)) return [];
    return [new Url(e.name, dir)];
  });
}

function statements(src: string): { spec: string; typeOnly: boolean; text: string }[] {
  const out: { spec: string; typeOnly: boolean; text: string }[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const head = m[2] as string;
    const named = /^\{([\s\S]*)\}$/.exec(head.trim());
    const allInlineTypes = named !== null && (named[1] as string).split(',').map((x) => x.trim()).filter((x) => x !== '').every((x) => x.startsWith('type '));
    out.push({ spec: m[3] as string, typeOnly: head.startsWith('type ') || allInlineTypes, text: m[0].trim() });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1] as string, typeOnly: false, text: m[0] });
  return out;
}

const FORBIDDEN = /(^|[/@])(predict|coaching|mailSync|mail_sync|apps)(\/|\.js$|$)|^@realty\/(api|web|db)\b/;
const OWNERSHIP = /(^|\/)ownership(\/|\.js$|$)/;

/** The runtime import closure of core/isa's sources inside packages/core/src (type-only imports excluded). */
function closure(): Map<string, { spec: string; text: string }[]> {
  const seen = new Map<string, { spec: string; text: string }[]>();
  const queue = tsFiles(HERE, false).map((f) => f.href);
  while (queue.length > 0) {
    const href = queue.pop() as string;
    if (seen.has(href)) continue;
    const src = fs.readFileSync(new Url(href, HERE), 'utf8');
    const runtime = statements(src).filter((s) => !s.typeOnly);
    seen.set(href, runtime);
    for (const s of runtime) {
      if (!s.spec.startsWith('.')) continue;
      const target = new Url(s.spec.replace(/\.js$/, '.ts'), new Url(href, HERE));
      if (fs.existsSync(target.pathname)) queue.push(target.href);
    }
  }
  return seen;
}

describe('core/isa architecture', () => {
  it('the scanner sees every form', () => {
    const s = statements(["import { x } from '../predict/index.js';", "import type { Y } from '../ownership/index.js';", "export * from '../../apps/api/src/x.js';", "const m = await import('../mailSync/index.js');"].join('\n'));
    expect(s.filter((x) => FORBIDDEN.test(x.spec))).toHaveLength(3);
    expect(s.filter((x) => OWNERSHIP.test(x.spec)).map((x) => x.typeOnly)).toEqual([true]);
  });
  it('R-PRED-4 R-GMAIL-14 no file core/isa reaches imports predict, coaching, mail sync or apps/**', () => {
    const c = closure();
    expect(c.size).toBeGreaterThan(20);
    const bad = [...c.entries()].flatMap(([f, ss]) => ss.filter((s) => FORBIDDEN.test(s.spec)).map((s) => `${f}: ${s.text}`));
    expect(bad).toEqual([]);
  });
  it('R-OWN-21 core/isa reaches core/ownership for types only', () => {
    const bad = [...closure().entries()].flatMap(([f, ss]) => (/\/isa\//.test(f) ? ss.filter((s) => OWNERSHIP.test(s.spec)).map((s) => `${f}: ${s.text}`) : []));
    expect(bad).toEqual([]);
  });
  it('core/isa is pure: no clock, no randomness, no I/O in its sources', () => {
    const files = tsFiles(HERE, false);
    expect(files.length).toBeGreaterThan(15);
    const bad = files.flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return [/\bDate\.now\(/, /\bnew Date\(\s*\)/, /Math\.random/, /\bfetch\(/, /process\.env/, /\bsetTimeout\(/, /DateTime\.now\(/].filter((re) => re.test(src)).map((re) => `${f.pathname}: ${re}`);
    });
    expect(bad).toEqual([]);
  });
  it('the test files of core/isa never import a real model provider', () => {
    const bad = tsFiles(HERE, true).flatMap((f) => statements(fs.readFileSync(f, 'utf8')).filter((s) => /anthropic|providers/.test(s.spec)).map((s) => `${f.pathname}: ${s.text}`));
    expect(bad).toEqual([]);
  });
});
