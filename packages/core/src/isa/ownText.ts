// Client own text (R-ISA-27, R-ISA-28; E495, E507; docs/AI_ISA.md §4.3, §4.6).
//
// Only the person's OWN words, from their bound point, can become qualification, readiness, a booking or an end.
//   clientOwnText    strips quoted email history (">" lines, "On … wrote:", "-----Original Message-----", Outlook
//                    "From:/Sent:" header blocks, forwarded-message markers) and everything after it, and the
//                    signature ("-- ", "Sent from my …"). `ownTextReliable` is false when quoting is interleaved
//                    with new text (an inline reply) or a quote marker survives: such an email is never booking
//                    or quote evidence.
//   isTeamText       a quote that occurs in any of the team's own outbound texts or the offer rendering
//                    (QUOTE_IS_TEAM_TEXT): a client who pastes "Tue Nov 17, 3:00–3:30 PM ET" has not agreed.
//   qualValueQuoted  the claimed VALUE is in the quote and not negated within the clause (a negator within four
//                    tokens before the hit, read in the source, so a model cannot cut "not" off the quote).
// Pure; every lexicon is data with fixtures in ./testing.
import { NEGATOR_BEFORE } from '../compliance/index.js';
import { type IanaZone, type Instant, DAY_MS } from '../foundation/index.js';
import { type CriterionKey, PROPERTY_TYPES, criterionQuoted, foldForDetection, normalizeForQuote, resolveRelativeDate } from '../assistant/index.js';
import { ISA_OUTPUT_LIMITS } from './constants.js';
import { FINANCING_VALUES, type FinancingValue, type QualField, type QualValue } from './types.js';

export interface OwnText {
  /** The person's own words (trimmed; truncated to the inbound maximum). */
  text: string;
  /** False for an inline (interleaved) reply or a surviving quote marker: not usable as quote evidence. */
  reliable: boolean;
  /** What was removed, as codes (never content). */
  stripped: OwnTextStrip[];
  truncated: boolean;
}

export type OwnTextStrip = 'quoted_lines' | 'reply_header' | 'original_message' | 'outlook_header' | 'forwarded' | 'signature' | 'mobile_signature';

/** Lines that start a block of quoted history: everything from here on is somebody else's text. */
const HISTORY_START: readonly { re: RegExp; code: OwnTextStrip }[] = [
  // Gmail / Apple Mail: "On Tue, Nov 17, 2026 at 3:00 PM Jane <j@x.com> wrote:" (possibly wrapped over two lines)
  { re: /^\s*On\b[^\n]{0,300}?(?:\n[^\n]{0,200}?)?\bwrote:\s*$/imu, code: 'reply_header' },
  { re: /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/imu, code: 'original_message' },
  { re: /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/imu, code: 'forwarded' },
  { re: /^\s*Begin forwarded message:\s*$/imu, code: 'forwarded' },
  // Outlook: a "From:" line followed within three lines by "Sent:" or "Date:", or the underscore rule before it
  { re: /^\s*_{10,}\s*$/mu, code: 'outlook_header' },
  { re: /^\s*\*?From:\*?\s[^\n]*\n(?:[^\n]*\n){0,2}?\s*\*?(?:Sent|Date):\*?\s/imu, code: 'outlook_header' },
];

const SIGNATURE_START: readonly { re: RegExp; code: OwnTextStrip }[] = [
  { re: /^-- ?$/mu, code: 'signature' },
  { re: /^\s*(?:Sent from my\b|Sent from (?:Mail|Outlook|Yahoo|AOL)\b|Get Outlook for\b|Sent via\b|Sent with\b)[^\n]*$/imu, code: 'mobile_signature' },
];

/**
 * The person's own words of one inbound (docs/AI_ISA.md §4.6 item 3). SMS bodies are their own text as written
 * (an SMS has no quoting). Email loses quoted history and the signature.
 */
