// Checks the alert rules of docs/OPERATIONS.md §3 against what the processes really export (deploy rehearsal).
//
//   node scripts/ops-alert-metrics.mjs api-metrics.txt worker-metrics.txt
//     (each file: a GET /metrics body from that process's METRICS_PORT, with the bearer token)
//
// Fails (exit 1) when an alert names a metric family that neither the live outputs nor the §2 tables know, uses
// a label that a family with live series does not carry, or selects `up{}` on a target label that the §2
// scrape config does not set. Families documented in §2 but not exported yet (counters appear on their first
// event) are listed as "not seen yet", not failures. Prints names only.
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8');
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/ops-alert-metrics.mjs <metrics.txt>...');
  process.exit(2);
}
const families = new Map(); // family -> Set(label) (empty set: exported, no series yet)
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const t = /^# TYPE (\S+) \S+/.exec(line);
    if (t) {
      if (!families.has(t[1])) families.set(t[1], new Set());
      continue;
    }
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s/.exec(line);
    if (!m) continue;
    const fam = families.has(m[1]) ? m[1] : m[1].replace(/_(bucket|sum|count)$/, '');
    if (!families.has(fam)) families.set(fam, new Set());
    for (const kv of (m[2] ?? '').matchAll(/([a-zA-Z_]+)="/g)) families.get(fam).add(kv[1]);
  }
}
const section = (n) => doc.split(new RegExp(`^## ${n}\\. `, 'm'))[1]?.split(/^---$/m)[0] ?? '';
const metricsDoc = section(2);
const documented = new Set([...metricsDoc.matchAll(/`(realty_[a-z0-9_]+)`/g)].map((m) => m[1]));
const scrapeLabels = new Set([...metricsDoc.matchAll(/labels:\s*\{\s*([a-z_]+):/g)].map((m) => m[1]));
const familyOf = (name) => (families.has(name) ? name : name.replace(/_(bucket|sum|count)$/, ''));

const problems = [];
const notSeen = new Set();
for (const row of section(3).split('\n').filter((l) => l.startsWith('| `'))) {
  const cells = row.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
  const alert = /`([^`]+)`/.exec(cells[1])[1];
  for (const m of cells[3].matchAll(/\b(realty_[a-z0-9_]+|up)\b(?:\{([^}]*)\})?/g)) {
    const labels = [...(m[2] ?? '').matchAll(/([a-z_]+)\s*(?:=~|!~|!=|=)/g)].map((x) => x[1]);
    if (m[1] === 'up') {
      for (const l of labels) if (!['job', 'instance'].includes(l) && !scrapeLabels.has(l)) problems.push(`${alert}: up{${l}=…} but the §2 scrape config sets no "${l}" target label`);
      continue;
    }
    const fam = familyOf(m[1]);
    if (!families.has(fam)) {
      if (documented.has(fam) || documented.has(m[1])) notSeen.add(fam);
      else problems.push(`${alert}: ${m[1]} is neither exported nor documented in §2`);
      continue;
    }
    const have = families.get(fam);
    if (have.size === 0) continue; // exported, no series yet: labels unknown
    for (const l of labels) if (!have.has(l)) problems.push(`${alert}: ${m[1]} has no label "${l}" (it exports ${[...have].sort().join(', ')})`);
  }
}
for (const p of problems) console.log(`FAIL ${p}`);
if (notSeen.size) console.log(`not seen yet (documented; a counter appears on its first event): ${[...notSeen].sort().join(', ')}`);
console.log(`${families.size} families exported; ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
