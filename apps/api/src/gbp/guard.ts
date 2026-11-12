// The review reply privacy guard (module 53; DATA_MODEL R-GBP-1; E132, E469). Pure and deterministic: codes and spans,
// never text. A public reply never repeats the reviewer's name, a price or money figure, an address, a date, contact
// details or deal terms, never carries a hard fair-housing match (core/fairhousing check() with the tenant's pack),
// and stays within Google's length (VERIFY). Soft fair-housing matches are warnings only.
//
// VERIFY WITH COUNSEL (C15): the deal-term word list and what else a public reply must never say.
import { type FairHousingPack, check } from '@realty/core/fairhousing';
import { GBP_REPLY_MAX_CHARS } from './provider.js';

export type GuardCode = 'REVIEWER_NAME' | 'MONEY' | 'ADDRESS' | 'DATE' | 'CONTACT' | 'DEAL' | 'FAIR_HOUSING' | 'LENGTH';
export const GUARD_CODES: readonly GuardCode[] = ['REVIEWER_NAME', 'MONEY', 'ADDRESS', 'DATE', 'CONTACT', 'DEAL', 'FAIR_HOUSING', 'LENGTH'];

export interface GuardSpan {
  code: GuardCode;
  start: number;
  end: number;
}

export interface ReplyGuard {
  /** hard refusals, sorted and unique (empty: the reply may be posted) */
  codes: GuardCode[];
  spans: GuardSpan[];
  /** soft fair-housing matches: shown as "check this", never a refusal */
  soft: { start: number; end: number }[];
}

/** VERIFY WITH COUNSEL: words that point at a deal. Matched as whole words or phrases, case- and accent-folded. */
export const DEAL_TERMS: readonly string[] = [
  'closing', 'closed on', 'under contract', 'offer', 'offers', 'inspection', 'appraisal', 'lender', 'mortgage', 'loan', 'escrow',
  'earnest', 'contingency', 'contingencies', 'commission', 'sale price', 'sold for', 'list price', 'listing price', 'asking price',
];
const STREET_WORDS = ['street', 'st', 'avenue', 'ave', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'boulevard', 'blvd', 'court', 'ct', 'way', 'place', 'pl', 'circle', 'cir', 'terrace', 'ter', 'parkway', 'pkwy', 'highway', 'hwy', 'trail', 'trl'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];

/**
 * Case and accent folding that keeps every index: each UTF-16 unit maps to one output unit (a letter with a combining
 * mark folds to its base letter; anything that does not fold to one unit is kept as it was, lower-cased).
 */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (base.length === ch.length) out += base;
    else {
      const low = ch.toLowerCase();
      out += low.length === ch.length ? low : ch;
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (alts: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.map((a) => esc(a).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'gu');

const RULES: { code: GuardCode; re: RegExp }[] = [
  { code: 'MONEY', re: /[$€£¥₹]|(?<![\p{L}\p{N}])\d[\d,.]*\s*(?:k|K|thousand|million|mil|grand|%|percent)(?![\p{L}\p{N}])|(?<![\p{N}])\d{1,3}(?:,\d{3})+(?![\p{N}])|(?<![\p{N}])\d{3,}(?![\p{N}])/gu },
  { code: 'ADDRESS', re: new RegExp(`(?<![\\p{L}\\p{N}])\\d+[a-z]?\\s+(?:[\\p{L}'.-]+\\s+){0,3}(?:${STREET_WORDS.join('|')})\\.?(?![\\p{L}\\p{N}])`, 'giu') },
  { code: 'DATE', re: new RegExp(`(?<![\\p{L}])(?:${MONTHS.join('|')})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![\\p{N}])|(?<![\\p{N}])\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS.join('|')})(?![\\p{L}])|(?<![\\p{N}])\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?(?![\\p{N}])`, 'giu') },
  { code: 'CONTACT', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|(?:\+?\d[\s().-]*){7,}/gu },
  { code: 'DEAL', re: word(DEAL_TERMS) },
];

/** The reviewer's display name as words (length >= 2), folded. */
export function nameWords(display: string | null): string[] {
  if (!display) return [];
  return [...new Set(fold(display).split(/[^\p{L}\p{N}]+/u).filter((w) => [...w].length >= 2))];
}

export function guardReply(text: string, o: { reviewerDisplay: string | null; fairHousing?: FairHousingPack }): ReplyGuard {
  const spans: GuardSpan[] = [];
  const folded = fold(text);
  const names = nameWords(o.reviewerDisplay);
  if (names.length > 0) for (const m of folded.matchAll(word(names))) spans.push({ code: 'REVIEWER_NAME', start: m.index, end: m.index + m[0].length });
  for (const r of RULES) for (const m of folded.matchAll(r.re)) spans.push({ code: r.code, start: m.index, end: m.index + m[0].length });
  const soft: { start: number; end: number }[] = [];
  if (o.fairHousing) {
    const fh = check(text, o.fairHousing);
    for (const m of fh.hard) spans.push({ code: 'FAIR_HOUSING', start: m.start, end: m.end });
    for (const m of fh.soft) soft.push({ start: m.start, end: m.end });
  }
  if ([...text].length > GBP_REPLY_MAX_CHARS) spans.push({ code: 'LENGTH', start: 0, end: text.length });
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code));
  const codes = GUARD_CODES.filter((c) => spans.some((s) => s.code === c));
  return { codes, spans, soft };
}
