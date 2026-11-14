// @vitest-environment node
// b17 (B17R-2): the repository is public, so every US (NANP) phone number written in apps/**, packages/** or docs/**
// is one kept for fiction: +1 NXX 555-0100 to 555-0199 (N is 2-9). A number outside that range could be someone's
// real line. The UK guard beside this file (fictionalPhones.test.ts, b15 audit F13) does the same for +44 numbers.
//
// The numbering scheme, for code that needs more than the 100 numbers one area code holds: the area code is the
// second dimension, 100 numbers each (555-0100 to 555-0199). Lines 555-0150 to 555-0176 are the fake telephony
// provider's. See packages/core/src/testing/phones.ts (bulk numbers), apps/api/src/leads/testing.ts (randomPhone) and
// packages/db/test/fictionalPhone.ts.
//
// What it reads, as ten digits:
// - "+1" and ten digits, with or without spaces, dots, dashes or brackets: +14155550100, +1 (415) 555-0100;
// - a separated NANP number with or without a leading 1: (415) 555-0100, 415-555-0100, 415.555.0100, 1-415-555-0100;
// - a quoted bare 10-digit number, or 11 digits starting with 1: '4155550100', "14155550100" (a quoted UK drama
//   number written as its digits after +44 also passes);
// - b17 round 2 (M1): any other bare run of ten digits, or 1 and ten, whose digits stop where a number's do: after a
//   comma, a quote, a space, a newline escape (\n), "tel:", as a JSON number ("phone": 4155550100) and so on, but not
//   inside hex or an id (c4155550100d, 4155550100_zpid) or a decimal (10428.14155550100, 4155550100.5);
// - a generator: "+1" and up to nine digits, or a written area code and part of a number ("(415) 55", "415-555-"),
//   followed by a template hole or a concatenation. It passes only when its digits already reach 555-01
//   ("+1843555013" then a hole) or, for "+1" and fewer than eight digits, when its line spells 55501 after the hole
//   ("+1", the area code's hole, then 55501). Numbers built entirely at run time are checked by their generators' tests.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../..');
const SELF = 'apps/web/src/test/fictionalUsPhones.test.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP_DIRS.has(n) || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(tsx?|[cm]?js|json|sql|md|html|css|snap|txt|csv|ya?ml|eml)$/.test(n) ? [p] : [];
  });
}

const FICTIONAL = /^[2-9]\d{2}55501\d{2}$/;
/** True for a ten-digit NANP number (area code first) in the fictional range NXX 555-0100..0199. */
export const isFictionalUs = (ten: string): boolean => FICTIONAL.test(ten);
/** Ofcom's drama blocks, as digits after +44 (the b15 guard's list). */
const UK_DRAMA = /^(?:2079460|7700900|1632960|1(?:1[3-8]|21|31|41|51|61)4960|1914980|2896496|3069990|8081570|9098790)\d{3}$/;

export interface Found {
  line: number;
  text: string;
  /** ten digits, or a generator's literal digits (area code first) */
  digits: string;
  ok: boolean;
}

