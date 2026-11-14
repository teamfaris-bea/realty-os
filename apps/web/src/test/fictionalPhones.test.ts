// @vitest-environment node
// b15 audit F13: the repository is public, so a UK phone number in its apps, packages and docs (the web app's source
// and tests only, until b17 round 2) is one Ofcom keeps for drama (never assigned): London 020 7946 0000-0999, mobile 07700 900000-900999, 01632 960000-960999, and the
// 496/498 blocks of the big-city codes. A number outside them (+44 20 7183 …, copied from an older test) could be a
// real line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

/** Ofcom's drama ranges, as digits after +44. */
// b17: also 028 9649 6xxx, 03069 990xxx, 0808 157 0xxx and 0909 879 0xxx (Ofcom's other drama blocks), which
// packages/core/src/testing/phones.ts makes bulk test numbers from
const DRAMA = [/^2079460\d{3}$/, /^7700900\d{3}$/, /^1632960\d{3}$/, /^1(?:1[3-8]|21|31|41|51|61)4960\d{3}$/, /^1914980\d{3}$/, /^(?:2896496|3069990|8081570|9098790)\d{3}$/];
export const isDramaNumber = (digitsAfter44: string): boolean => DRAMA.some((r) => r.test(digitsAfter44));

/** Every UK number written as +44 (spaces allowed), as digits after +44. */
export function ukNumbers(text: string): string[] {
  return [...text.matchAll(/\+44[\s-]?(\d[\d\s-]{8,13}\d)/g)].map((m) => m[1]!.replace(/[\s-]/g, ''));
}

describe('b15 audit F13: UK phone numbers in apps, packages and docs are fictional', () => {
  it('the check knows the ranges', () => {
    expect(['2079460958', '7700900123', '1632960001', '1134960000', '1914980999'].map(isDramaNumber)).toEqual([true, true, true, true, true]);
    // b17 (B17R-2): the samples outside the ranges are ones no line can have (a digit too many, a digit too few), so
    // this file names no number outside the drama ranges
    expect(['77009001000', '207946099'].map(isDramaNumber)).toEqual([false, false]);
    expect(ukNumbers("sms('+442079460958') and +44 20 7946 0958 and +44 7700 900123")).toEqual(['2079460958', '2079460958', '7700900123']);
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
