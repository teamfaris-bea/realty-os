// R-MKT-3: model-written copy may not contain price or date numerals. Prices, dates and open-house
// times come only from bound facts rendered live (E90), so an approved piece can never advertise a
// stale price or a wrong date.
//
//   numeralIssues(text) → { shape, text }[]
//
// Detection runs on folded text: NFKC (full-width "４５０k" and styled digits become ASCII), invisible
// characters dropped ("4​50k"), digits of any script (\p{Nd}, e.g. Arabic-Indic) treated as
// digits, a letter O between digits read as zero ("45Ok"), and single digits separated by spaces or
// dots run together ("4 5 0 k").
//
// CAUGHT (each is a failure):
//   price   "$450k", "450,000", "450000", "1.2M", "450 thousand", "€450", "USD 450", "the 400s"
//   date    "Nov 12", "12 November", "12/11", "12/11/2026", "2026-11-12", "12.11.2026", "the 12th",
//           "Saturday the 12th" (an ordinal with digits, except "2nd floor"/"3rd story"/"level")
//   time    "2pm", "2 p.m.", "10:30"
//   year    "1925", "built in 2004", "the 1920s"
//   number_words  "four hundred fifty thousand dollars", "half a million", "a million", "two grand",
//           "fifty dollars", "November twelfth", "the twelfth of November", "Saturday the twelfth",
//           "two o'clock", "three pm"
// NOT CAUGHT (documented, by design or as a known gap; a person still approves every version):
//   counts that are not prices or dates ("3 bedrooms", "2-car garage", "2.5 baths", "450 sq ft");
//   bare number words without a money or calendar word ("four fifty", "mid four hundreds"),
//   ordinal words without a month or weekday ("the first floor"), weekday or month names alone
//   ("open Saturday", "in November"), relative dates ("this weekend", "tomorrow"), Roman numerals
//   and digits spelled with letters other than O ("4S0k").
// It errs towards flagging: "3/2" (beds/baths slang) and "1/2 acre" are flagged as date-shaped;
// write "three-bed, two-bath" or "half-acre". "24/7" is not a date.
import type { NumeralShape } from './types.js';

export interface NumeralHit {
  readonly shape: NumeralShape;
  readonly text: string;
}

/** Fold text for numeral detection (see the header). */
export function foldNumerals(raw: string): string {
  let t = raw.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  // a letter O between or right after digits is a zero ("45Ok", "4,5OO")
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/(\p{Nd}[,.]?)[oO]/gu, '$10');
    if (next === t) break;
    t = next;
  }
  // single digits separated by one space/dot/underscore/hyphen, three or more in a row, run together
  t = t.replace(/(?<!\p{Nd})\p{Nd}(?:[  ._-]\p{Nd}(?!\p{Nd})){2,}/gu, (m) => m.replace(/[^\p{Nd}]/gu, ''));
  return t;
}

const D = '\\p{Nd}';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY = '(?:mon|tue(?:s)?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?';
const UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const TEENS = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUM = `(?:${TENS}|${TEENS}|${UNITS}|hundred)`;
const ORD_UNITS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth';
const ORD = `(?:(?:twenty|thirty)[\\s-]?(?:${ORD_UNITS})|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|${ORD_UNITS})`;
const DAY_WORD = `(?:${ORD}|(?:twenty|thirty)[\\s-]?(?:${UNITS})|${TEENS}|${UNITS}|twenty|thirty)`;
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
/** Digit patterns only need a digit boundary on the left: "Open1114" is caught. */
const BD = '(?<![\\p{N}])';

