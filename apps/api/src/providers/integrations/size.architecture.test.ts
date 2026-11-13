// R-MLS-7: no code path reads BuildingAreaTotal (total building area is never finished living area), and the Spark
// size choice stays explicit and unread until the MLS confirms it. The scan covers every TypeScript and JavaScript
// source file under apps/ and packages/, leaving out tests, test helpers (testing.ts, *.testing.ts, testing/ and test/
// directories), Playwright e2e and docs. Comments are stripped first, so a comment may name the field: the TypeScript
// parser finds them (a "/*" or "//" inside a string, a template, a regex or JSX text is not one). The one place
// the name may appear in code is the "never use" list, core/listings SIZE_FIELDS_NEVER_USED. SQL is not scanned: the
// database never reads a RESO record (the 0078 size migration names the field only to null it and to refuse it as a
// size source). E598, E599.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '__snapshots__', 'e2e', 'testing', 'test', 'docs', 'playwright-report', 'test-results', '.stryker-tmp']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(n) ? [] : files(p);
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(n) || /\.d\.ts$/.test(n)) return [];
    if (/\.test\.[cm]?[jt]sx?$/.test(n) || /(^|\.)testing\.[cm]?[jt]sx?$/.test(n) || /\.config\.[cm]?[jt]s$/.test(n)) return [];
    return [p];
  });
}

