#!/usr/bin/env node
// Phase 1 exit criteria 2 and 3 (docs/BUILD_PLAN.md): every R-* rule in DATA_MODEL §4 and every
// edge case E1..E70 in DATA_MODEL §5 must be linked to at least one passing test. A test is linked
// by putting the id in its name, e.g.  it('R-OWN-5 E1: the losing claimer gets LEAD_ALREADY_CLAIMED', ...)
//
// Retired ids (an owner decision removed the behaviour; DATA_MODEL keeps the id and its old text) need
// no test. An id is retired only when its own entry STARTS with the marker, so a rule or edge case that
// merely mentions retirement elsewhere stays active and still needs its test:
//   rule       - **R-CONSENT-13** **Retired: <why>** ...
//   edge case  | E29 | <case> | **Retired: <why>** ... |
// Retired ids are listed separately (with any tests that still name them), never counted as covered.
//
// Usage
//   node scripts/rule-coverage.mjs             static scan of test titles (it/test/describe, no skip/todo)
//   node scripts/rule-coverage.mjs --results   use Vitest JSON results (**/.vitest-results.json, written by
//                                              `pnpm test:report`): only PASSED tests count
//   --json                                     machine-readable output
//   --no-fail                                  exit 0 even with gaps (default: exit 1 on any gap, as in CI)
//   --phase=2-3                                report DATA_MODEL Part 2 (Phase 2-3 rules §9, edge cases §10)
//   --phase=parity                             report DATA_MODEL Part 3 (FUB parity rules §13, edge cases §14)
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
const RETIRED_MARK = '**Retired:';
// DATA_MODEL "Part 2: Phase 2-3" (added with migration 0018) has its own rules (§9) and edge cases (§10).
// `--phase=2-3` reports those; the default reports Phase 1. Ids of both parts are known either way.
const phase23 = args.has('--phase=2-3');
const p23Start = dataModel.indexOf('\n# Part 2: Phase 2-3');
const p23Rules = dataModel.indexOf('## 9. Phase 2-3 business rules');
const p23Edges = dataModel.indexOf('## 10. Phase 2-3 edge cases');
const end1 = p23Start < 0 ? dataModel.length : p23Start;
// DATA_MODEL "Part 3: FUB parity" (added with the FUB parity migration) has its own rules (§13) and edge cases (§14).
const parityPhase = args.has('--phase=parity');
const parStart = dataModel.indexOf('\n# Part 3: FUB parity');
const parRules = dataModel.indexOf('## 13. FUB parity business rules');
const parEdges = dataModel.indexOf('## 14. FUB parity edge cases');
const end2 = parStart < 0 ? dataModel.length : parStart;
const parseRules = (text) => [...text.matchAll(/^- \*\*(R-[A-Z]+-\d+)\*\*(.*)$/gm)].map((m) => ({ id: m[1], retired: m[2].trimStart().startsWith(RETIRED_MARK) }));
const parseEdges = (text) => [...text.matchAll(/^\| (E\d+) \|[^|]*\|(.*)$/gm)].map((m) => ({ id: m[1], retired: m[2].trimStart().startsWith(RETIRED_MARK) }));
const p1 = { rules: parseRules(dataModel.slice(rulesStart, edgeStart)), edges: parseEdges(dataModel.slice(edgeStart, end1)) };
const p2 = p23Rules < 0 || p23Edges < 0 ? { rules: [], edges: [] }
  : { rules: parseRules(dataModel.slice(p23Rules, p23Edges)), edges: parseEdges(dataModel.slice(p23Edges, end2)) };
const p3 = parRules < 0 || parEdges < 0 ? { rules: [], edges: [] }
  : { rules: parseRules(dataModel.slice(parRules, parEdges)), edges: parseEdges(dataModel.slice(parEdges)) };
const ruleEntries = parityPhase ? p3.rules : phase23 ? p2.rules : p1.rules;
const edgeEntries = parityPhase ? p3.edges : phase23 ? p2.edges : p1.edges;
const allRuleIds = ruleEntries.map((e) => e.id);
const allEdgeIds = edgeEntries.map((e) => e.id);
const retiredIds = [...ruleEntries, ...edgeEntries].filter((e) => e.retired).map((e) => e.id);
const retired = new Set(retiredIds);
const ruleIds = allRuleIds.filter((id) => !retired.has(id));
const edgeIds = allEdgeIds.filter((id) => !retired.has(id));
const known = new Set([...p1.rules, ...p1.edges, ...p2.rules, ...p2.edges, ...p3.rules, ...p3.edges].map((e) => e.id));

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
// A retired id still named by a test is not an error (the test may prove the behaviour is gone), but it
// is listed so stale titles can be found.
const retiredLinked = Object.fromEntries(retiredIds.filter((id) => linked.has(id)).map((id) => [id, [...linked.get(id)].sort()]));
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
  retired: { ids: retiredIds, stillNamedByTests: retiredLinked },
  byFamily,
  linked: Object.fromEntries([...linked].filter(([k]) => !retired.has(k)).map(([k, v]) => [k, [...v].sort()])),
  unknownIdsInTests: Object.fromEntries([...unknown].map(([k, v]) => [k, [...v].sort()])),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`rule coverage (${summary.mode}; DATA_MODEL.md ${parityPhase ? 'Part 3 §13/§14 (FUB parity)' : phase23 ? 'Part 2 §9/§10 (Phase 2-3)' : '§4/§5'})`);
  console.log(`  R-* rules:  ${summary.rules.covered}/${summary.rules.total} linked to a test`);
  for (const [fam, c] of Object.entries(byFamily)) console.log(`    R-${fam.padEnd(8)} ${c.covered}/${c.total}`);
  console.log(`  edge cases: ${summary.edgeCases.covered}/${summary.edgeCases.total} linked to a test`);
  if (retiredIds.length) console.log(`  retired (no test needed, not counted): ${retiredIds.join(' ')}`);
  const stale = Object.keys(retiredLinked);
  if (stale.length) console.log(`  retired ids still named by tests (check the titles): ${stale.map((id) => `${id} (${retiredLinked[id].join(', ')})`).join('; ')}`);
  if (ruleGaps.length) console.log(`\n  rule gaps (${ruleGaps.length}):\n    ${ruleGaps.join(' ')}`);
  if (edgeGaps.length) console.log(`\n  edge-case gaps (${edgeGaps.length}):\n    ${edgeGaps.join(' ')}`);
  if (unknown.size) console.log(`\n  ids in test names that DATA_MODEL does not list (typo?): ${[...unknown.keys()].join(' ')}`);
}

const gaps = ruleGaps.length + edgeGaps.length;
process.exit(gaps > 0 && !noFail ? 1 : 0);