const PATTERNS: readonly { shape: NumeralShape; re: RegExp }[] = [
  // number words first, so "four hundred fifty thousand" is one hit
  { shape: 'number_words', re: new RegExp(`${B}(?:(?:${NUM}|and|a|half)[\\s-]+)*(?:${NUM}|a|half)[\\s-]+(?:a[\\s-]+)?(?:thousand|million|billion|grand)${E}(?:[\\s-]+dollars${E})?`, 'giu') },
  { shape: 'number_words', re: new RegExp(`${B}(?:(?:${NUM}|and)[\\s-]+)*(?:${NUM})[\\s-]+(?:dollars|bucks)${E}`, 'giu') },
  { shape: 'number_words', re: new RegExp(`${B}${MONTH}\\.?[\\s,]+(?:the[\\s]+)?${DAY_WORD}${E}`, 'giu') },
  { shape: 'number_words', re: new RegExp(`${B}(?:the\\s+)?${ORD}\\s+of\\s+${MONTH}${E}`, 'giu') },
  { shape: 'number_words', re: new RegExp(`${B}${WEEKDAY},?\\s+(?:the\\s+)?${ORD}${E}`, 'giu') },
  { shape: 'number_words', re: new RegExp(`${B}(?:${TEENS}|${UNITS}|noon)\\s*(?:o['’]?\\s?clock|[ap]\\.?\\s?m\\.?)(?![\\p{L}])`, 'giu') },
  // digits
  { shape: 'price', re: new RegExp(`[$€£¥₹]\\s*${D}[${D},.]*(?:\\s*(?:k|m|mm|mil|million|thousand|grand)${E})?`, 'giu') },
  { shape: 'price', re: new RegExp(`${B}(?:usd|cad|us\\$)\\s*${D}[${D},.]*`, 'giu') },
  { shape: 'time', re: new RegExp(`${BD}${D}{1,2}(?::${D}{2})?\\s*[ap]\\.?\\s?m\\.?(?![\\p{L}])`, 'giu') },
  { shape: 'time', re: new RegExp(`${BD}${D}{1,2}:${D}{2}${E}`, 'gu') },
  { shape: 'date', re: new RegExp(`${BD}${D}{4}-${D}{1,2}-${D}{1,2}${E}`, 'gu') },
  { shape: 'date', re: new RegExp(`${BD}${D}{1,2}[.-]${D}{1,2}[.-]${D}{2,4}${E}`, 'gu') },
  { shape: 'date', re: new RegExp(`${BD}(?!24/7${E})${D}{1,4}/${D}{1,4}(?:/${D}{2,4})?${E}`, 'gu') },
  { shape: 'date', re: new RegExp(`${B}${MONTH}\\.?[\\s,]*${D}{1,2}(?:st|nd|rd|th)?${E}`, 'giu') },
  { shape: 'date', re: new RegExp(`${BD}${D}{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}${E}`, 'giu') },
  { shape: 'date', re: new RegExp(`${BD}${D}{1,2}(?:st|nd|rd|th)${E}(?!\\s+(?:floor|story|storey|level)${E})`, 'giu') },
  { shape: 'price', re: new RegExp(`${BD}${D}{1,3}(?:,${D}{3})+(?:\\.${D}+)?${E}`, 'gu') },
  { shape: 'price', re: new RegExp(`${BD}${D}+(?:[.,]${D}+)?\\s*(?:k|m|mm|mil|million|thousand|grand|dollars?|bucks|usd)${E}`, 'giu') },
  { shape: 'year', re: new RegExp(`${BD}(?:1[6-9]|20)${D}{2}'?s?${E}`, 'gu') },
  { shape: 'year', re: new RegExp(`${B}'${D}{2}s?${E}`, 'gu') },
  { shape: 'price', re: new RegExp(`${BD}${D}{2,3}'?s${E}`, 'gu') },
  { shape: 'price', re: new RegExp(`${BD}${D}{4,}${E}`, 'gu') },
];

/** Price/date/time numerals in `raw` (R-MKT-3). Overlapping hits keep the earliest pattern's. */
export function numeralIssues(raw: string): NumeralHit[] {
  const t = foldNumerals(raw);
  const taken: { start: number; end: number; hit: NumeralHit }[] = [];
  for (const { shape, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some((x) => start < x.end && x.start < end)) continue;
      taken.push({ start, end, hit: { shape, text: m[0] } });
    }
  }
  return taken.sort((a, b) => a.start - b.start).map((x) => x.hit);
}