export function clientOwnText(body: string, channel: 'sms' | 'email'): OwnText {
  const max = ISA_OUTPUT_LIMITS.inboundMaxChars;
  let text = body.replace(/\r\n?/g, '\n');
  const stripped: OwnTextStrip[] = [];
  let reliable = true;
  if (channel === 'email') {
    // 1. the first quoted-history marker cuts everything after it
    let cut = text.length;
    let cutCode: OwnTextStrip | null = null;
    for (const h of HISTORY_START) {
      const m = h.re.exec(text);
      if (m !== null && m.index < cut) {
        cut = m.index;
        cutCode = h.code;
      }
    }
    if (cutCode !== null) {
      stripped.push(cutCode);
      text = text.slice(0, cut);
    }
    // 2. ">" lines: dropped; new text after a quoted line is an inline reply, which is unreliable
    const lines = text.split('\n');
    const kept: string[] = [];
    let sawQuote = false;
    for (const line of lines) {
      if (/^\s*>/.test(line)) {
        sawQuote = true;
        continue;
      }
      if (sawQuote && line.trim() !== '') reliable = false;
      kept.push(line);
    }
    if (sawQuote) stripped.push('quoted_lines');
    text = kept.join('\n');
    // 3. the signature
    let sigCut = text.length;
    let sigCode: OwnTextStrip | null = null;
    for (const s of SIGNATURE_START) {
      const m = s.re.exec(text);
      if (m !== null && m.index < sigCut) {
        sigCut = m.index;
        sigCode = s.code;
      }
    }
    if (sigCode !== null) {
      stripped.push(sigCode);
      text = text.slice(0, sigCut);
    }
    // 4. a marker that survived (e.g. "wrote:" inside the kept text) means the split is not trustworthy
    if (/\bwrote:\s*$/imu.test(text) || /^\s*(?:From|Sent|To|Subject):\s/imu.test(text)) reliable = false;
  }
  text = text.trim();
  const truncated = text.length > max;
  if (truncated) text = text.slice(0, max);
  return { text, reliable, stripped: [...new Set(stripped)], truncated };
}

// ---- team text ------------------------------------------------------------------------------------------------

/** A quote of at least this many words that occurs in team text is team text. Shorter ones ("2", "yes") never are. */
export const TEAM_TEXT_MIN_WORDS = 3;

function words(s: string): string[] {
  return normalizeForQuote(s).text.split(' ').filter((w) => w !== '');
}

/**
 * QUOTE_IS_TEAM_TEXT (R-ISA-27): the quote occurs in one of the team's own texts (every outbound of the thread, the
 * offer rendering, the AI's questions). Compared after normalization (case, whitespace, quotes, look-alikes).
 */
export function isTeamText(quote: string, teamTexts: readonly string[]): boolean {
  const q = normalizeForQuote(foldForDetection(quote)).text;
  if (words(quote).length < TEAM_TEXT_MIN_WORDS) return false;
  return teamTexts.some((t) => normalizeForQuote(foldForDetection(t)).text.includes(q));
}

// ---- the negation window --------------------------------------------------------------------------------------

const NEGATOR_TOKENS = new Set([
  'not',
  'no',
  'never',
  'nor',
  'without',
  'cannot',
  "can't",
  'cant',
  "don't",
  'dont',
  "doesn't",
  'doesnt',
  "didn't",
  'didnt',
  "isn't",
  'isnt',
  "aren't",
  'arent',
  "wasn't",
  'wasnt',
  "weren't",
  'werent',
  "haven't",
  'havent',
  "hasn't",
  'hasnt',
  "hadn't",
  'hadnt',
  "won't",
  'wont',
  "wouldn't",
  'wouldnt',
  'neither',
  'yet', // "preapproved? not yet" is caught by "not"; "yet to be preapproved" by this
]);

/** How many tokens before a hit the negation window looks at (§4.3). */
export const NEGATION_WINDOW_TOKENS = 4;

export function lowerFold(s: string): string {
  return foldForDetection(s).normalize('NFKC').toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, ' ');
}

