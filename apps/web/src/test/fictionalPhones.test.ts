// @vitest-environment node
// b15 audit F13: the repository is public, so a UK phone number in the web app's source and tests is one Ofcom keeps
// for drama (never assigned): London 020 7946 0000-0999, mobile 07700 900000-900999, 01632 960000-960999, and the
// 496/498 blocks of the big-city codes. A number outside them (+44 20 7183 …, copied from an older test) could be a
// real line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = resolve(__dirname, '../..');
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(tsx?|mjs|js|json|html)$/.test(n) ? [p] : [];
  });
}

/** Ofcom's drama ranges, as digits after +44. */
const DRAMA = [/^2079460\d{3}$/, /^7700900\d{3}$/, /^1632960\d{3}$/, /^1(?:1[3-8]|21|31|41|51|61)4960\d{3}$/, /^1914980\d{3}$/];
export const isDramaNumber = (digitsAfter44: string): boolean => DRAMA.some((r) => r.test(digitsAfter44));

/** Every UK number written as +44 (spaces allowed), as digits after +44. */
export function ukNumbers(text: string): string[] {
  return [...text.matchAll(/\+44[\s-]?(\d[\d\s-]{8,13}\d)/g)].map((m) => m[1]!.replace(/[\s-]/g, ''));
}

describe('b15 audit F13: UK phone numbers in the web app are fictional', () => {
  it('the check knows the ranges', () => {
    expect(['2079460958', '7700900123', '1632960001', '1134960000', '1914980999'].map(isDramaNumber)).toEqual([true, true, true, true, true]);
    expect(['7700901000', '2079461000'].map(isDramaNumber)).toEqual([false, false]);
    expect(ukNumbers("sms('+442079460958') and +44 20 7946 0958 and +44 7700 900123")).toEqual(['2079460958', '2079460958', '7700900123']);
  });

  it('every +44 number under apps/web/src and apps/web/e2e is in a drama range', () => {
    const files = [...filesUnder(join(web, 'src')), ...filesUnder(join(web, 'e2e'))];
    expect(files.length).toBeGreaterThan(200);
    const real = files.flatMap((f) => ukNumbers(readFileSync(f, 'utf8')).filter((n) => !isDramaNumber(n)).map((n) => `${f.slice(web.length + 1)}: +44${n}`));
    expect(real).toEqual([]);
  });
});
