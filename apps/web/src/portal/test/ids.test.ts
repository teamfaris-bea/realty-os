// @vitest-environment node
// module 46, b15 audit F10: the E-id remap (the brief's E680-E699 are E700-E719, because module 45 as built took
// E680-E699) is right where it is written down: no title names one id twice, the step-0 table maps the brief's module 45
// references to 45's ids as built, the DATA_MODEL rows keep the brief's cross-references, and R-PORTALWEB-4 says what
// the per-channel 503 really shows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../../..');
const web = join(repo, 'apps/web');
const doc = (name: string) => readFileSync(join(repo, 'docs', name), 'utf8');
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}
/** The last cell (Rule) of an edge-case row. */
const rulesOf = (id: string) => {
  const row = doc('DATA_MODEL.md').split('\n').find((l) => l.startsWith(`| ${id} |`));
  expect(row, id).toBeDefined();
  return row!.split('|').filter((c) => c.trim() !== '').at(-1)!;
};

describe('b15 audit F10: the E-id remap of module 46', () => {
  it('no module 46 file names the same E-id twice in a row', () => {
    const files = ['src/portal', 'src/surfaces/client-portal', 'e2e/portal'].flatMap((d) => filesUnder(join(web, d)));
    expect(files.length).toBeGreaterThan(30);
    const doubled = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(E\d{3}), \1\b/g)].map((m) => `${f.slice(web.length + 1)}: ${m[0]}`));
    expect(doubled).toEqual([]);
  });

  // (the brief's ids stay out of the title: rule-coverage reads E-ids in test names, and the brief's are not DATA_MODEL's)
  it("the step-0 table maps the brief's module 45 references to 45's ids as built (E685, E689, E693, E699)", () => {
    const row = doc('PHASE2_3_PLAN.md').split('\n').find((l) => l.startsWith('| Edge-case ids |'))!;
    for (const m of ['E645→E685', 'E649→E689', 'E653→E693', 'E659→E699']) expect(row, m).toContain(m);
    expect(row).not.toMatch(/45's E700/);
  });

  it("the DATA_MODEL rows keep the brief's cross-references (E705: E127; E712: E125; E713: E689; E717: E148)", () => {
    expect(rulesOf('E705')).toContain('E127');
    expect(rulesOf('E712')).toContain('E125');
    expect(rulesOf('E713')).toContain('E689');
    expect(rulesOf('E717')).toContain('E148');
  });

  it("R-PORTALWEB-4: 45's sentences verbatim, but the per-channel 503 shows the portal's own sentence saying nothing was sent", () => {
    const rule = doc('DATA_MODEL.md').split('\n').find((l) => l.startsWith('- **R-PORTALWEB-4**'))!;
    expect(rule).not.toMatch(/the 503s \(overall or per channel\)[^;]*verbatim/);
    expect(rule).toMatch(/per-channel 503 shows the portal's own sentence, saying nothing was sent/);
  });
});