const PLUS1 = /(?<![\w+])\+1[\s.-]?(?:\((\d{3})\)|(\d{3}))[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
const NANP = /(?<![\w+$.-])(?:1[\s.-]?)?(?:\(([2-9]\d{2})\)\s?|([2-9]\d{2})[\s.-])(\d{3})[\s.-](\d{4})(?![\w-])/g;
const QUOTED = /(['"`])1?([2-9]\d{9})\1/g;
// b17 round 2 (M1): ten digits (or 1 and ten) that stop where a number stops: not after or before a letter, a digit or
// an underscore (hex, ids such as 123_zpid), not after a decimal point and not before a fraction. A newline, tab or
// return escape (\n, \t, \r) before the digits counts as a separator.
const BARE = /(?:(?<=\\[nrt])|(?<![\w.]))1?([2-9]\d{9})(?!\w|\.\d)/g;
const HOLE = String.raw`(?=\$\{|['"\x60]\s*(?:\+|\|\|))`;
const GENERATOR = new RegExp(String.raw`(?<![\w+])\+1(\d{0,9})` + HOLE, 'g');
const WRITTEN_GENERATORS = [new RegExp(String.raw`\(([2-9]\d{2})\)[\s.-]?([\d\s.-]{0,8})` + HOLE, 'g'), new RegExp(String.raw`(?<![\w+$.:/-])([2-9]\d{2})-(\d[\d-]{0,7})` + HOLE, 'g')];
const REACHES_FICTION = /^[2-9]\d{2}55501\d?$/;

/** Every +1 or NANP-formatted number in `text`, and every number generator, with whether it is fictional. */
export function usNumbers(text: string): Found[] {
  const out: Found[] = [];
  text.split('\n').forEach((raw, i) => {
    // an HTML no-break space separates digits as a space does; invisible format characters (bidi marks, zero-width
    // joiners), written as themselves or as \u escapes, do not separate them at all
    const l = raw.replace(/&nbsp;|\u00a0/g, ' ').replace(/\\u(?:200[b-f]|202[a-e]|206[0-9])|[\u200b-\u200f\u202a-\u202e\u2060-\u2069]/gi, '');
    const line = i + 1;
    const taken: [number, number][] = [];
    const add = (m: RegExpMatchArray, digits: string, ok: boolean) => {
      const at = m.index!;
      if (taken.some(([a, b]) => at < b && at + m[0].length > a)) return;
      taken.push([at, at + m[0].length]);
      out.push({ line, text: m[0], digits, ok });
    };
    for (const m of l.matchAll(GENERATOR)) {
      const d = m[1]!;
      add(m, d, REACHES_FICTION.test(d) || (d.length < 8 && l.slice(m.index! + m[0].length).includes('55501')));
    }
    for (const re of WRITTEN_GENERATORS) {
      for (const m of l.matchAll(re)) {
        const d = `${m[1]}${m[2]!.replace(/\D/g, '')}`;
        add(m, d, REACHES_FICTION.test(d));
      }
    }
    for (const m of l.matchAll(PLUS1)) {
      const ten = `${m[1] ?? m[2]}${m[3]}${m[4]}`;
      add(m, ten, isFictionalUs(ten));
    }
    for (const m of l.matchAll(NANP)) {
      const ten = `${m[1] ?? m[2]}${m[3]}${m[4]}`;
      add(m, ten, isFictionalUs(ten));
    }
    for (const m of l.matchAll(QUOTED)) add(m, m[2]!, isFictionalUs(m[2]!) || (m[0].length === 12 && UK_DRAMA.test(m[2]!)));
    for (const m of l.matchAll(BARE)) add(m, m[1]!, isFictionalUs(m[1]!) || (m[0].length === 10 && UK_DRAMA.test(m[1]!)));
  });
  return out;
}

/**
 * Numbers that must stay, by file, each with its reason. Nothing else outside 555-0100..0199 may appear. This file
 * itself may name only these.
 */
export const ALLOWED: Record<string, Record<string, string>> = {
  'apps/api/src/deploy.appvm.test.ts': {
    '5005550006': "Twilio's documented magic test number (+1 500 555 0006, a valid From with test credentials); the test proves a deploy refuses it",
  },
  'apps/api/src/providers/twilio/telephony.test.ts': {
    '2349013030': "Twilio's published webhook-signature example (its security docs); the expected signature is computed over these exact values",
    '8005551212': "the To of the same published Twilio example; changing it changes the signature the test checks against Twilio's",
  },
  'packages/core/src/foundation/normalize.test.ts': {
    '2121550123': 'deliberately unassignable (an exchange cannot start with 1); the test proves the normalizer rejects it',
  },
  'apps/api/src/leadEmail/parse/parse.test.ts': {
    '2081234567': 'not a phone number: a Zillow property id (zpid) in the lead-email fixture',
  },
  'packages/db/test/erase_trigger_order_0089.test.ts': {
    '4294967295': 'not a phone number: 2^32 - 1, an out-of-range value the test passes as an id',
  },
  // b17 round 2 (M1): ids the bare-digit read finds
  'apps/api/src/auth/hardening.test.ts': {
    '2130706433': 'not a phone number: 127.0.0.1 written as one decimal integer, a push endpoint host the test proves is refused',
  },
  'apps/api/src/imports/fub.test.ts': {
    '2130706433': 'not a phone number: 127.0.0.1 written as one decimal integer, a media URL host the import refuses',
  },
  'apps/api/src/imports/fub.ts': {
    '2130706433': 'not a phone number: the comment names 127.0.0.1 written as one decimal integer (an IP literal the URL check refuses)',
  },
  'apps/api/src/imports/fub.large.test.ts': {
    '4294967296': "not a phone number: 2^32, the divisor of the test's seeded random number generator",
  },
  'apps/web/src/portal/test/hostile.ts': {
    '4294967296': "not a phone number: 2^32, the divisor of the test's seeded random number generator",
  },
  'apps/api/src/leadEmail/parse/fixtures.ts': {
    '2081234567': 'not a phone number: the Zillow property id (zpid) of the lead-email fixture parse.test.ts reads',
  },
  'apps/api/src/load/generate.ts': {
    '2147483647': "not a phone number: 2^31 - 1, the mask that keeps the load generator's SQL hash positive",
  },
  'apps/api/src/transactions/adversarial.test.ts': {
    '4417123456': 'not a phone number: the account number of a forged wire-instruction label the test proves never reaches a message',
  },
  'apps/api/src/transactions/updates.test.ts': {
    '4417123456': 'not a phone number: the account number of a payment-details label the test proves sends nothing (R-GATE-7)',
  },
  'apps/web/src/widget/styles.ts': {
    '2147483646': "not a phone number: the chat widget's launcher z-index, 2^31 - 2 (one under the panel)",
    '2147483647': "not a phone number: the chat widget's panel z-index, 2^31 - 1 (the largest a browser keeps)",
  },
  'packages/db/test/riOrderFixture.ts': {
    '4294967295': 'not a phone number: the comment names the largest Postgres oid, 2^32 - 1',
  },
};

/** The numbers in a file (`rel` from the repository root) that are neither fictional nor allowed there, as `rel:line: text`. */
export function outsideRange(rel: string, text: string): string[] {
  const allowed = rel === SELF ? Object.assign({}, ...Object.values(ALLOWED)) as Record<string, string> : (ALLOWED[rel] ?? {});
  return usNumbers(text)
    .filter((n) => !n.ok && !Object.hasOwn(allowed, n.digits))
    .map((n) => `${rel}:${n.line}: ${n.text}`);
}

const sample = (...parts: string[]) => parts.join('');
/** 415 055-01kk: an exchange starting with 0, so no line has it. Built at run time, so this file never spells one. */
const noLine = (kk: string) => sample('415', '055', '01', kk);

describe('b17 (B17R-2): US phone numbers in apps, packages and docs are fictional (555-0100 to 555-0199)', () => {
  it('the check knows the range and the formats', () => {
    expect(['4155550100', '6175550199', '5555550142'].map(isFictionalUs)).toEqual([true, true, true]);
    // Built from parts so that this file never spells a number outside the range. Each sample is one no line can
    // have: an exchange or area code starting with 0 or 1.
    const outside = [sample('415', '055', '0100'), sample('415', '155', '0100'), sample('155', '555', '0100')];
    expect(outside.map(isFictionalUs)).toEqual([false, false, false]);
    const text = [
      `sms('+${sample('1', '4155550101')}') and +1 (415) 555-0102 and 415.555.0103`,
      `phones: ['1-415-555-0104', '${sample('415', '055', '0100')}'] and "${sample('1415', '555', '0105')}"`,
      `const p = \`+${sample('1415055')}\${n}\`;`,
      `const q = '+${sample('1415')}' + String(n);`,
      `const r = \`+1\${area}55501\${nn}\`; const s = \`+1843555013\${i}\`;`,
      `const t = \`(${sample('415')}) 05\${n}\`; const u = '415-${sample('055')}-' + n; const v = \`(415) 555-01\${nn}\`;`,
      `uk: '${sample('2079460', '123')}' and not numbers: 2026-11-14, 122.2711456, 4155550100500, v1.415.555.0100, 203.0.113.\${n}`,
      'Phone: (415)&nbsp;555-0106 and 415\\u2066-555-0107',
    ].join('\n');
    expect(usNumbers(text).map((f) => [f.line, f.digits, f.ok])).toEqual([
      [1, '4155550101', true], [1, '4155550102', true], [1, '4155550103', true],
      [2, '4155550104', true], [2, sample('415', '055', '0100'), false], [2, '4155550105', true],
      [3, sample('415055'), false], [4, '415', false], [5, '', true], [5, '843555013', true],
      [6, sample('41505'), false], [6, '41555501', true], [6, sample('415055'), false],
      [7, sample('2079460', '123'), true],
      [8, '4155550106', true], [8, '4155550107', true],
    ]);
  });

  it('b17 round 2 (M1): a bare 10- or 11-digit run is read wherever its digits stop: after a comma, a quote, a newline escape or tel:, and as a JSON number', () => {
    const text = [
      `csv: 'name,phone\\nJo,${noLine('01')}\\n${sample('1', noLine('02'))},x'`,
      `json: {"phone": ${noLine('03')}, "list": [${sample('415', '555', '0104')}], "s": "${noLine('05')} ext 2"}`,
      `link: <a href="tel:${noLine('06')}">`,
      // digits that run on into letters, a decimal or more digits are not a number: hex, a fraction, an id suffix
      `not numbers: c${noLine('07')}d, 10428.${sample('1', noLine('08'))}, ${noLine('09')}_zpid, ${noLine('10')}.5, ${noLine('11')}0`,
    ].join('\n');
    expect(usNumbers(text).map((f) => [f.line, f.digits, f.ok])).toEqual([
      [1, noLine('01'), false], [1, noLine('02'), false],
      [2, noLine('03'), false], [2, '4155550104', true], [2, noLine('05'), false],
      [3, noLine('06'), false],
    ]);
    // planted in a file the scan reads, it fails the scan; a fictional one passes
    const planted = 'packages/core/src/planted.json';
    expect(outsideRange(planted, `{\n  "phone": ${noLine('12')},\n  "ok": 4155550112\n}`)).toEqual([`${planted}:2: ${noLine('12')}`]);
  });

  it('every +1 or NANP number under apps, packages and docs is in 555-0100..0199 or allowed with a reason', () => {
    const files = ['apps', 'packages', 'docs'].flatMap((d) => filesUnder(join(repo, d)));
    expect(files.length).toBeGreaterThan(2000);
    const outside = files.flatMap((f) => outsideRange(relative(repo, f).split('\\').join('/'), readFileSync(f, 'utf8')));
    expect(outside).toEqual([]);
  });

  it('each allowed number is still where its reason says (no stale entries)', () => {
    const stale = Object.entries(ALLOWED).flatMap(([rel, nums]) => {
      const found = new Set(usNumbers(readFileSync(join(repo, rel), 'utf8')).map((n) => n.digits));
      return Object.keys(nums).filter((d) => !found.has(d)).map((d) => `${rel}: ${d}`);
    });
    expect(stale).toEqual([]);
  });
});