/** Whether the clause text BEFORE a hit negates it: a negator in the last four tokens, or NEGATOR_BEFORE. */
export function negatedBefore(before: string): boolean {
  const clause = before.split(/[.!?;\n]|\bbut\b|\bhowever\b/u).pop() ?? '';
  if (NEGATOR_BEFORE.test(clause)) return true;
  const toks = clause.split(/[^\p{L}\p{N}']+/u).filter((t) => t !== '');
  return toks.slice(-NEGATION_WINDOW_TOKENS).some((t) => NEGATOR_TOKENS.has(t) || t.endsWith("n't"));
}

/** The first non-negated match of `re` in `text` (every occurrence is checked), or null. */
export function firstUnnegated(text: string, re: RegExp): RegExpExecArray | null {
  const t = lowerFold(text);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of t.matchAll(g)) {
    if (!negatedBefore(t.slice(0, m.index))) return m as unknown as RegExpExecArray;
  }
  return null;
}

/** Whether `re` matches only negated ("we're not preapproved"). */
export function onlyNegated(text: string, re: RegExp): boolean {
  const t = lowerFold(text);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const all = [...t.matchAll(g)];
  return all.length > 0 && all.every((m) => negatedBefore(t.slice(0, m.index)));
}

// ---- qualValueQuoted ------------------------------------------------------------------------------------------

/** Value-specific lexicons for the financing enum (§4.3). VERIFY. */
export const FINANCING_LEXICON: Readonly<Record<Exclude<FinancingValue, 'not_started'>, RegExp>> = Object.freeze({
  preapproved: /\bpre[\s-]?(?:approv\w*|qualif\w*)\b/u,
  cash: /\b(?:all[\s-]+)?cash\b/u,
  talking_to_lender: /\b(?:lenders?|loan\s+officers?|mortgage(?:\s+brokers?)?|bank)\b/u,
});

/** Affirmative patterns for the boolean fields; `false` needs the same pattern negated. VERIFY. */
export const BOOLEAN_LEXICON: Readonly<Record<'seller_owns_stated' | 'seller_listed_elsewhere_stated' | 'wants_agent_contact', RegExp>> = Object.freeze({
  seller_owns_stated: /\b(?:i|we)\s+(?:do\s+)?own\b|\b(?:own|owns|owned)\s+(?:the|our|my|this|it)\b|\b(?:it'?s|its|the house is|the home is)\s+(?:ours|mine|paid\s+off)\b|\bour\s+(?:house|home|place|condo|townhouse)\b|\bmy\s+(?:house|home|place|condo|townhouse)\b/u,
  seller_listed_elsewhere_stated: /\b(?:listed|listing)\s+(?:it\s+)?(?:with|by)\b|\b(?:it'?s|its|we'?re|we\s+are|house\s+is|home\s+is)\s+(?:already\s+)?(?:listed|on\s+the\s+market)\b/u,
  wants_agent_contact: /\b(?:call|phone|talk|speak|meet)\s+(?:with\s+|to\s+)?(?:me|us|you|him|her|them|the\s+agent)\b|\bhave\s+\S+\s+(?:call|reach\s+out)\b|\breach\s+out\b/u,
});

/** "not_started" is affirmative only as a negated financing step ("haven't talked to a lender"). */
const NOT_STARTED_RE = /\b(?:haven'?t|have\s+not|not\s+yet|didn'?t|did\s+not|no)\s+(?:yet\s+)?(?:been\s+)?(?:talked|spoken|started|gotten|got|applied|pre[\s-]?approv\w*|looked\s+into\s+financing|financing|lender)/u;

const QUAL_CRITERION: Partial<Record<QualField, CriterionKey>> = {
  budget: 'priceMaxCents',
  beds_min: 'bedsMin',
  baths_min: 'bathsMinX10',
  property_type: 'propertyTypes',
};

export interface QuoteContext {
  /** The whole client own text the quote was taken from (negations are read in it, not only in the quote). */
  ownText: string;
  /** When the client wrote it, and their zone (timelines resolve against them). */
  saidAt: Instant;
  zone: IanaZone;
}

/**
 * Whether `value` for `field` is actually in `quote` (R-ISA-27, §4.3). The quote must occur in the own text, and
 * a negator within the clause before the hit (in the own text) cancels it.
 */
export function qualValueQuoted(field: QualField, value: QualValue, quote: string, ctx: QuoteContext): boolean {
  const own = lowerFold(ctx.ownText);
  const q = lowerFold(quote).trim();
  if (q === '' || quote.length > ISA_OUTPUT_LIMITS.quoteMax) return false;
  const at = own.indexOf(q);
  if (at < 0) return false;
  // read every pattern on the quote, but its negation on the own text up to the hit
  const hit = (re: RegExp): boolean => {
    const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
    for (const m of q.matchAll(g)) {
      if (!negatedBefore(own.slice(0, at + (m.index as number)))) return true;
    }
    return false;
  };
  const negHit = (re: RegExp): boolean => {
    const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
    for (const m of q.matchAll(g)) if (negatedBefore(own.slice(0, at + (m.index as number)))) return true;
    return false;
  };
  switch (field) {
    case 'financing_status_stated': {
      if (typeof value !== 'string' || !(FINANCING_VALUES as readonly string[]).includes(value)) return false;
      if (value === 'not_started') return NOT_STARTED_RE.test(q);
      return hit(FINANCING_LEXICON[value as Exclude<FinancingValue, 'not_started'>]);
    }
    case 'seller_owns_stated':
    case 'seller_listed_elsewhere_stated':
    case 'wants_agent_contact': {
      if (typeof value !== 'boolean') return false;
      return value ? hit(BOOLEAN_LEXICON[field]) : negHit(BOOLEAN_LEXICON[field]);
    }
    case 'timeline':
    case 'seller_timeline': {
      if (typeof value !== 'string' || value.trim() === '') return false;
      const phrase = lowerFold(value).trim();
      if (!q.includes(phrase) || negatedBefore(own.slice(0, at + q.indexOf(phrase)))) return false;
      return timelineDays(value, ctx.saidAt, ctx.zone) !== null;
    }
    case 'areas': {
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.trim() !== '')) return false;
      const snippets = [normalizeForQuote(quote).text];
      return (value as string[]).every((v) => (/^\d{5}$/.test(v) ? criterionQuoted('postalCodes', [v], snippets) : criterionQuoted('cities', [{ city: v }], snippets)));
    }
    case 'property_type': {
      if (typeof value !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(value)) return false;
      return criterionQuoted('propertyTypes', [value], [normalizeForQuote(quote).text]);
    }
    case 'budget':
    case 'beds_min':
    case 'baths_min': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
      const key = QUAL_CRITERION[field] as CriterionKey;
      const stored = field === 'budget' ? Math.round(value * 100) : field === 'baths_min' ? Math.round(value * 10) : value;
      return criterionQuoted(key, stored, [normalizeForQuote(quote).text]) && !negatedBefore(own.slice(0, at));
    }
    case 'must_haves_structured': {
      if (!Array.isArray(value) || value.length === 0) return false;
      return (value as string[]).every((v) => typeof v === 'string' && v.trim().length >= 2 && q.includes(lowerFold(v).trim()) && !negatedBefore(own.slice(0, at + q.indexOf(lowerFold(v).trim()))));
    }
    case 'seller_motivation':
    case 'seller_next_move': {
      if (typeof value !== 'string' || value.trim().length < 2 || value.length > 80) return false;
      const v = lowerFold(value).trim();
      return q.includes(v) && !negatedBefore(own.slice(0, at + q.indexOf(v)));
    }
  }
}

