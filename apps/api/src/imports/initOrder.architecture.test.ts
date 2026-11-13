// Module init order of api/imports (batch 13 integration, ISA-4 audit F3 note): imports/handlers.ts builds its job
// handlers at module load from imports/commit.ts's COMMIT_JOB, so neither file may sit on a static import cycle. Batch
// 13 had made one: imports/commit.ts → comms/recordings.ts → comms/dial.ts → isa/ingest.ts → isa/controls.ts →
// isa/seller/index.ts → isa/seller/cmaSeam.ts → cma/deps.ts → comms/index.ts (the barrel) → comms/routes.ts →
// imports/routes.ts → imports/commit.ts, so loading imports/commit.ts first (commit.test.ts) read COMMIT_JOB before it
// was defined ("Cannot read properties of undefined (reading 'kind')"). cma/deps.ts now imports the comms modules it
// uses, not the barrel. This test scans the real files so the cycle cannot come back unseen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const SOURCES = new Map(files(SRC).map((p) => [relative(SRC, p).replaceAll('\\', '/'), readFileSync(p, 'utf8')]));

/** Imports evaluated at load: static imports and re-exports that are not `import type`, and side-effect imports. */
function loadImports(rel: string, text: string): string[] {
  const specs = [
    ...[...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => m[1]!),
    ...[...text.matchAll(/^\s*import\s+'(\.[^']+)'/gm)].map((m) => m[1]!),
  ];
  return [...new Set(specs.map((s) => normalize(join(dirname(rel), s)).replaceAll('\\', '/').replace(/\.js$/, '.ts')))].filter((t) => SOURCES.has(t));
}
const GRAPH = new Map([...SOURCES].map(([rel, text]) => [rel, loadImports(rel, text)]));

/** The shortest load-import cycle through `start`, as a readable chain, or null. */
function cycleThrough(start: string, graph: ReadonlyMap<string, readonly string[]> = GRAPH): string | null {
  const prev = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const r = queue.shift()!;
    for (const t of graph.get(r) ?? []) {
      if (t === start) {
        const chain = [r];
        while (chain[0] !== start) chain.unshift(prev.get(chain[0]!)!);
        return [...chain, start].join(' → ');
      }
      if (prev.has(t)) continue;
      prev.set(t, r);
      queue.push(t);
    }
  }
  return null;
}

describe('api/imports module init order', () => {
  it('R-IMPORT-4: imports/commit.ts and imports/handlers.ts (COMMIT_JOB read at load) are on no import cycle, nor are the routes that load them', () => {
    expect(GRAPH.get('imports/handlers.ts')).toContain('imports/commit.ts');
    expect(GRAPH.get('comms/routes.ts')).toContain('imports/routes.ts');
    const cycles = ['imports/commit.ts', 'imports/handlers.ts', 'imports/routes.ts', 'comms/routes.ts', 'comms/index.ts'].map((f) => cycleThrough(f)).filter((c) => c !== null);
    expect(cycles).toEqual([]);
  });

  it('R-IMPORT-4: cma/deps.ts takes its comms names from their own modules, not the comms/index.ts barrel', () => {
    expect(GRAPH.get('cma/deps.ts')).not.toContain('comms/index.ts');
    expect(GRAPH.get('cma/deps.ts')).toEqual(expect.arrayContaining(['comms/gateInput.ts', 'comms/compose.ts', 'comms/runtime.ts', 'comms/dispatch.ts']));
  });

  it('the scan finds a cycle when there is one, and reads every load-import form (probe)', () => {
    const probe = new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts', 'd.ts']], ['c.ts', ['a.ts']], ['d.ts', []]]);
    expect(cycleThrough('a.ts', probe)).toBe('a.ts → b.ts → c.ts → a.ts');
    expect(cycleThrough('d.ts', probe)).toBeNull();
    const text = ["import { a } from '../comms/index.js';", "export * from '../comms/routes.js';", "import '../comms/dial.js';", "import type { T } from '../comms/inbound.js';"].join('\n');
    expect(loadImports('cma/probe.ts', text)).toEqual(['comms/index.ts', 'comms/routes.ts', 'comms/dial.ts']);
  });
});