const KIND: Record<string, ts.ScriptKind> = { '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS };

/**
 * Source text without its comments, each blanked to its line breaks (so lines keep their numbers). The comments are
 * the parser's: the leading and trailing comment ranges of every token, found by walking the syntax tree, so a "/*"
 * or "//" inside a string, a template, a regex or JSX text never opens one. JSDoc nodes are not descended into
 * (their text is inside a comment already found).
 */
function code(src: string, name = 'x.ts'): string {
  const ext = /\.[a-z]+$/.exec(name)?.[0] ?? '.ts';
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, false, KIND[ext] ?? ts.ScriptKind.TS);
  const ranges = new Map<number, number>();
  const add = (rs: readonly ts.CommentRange[] | undefined) => {
    for (const r of rs ?? []) ranges.set(r.pos, Math.max(r.end, ranges.get(r.pos) ?? 0));
  };
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (n.kind !== ts.SyntaxKind.JsxText) {
      add(ts.getLeadingCommentRanges(src, n.getFullStart()));
      add(ts.getTrailingCommentRanges(src, n.getEnd()));
    }
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  let out = '';
  let at = 0;
  for (const [pos, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (pos < at) continue; // inside a comment already blanked
    out += src.slice(at, pos) + src.slice(pos, end).replace(/[^\n]/g, '');
    at = end;
  }
  return out + src.slice(at);
}

/** The "never use" list's declaration is the one allowed mention. */
const NEVER_LIST = /export const SIZE_FIELDS_NEVER_USED\b[^;]*;/;

/** Every mention of BuildingAreaTotal left in a file's code once its comments and the never-use list are removed. */
function offenders(src: string, name = 'x.ts'): string[] {
  return code(src, name)
    .replace(NEVER_LIST, '')
    .split('\n')
    .filter((l) => /BuildingAreaTotal/i.test(l))
    .map((l) => l.trim());
}

const SOURCES = [...files(join(ROOT, 'apps')), ...files(join(ROOT, 'packages'))].map((p) => {
  const rel = relative(ROOT, p).replaceAll('\\', '/');
  const text = readFileSync(p, 'utf8');
  return { rel, text, code: code(text, rel) };
});

describe('R-MLS-7: BuildingAreaTotal is never read as size', () => {
  it('the detector finds a field read in every form and ignores comments and the never-use list', () => {
    const reads = [
      "const a = raw['BuildingAreaTotal'];",
      'const b = r.BuildingAreaTotal;',
      "export const M = Object.freeze({ sqft: 'BuildingAreaTotal' } as const);",
      'const { BuildingAreaTotal: area } = rec;',
      'const c = raw[`BuildingAreaTotal`] ?? 0; // https://example.invalid',
    ];
    for (const r of reads) expect(offenders(r), r).toHaveLength(1);
    const allowed = [
      '// the size is never read from BuildingAreaTotal',
      '/* BuildingAreaTotal is total building area */ const x = 1;',
      '/**\n * BuildingAreaTotal (finding 5) is not finished living area\n */\nexport const y = 2;',
      "export const SIZE_FIELDS_NEVER_USED: readonly string[] = Object.freeze(['BuildingAreaTotal', 'BelowGradeFinishedArea']);",
    ];
    for (const a of allowed) expect(offenders(a), a).toEqual([]);
    // a "/*" inside a line comment, a string, a template or a regex opens no comment: the code after it is still read
    const hidden = [
      "// Nothing is sent (comms/** is not called).\nexport const R = (raw: Record<string, unknown>) => raw['BuildingAreaTotal'];\n/** a later block comment */\nexport const Z = 1;",
      "export const ACCEPT = 'image/*,video/mp4';\nconst a = r.BuildingAreaTotal;\nconst b = '*/';",
      'const t = `glob src/**`;\nconst a = r.BuildingAreaTotal; /* later */',
      'const re = /\\/\\*/;\nconst a = r.BuildingAreaTotal; /* later */',
      '<div title="a/*b">{r.BuildingAreaTotal}</div>; /* later */',
    ];
    for (const h of hidden) expect(offenders(h, h.startsWith('<') ? 'x.tsx' : 'x.ts'), h).toHaveLength(1);
    // and a "//" inside a string or a URL is no comment either
    expect(offenders("const u = 'https://example.invalid/x'; const a = r.BuildingAreaTotal;")).toHaveLength(1);
  });

  it('E599 R-MLS-7: no non-test source file under apps/ or packages/ reads BuildingAreaTotal; only the never-use list names it', () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some((f) => f.rel === 'apps/api/src/providers/integrations/spark.ts')).toBe(true);
    expect(SOURCES.some((f) => f.rel.startsWith('apps/web/src/'))).toBe(true);
    const found = SOURCES.flatMap((f) => offenders(f.text, f.rel).map((l) => `${f.rel}: ${l}`));
    expect(found).toEqual([]);
    const lists = SOURCES.filter((f) => NEVER_LIST.test(f.code) && /BuildingAreaTotal/.test(NEVER_LIST.exec(f.code)![0]));
    expect(lists.map((f) => f.rel)).toEqual(['packages/core/src/listings/normalize.ts']);
  });

  it('E598 R-MLS-7: the Spark size candidate (LivingArea, VERIFY WITH MLS) is declared once and read by no source file', () => {
    const mentions = SOURCES.filter((f) => /SPARK_SIZE_FIELD_CANDIDATE/.test(f.code));
    expect(mentions.map((f) => f.rel)).toEqual(['apps/api/src/providers/integrations/spark.ts']);
    const spark = mentions[0]!.code;
    expect(spark.match(/SPARK_SIZE_FIELD_CANDIDATE/g)).toHaveLength(1); // its declaration only
    expect(spark).toMatch(/export const SPARK_FIELD_MAPPING: Readonly<\{ sqft: string \| null \}> = Object\.freeze\(\{ sqft: null \}\);/);
    // no switch can turn a size on: the config, the Spark adapter and the MLS sync name no MLS or Spark size setting
    const checked = SOURCES.filter((x) => /^apps\/api\/src\/(config\.ts$|providers\/integrations\/spark|mls\/)/.test(x.rel));
    expect(checked.map((f) => f.rel)).toContain('apps/api/src/config.ts');
    for (const f of checked) expect(f.code.replaceAll('SPARK_SIZE_FIELD_CANDIDATE', ''), f.rel).not.toMatch(/\b(?:MLS|SPARK)_\w*(?:SIZE|SQFT|AREA|LIVING)\w*/);
  });
});