// ---- timelines ------------------------------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALT = `(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join('|')})`;
const NUM_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/**
 * The LATEST number of days from `saidAt` a timeline phrase allows, or null when it is not a timeline core can
 * bound (readiness then cannot use it). Tries `resolveRelativeDate` first (an exact date), then a small grammar:
 * "asap", "now", "in/within N days|weeks|months", "next month", "by|in|before <month>", "this month". Anything
 * vaguer ("next spring", "sometime", "next year", "a few months") is null. Deterministic and conservative.
 */
export function timelineDays(phrase: string, saidAt: Instant, zone: IanaZone): number | null {
  const p = lowerFold(phrase).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (p === '') return null;
  if (/\b(?:asap|right\s+away|right\s+now|immediately|now)\b/.test(p) && !/\bnot\s+now\b/.test(p)) return 0;
  const exact = resolveRelativeDate(phrase, saidAt, zone);
  if (exact.ok) return Math.max(0, Math.ceil((exact.at - saidAt) / DAY_MS));
  const n = new RegExp(`\\b(?:in|within|in the next|next)\\s+(\\d{1,3}|${Object.keys(NUM_WORDS).join('|')})\\s+(day|week|month)s?\\b`).exec(p);
  if (n !== null) {
    const count = /^\d+$/.test(n[1] as string) ? Number(n[1]) : (NUM_WORDS[n[1] as string] as number);
    const unit = n[2] === 'day' ? 1 : n[2] === 'week' ? 7 : 31;
    return count * unit;
  }
  const d = new Date(saidAt);
  // the month arithmetic is in UTC; a day either way does not change a 90-day test meaningfully, and it errs long
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const endOfMonth = (year: number, month: number): number => Date.UTC(year, month + 1, 1) - 1;
  const daysTo = (t: number): number => Math.max(0, Math.ceil((t - saidAt) / DAY_MS));
  if (/\bthis\s+month\b/.test(p)) return daysTo(endOfMonth(y, mo));
  if (/\bnext\s+month\b/.test(p)) return daysTo(endOfMonth(mo === 11 ? y + 1 : y, (mo + 1) % 12));
  const m = new RegExp(`\\b(?:by|in|before|around|end\\s+of|early|mid|late)\\s+${MONTH_ALT}\\b`).exec(p);
  if (m !== null) {
    const name = m[1] as string;
    const idx = MONTHS.findIndex((x) => x === name || x.slice(0, 3) === name);
    const year = idx >= mo ? y : y + 1;
    return daysTo(endOfMonth(year, idx));
  }
  return null;
}
