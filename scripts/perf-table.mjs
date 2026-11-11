// Renders the before/after table of docs/PERFORMANCE.md from two `pnpm load:bench --out` JSON files
// (lane scale-250k). Usage: node scripts/perf-table.mjs before.json after.json
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node scripts/perf-table.mjs before.json after.json');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
const key = (name) => name.replace(/\d+ live offers, \d+ agents/, 'N live offers, N agents').replace(/\d+ agents each claim/, 'N agents each claim').replace(/\(chattiest contacts, [^)]*\)/, '(chattiest contacts)');
const byName = new Map(after.results.map((m) => [key(m.name), m]));
const fmt = (x) => (Number.isFinite(x) ? (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`) : '—');
const verdict = (m) => (m.budgetMs === null ? 'no budget' : m.p95 < m.budgetMs ? 'pass' : '**miss**');
const rows = ['| operation | budget (p95) | before p50 | before p95 | after p50 | after p95 | after |', '|---|---:|---:|---:|---:|---:|---|'];
for (const b of before.results) {
  if (b.name.startsWith('  ')) continue; // the contact page's parts are in the JSON only
  const a = byName.get(key(b.name));
  rows.push(`| ${b.name} | ${b.budgetMs === null ? '—' : `${b.budgetMs} ms`} | ${fmt(b.p50)} | ${fmt(b.p95)} | ${a ? fmt(a.p50) : '—'} | ${a ? fmt(a.p95) : '—'} | ${a ? verdict(a) : 'not run'}${a?.note ? ` (${a.note})` : ''} |`);
}
console.log(rows.join('\n'));
console.log('\nChecks (after):');
for (const c of after.checks) console.log(`- ${c.ok ? 'ok' : 'FAILED'}: ${c.name}: ${c.detail}`);
console.log('\nChecks (before):');
for (const c of before.checks) console.log(`- ${c.ok ? 'ok' : 'FAILED'}: ${c.name}: ${c.detail}`);
