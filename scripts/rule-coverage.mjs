#!/usr/bin/env node
// Phase 1 exit criteria 2 and 3 (docs/BUILD_PLAN.md): every R-* rule in DATA_MODEL §4 and every
// edge case E1..E70 in DATA_MODEL §5 must be linked to at least one passing test. A test is linked
// by putting the id in its name, e.g.  it('R-OWN-5 E1: the losing claimer gets LEAD_ALREADY_CLAIMED', ...)
//
// Usage
//   node scripts/rule-coverage.mjs             static scan of test titles (it/test/describe, no skip/todo)
//   node scripts/rule-coverage.mjs --results   use Vitest JSON results (**/.vitest-results.json, written by
//                                              `pnpm test:report`): only PASSED tests count
//   --json                                     machine-readable output
//   --no-fail                                  exit 0 even with gaps (default: exit 1 on any gap, as in CI)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const useResults = args.has('--results');
const asJson = args.has('--json');
const noFail = args.has('--no-fail');

// ---------- ids listed in DATA_MODEL.md ----------
const dataModel = readFileSync(join(root, 'docs/DATA_MODEL.md'), 'utf8');
const rulesStart = dataModel.indexOf('## 4. Business rules');
const edgeStart = dataModel.indexOf('## 5. Edge cases');
if (rulesStart < 0 || edgeStart < 0) {
  console.error('rule-coverage: could not find DATA_MODEL §4/§5 headings');
  process.exit(2);
}
const ruleIds = [...dataModel.slice(rulesStart, edgeStart).matchAll(/^- \*\*(R-[A-Z]+-\d+)\*\*/gm)].map((m) => m[1]);
const edgeIds = [...dataModel.slice(edgeStart).matchAll(/^\| (E\d+) \|/gm)].map((m) => m[1]);
const known = new Set([...ruleIds, ...edgeIds]);

const ID_RE = /\b(R-[A-Z]+-\d+|E\d{1,3})\b/g;

// ---------- collect test titles ----------
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.stryker-tmp', 'reports', 'playwright-report', 'test-results']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** @type {{ title: string; file: string }[]} */
let titles = [];
if (useResults) {
  const files = walk(root, []).filter((f) => f.endsWith('.vitest-results.json'));
  if (files.length === 0) {
    console.error('rule-coverage: no .vitest-results.json found; run `pnpm test:report` first');
    process.exit(2);
  }
  for (const f of files) {
    const report = JSON.parse(readFileSync(f, 'utf8'));
    for (const tr of report.testResults ?? []) {
      for (const a of tr.assertionResults ?? []) {
        if (a.status === 'passed') titles.push({ title: a.fullName ?? a.title, file: relative(root, tr.name ?? f) });
      }
    }
  }
} else {
  const TEST_FILE = /(\.test\.(ts|tsx|js|mjs)|\.spec\.ts)$/;
  // it('...') / test.concurrent("...") / describe.each(...)('...') ... ; skip/todo are not coverage
  const CALL = /\b(it|test|describe)((?:\.(?:only|concurrent|sequential|each|for|fails|runIf|skipIf)(?:\([^)]*\))?)*)\s*(?:\(\s*\[[^\]]*\]\s*\))?\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
  for (const f of walk(root, []).filter((p) => TEST_FILE.test(p))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const modifiers = m[2] ?? '';
      if (/\.(skip|todo)\b/.test(modifiers)) continue;
      titles.push({ title: m[4], file: relative(root, f) });
    }
  }
}

// ---------- map ----------
/** @type {Map<string, Set<string>>} */
const linked = new Map();
/** @type {Map<string, Set<string>>} */
const unknown = new Map();
for (const { title, file } of titles) {
  for (const m of title.matchAll(ID_RE)) {
    const id = m[1];
    const target = known.has(id) ? linked : unknown;
    if (!target.has(id)) target.set(id, new Set());
    target.get(id).add(file);
  }
}

const ruleGaps = ruleIds.filter((id) => !linked.has(id));
const edgeGaps = edgeIds.filter((id) => !linked.has(id));
const byFamily = {};
for (const id of ruleIds) {
  const fam = id.split('-')[1];
  byFamily[fam] ??= { total: 0, covered: 0 };
  byFamily[fam].total++;
  if (linked.has(id)) byFamily[fam].covered++;
}

const summary = {
  mode: useResults ? 'passed-test-results' : 'static-test-titles',
  rules: { total: ruleIds.length, covered: ruleIds.length - ruleGaps.length, gaps: ruleGaps },
  edgeCases: { total: edgeIds.length, covered: edgeIds.length - edgeGaps.length, gaps: edgeGaps },
  byFamily,
  linked: Object.fromEntries([...linked].map(([k, v]) => [k, [...v].sort()])),
  unknownIdsInTests: Object.fromEntries([...unknown].map(([k, v]) => [k, [...v].sort()])),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`rule coverage (${summary.mode}; DATA_MODEL.md §4/§5)`);
  console.log(`  R-* rules:  ${summary.rules.covered}/${summary.rules.total} linked to a test`);
  for (const [fam, c] of Object.entries(byFamily)) console.log(`    R-${fam.padEnd(8)} ${c.covered}/${c.total}`);
  console.log(`  edge cases: ${summary.edgeCases.covered}/${summary.edgeCases.total} linked to a test`);
  if (ruleGaps.length) console.log(`\n  rule gaps (${ruleGaps.length}):\n    ${ruleGaps.join(' ')}`);
  if (edgeGaps.length) console.log(`\n  edge-case gaps (${edgeGaps.length}):\n    ${edgeGaps.join(' ')}`);
  if (unknown.size) console.log(`\n  ids in test names that DATA_MODEL does not list (typo?): ${[...unknown.keys()].join(' ')}`);
}

const gaps = ruleGaps.length + edgeGaps.length;
process.exit(gaps > 0 && !noFail ? 1 : 0);
