// @vitest-environment node
// b15 audit F13: the repository is public, so a UK phone number in its apps, packages and docs (the web app's source
// and tests only, until b17 round 2) is one Ofcom keeps for drama (never assigned): London 020 7946 0000-0999, mobile
// 07700 900000-900999, 01632 960000-960999, the 496/498 blocks of the big-city codes and Ofcom's other drama blocks
// (dramaRanges.ts). A number outside them (+44 20 7183 …, copied from an older test) could be a real line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAMA_BLOCKS, isDramaNumber } from './dramaRanges.js';

// b17 round 2 (L-a): the whole public tree (apps, packages, docs) and the file kinds the US guard beside this file
// (fictionalUsPhones.test.ts) reads, not only the web app's source and e2e specs
const repo = resolve(__dirname, '../../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP_DIRS.has(n) || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(tsx?|[cm]?js|json|sql|md|html|css|snap|txt|csv|ya?ml|eml)$/.test(n) ? [p] : [];
  });
}

/** Every UK number written as +44 (spaces allowed), as digits after +44. */
export function ukNumbers(text: string): string[] {
  return [...text.matchAll(/\+44[\s-]?(\d[\d\s-]{8,13}\d)/g)].map((m) => m[1]!.replace(/[\s-]/g, ''));
}

describe('b15 audit F13: UK phone numbers in apps, packages and docs are fictional', () => {
  it('the check knows the ranges', () => {
    expect(['2079460958', '7700900123', '1632960001', '1134960000', '1914980999'].map(isDramaNumber)).toEqual([true, true, true, true, true]);
    // every block, from its first number to its last
    expect(DRAMA_BLOCKS.flatMap((b) => [`${b}000`, `${b}999`]).filter((n) => !isDramaNumber(n))).toEqual([]);
    // b17 round 2 (L-b): the samples outside the ranges are built from parts at run time, so this file spells no
    // number outside the drama ranges. A digit too many or too few, and a same-length near miss of every block: its
    // seven digits with one changed (a check that read only the length, or only the block's first digits, passes none)
    const nearMisses = DRAMA_BLOCKS.flatMap((b) => [...b].map((_, i) => [b.slice(0, i), String((Number(b[i]) + 1) % 10), b.slice(i + 1)].join('')))
      .filter((b) => !DRAMA_BLOCKS.includes(b))
      .map((b) => [b, '000'].join(''));
    expect(nearMisses.length).toBeGreaterThan(DRAMA_BLOCKS.length * 6);
    expect(nearMisses.every((n) => n.length === 10)).toBe(true);
    expect(nearMisses.filter(isDramaNumber)).toEqual([]);
    expect(DRAMA_BLOCKS.flatMap((b) => [[b, '0000'].join(''), [b, '00'].join('')]).filter(isDramaNumber)).toEqual([]);
    expect(ukNumbers("sms('+442079460958') and +44 20 7946 0958 and +44 7700 900123")).toEqual(['2079460958', '2079460958', '7700900123']);
  });

  it('docs/CONVENTIONS.md records every one of Ofcom\'s drama blocks, and the check accepts exactly those', () => {
    const rule = readFileSync(join(repo, 'docs/CONVENTIONS.md'), 'utf8').split('\n').find((l) => l.startsWith('- **Phone numbers in the repository are fictional**')) ?? '';
    // each block is written as its national number with the last three digits as xxx: 020 7946 0xxx, 01632 960xxx
    const listed = [...rule.matchAll(/(?<!\d)0(\d[\d ]{4,10}\d)xxx\b/g)].map((m) => m[1]!.replace(/ /g, ''));
    expect(rule).toContain("every one of Ofcom's published drama ranges");
    expect([...listed].sort()).toEqual([...DRAMA_BLOCKS].sort());
    expect(listed).toHaveLength(20);
  });

  it('every +44 number under apps, packages and docs is in a drama range', () => {
    const files = ['apps', 'packages', 'docs'].flatMap((d) => filesUnder(join(repo, d)));
    const rels = files.map((f) => relative(repo, f).split('\\').join('/'));
    // b17 round 2 (L-a): the whole public tree is read, not only the web app: the API, every package and the docs
    expect(new Set(rels.map((r) => r.split('/')[0]))).toEqual(new Set(['apps', 'packages', 'docs']));
    expect(['apps/api/', 'apps/web/', 'packages/core/', 'packages/db/', 'docs/'].filter((d) => !rels.some((r) => r.startsWith(d)))).toEqual([]);
    expect(files.length).toBeGreaterThan(2000);
    const real = files.flatMap((f, i) => ukNumbers(readFileSync(f, 'utf8')).filter((n) => !isDramaNumber(n)).map((n) => `${rels[i]}: +44${n}`));
    expect(real).toEqual([]);
  });
});
