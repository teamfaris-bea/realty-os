// scripts/rule-coverage.mjs reads edge-case ids of any length: DATA_MODEL's ids passed three digits in batch 19, and an
// id the script cannot read is reported as a gap however well it is tested. Run against a tiny fixture tree (the
// script's RULE_COVERAGE_ROOT), never this repository. The fixture's ids are assembled from parts so that this file's
// own text names no real id (the script reads test titles from source).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/rule-coverage.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'rule-coverage-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const e = (n: number) => `${'E'}${n}`;
const rule = ['R', 'FIX', '1'].join('-');

function run(): { edgeCases: { total: number; covered: number; gaps: string[] }; rules: { total: number; covered: number }; linked: Record<string, string[]>; unknownIdsInTests: Record<string, string[]> } {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/DATA_MODEL.md'), ['## 4. Business rules', `- **${rule}** A rule.`, '## 5. Edge cases', '| Id | Case | Result |', '|---|---|---|',
    `| ${e(7)} | one digit | ok |`, `| ${e(999)} | three digits | ok |`, `| ${e(1000)} | four digits | ok |`, `| ${e(1001)} | four digits, no test | ok |`, `| ${e(12345)} | five digits | ok |`, ''].join('\n'));
  const call = ['i', 't'].join('');
  writeFileSync(join(dir, 'sample.test.ts'), `${call}('${rule} ${e(7)} ${e(999)} ${e(1000)}, ${e(12345)}: named in a title', () => {});\n${call}('${e(100)}0x and ${e(10001)} are other ids', () => {});\n`);
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json', '--no-fail'], { env: { ...process.env, RULE_COVERAGE_ROOT: dir }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

describe('scripts/rule-coverage.mjs', () => {
  it('counts a four-digit (and longer) edge-case id named in a test title, and still reports the untested one', () => {
    const r = run();
    expect(r.rules).toMatchObject({ total: 1, covered: 1 });
    expect(r.edgeCases).toEqual({ total: 5, covered: 4, gaps: [e(1001)] });
    expect(r.linked[e(1000)]).toEqual(['sample.test.ts']);
    expect(r.linked[e(12345)]).toEqual(['sample.test.ts']);
    // a longer id is never read as its first three digits, and an id DATA_MODEL does not list is reported, not counted
    expect(Object.keys(r.linked).sort()).toEqual([e(1000), e(12345), e(7), e(999), rule].sort());
    expect(Object.keys(r.unknownIdsInTests)).toEqual([e(10001)]);
  });
});
