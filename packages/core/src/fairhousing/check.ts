// The fair-housing copy check (R-FH-1, R-FH-2, R-FH-5; E93).
//
//   check(text, pack) → { hard, soft }
//
// Deterministic, normalized (./normalize.ts folds obfuscation away) and negation-aware:
//   - a bare negation never hides a match: "no children", "not for families" and "adults only" are
//     themselves hard terms;
//   - an equal-opportunity frame ("regardless of", "we do not discriminate against") right before a
//     match marks it `negated`; a negated hard match is reported as soft, so a person still sees it
//     and assistant output with it still becomes a draft (R-FH-2), but it does not block approval;
//   - `not_a_reference` exemptions ("family room", "single-family", "Church Street") drop a match
//     whose last word is part of the exempt phrase (E93: "family room" is not flagged).
// A match fully covered by a hard match of the same text span is not repeated as soft.
//
// It errs towards flagging: a false positive costs one edit or one tap; a false negative can put
// discriminatory wording in an ad. The lexicon is pack data (./lexicon.ts), VERIFY WITH COUNSEL.
import { type Token, tokenize } from './normalize.js';
import type { CheckResult, Exemption, FairHousingPack, Match, Term } from './types.js';

// ---- the phrase grammar -------------------------------------------------------------------------

export type PatternToken =
  | { kind: 'any' }
  | { kind: 'alt'; optional: boolean; options: readonly { word: string; prefix: boolean }[] };

export interface CompiledPattern {
  source: string;
  tokens: readonly PatternToken[];
  /**
   * The pattern with its words run together, as a regular expression, for merged spelled-out
   * tokens ("n o k i d s" is one token "nokids"): alternatives, optional words and prefixes carry
   * over; a `*` gap allows up to 30 letters.
   */
  squeezed: RegExp;
}

const PATTERN_WORD_RE = /^[\p{Ll}\p{N}+]+\*?$/u;

/**
 * Compile one pattern. Throws on a malformed pattern (pack data is validated when it is loaded,
 * see ./pack.ts, so this never throws at check time for a parsed pack).
 */
export function compilePattern(source: string): CompiledPattern {
  const parts = source.trim().split(/\s+/u);
  const tokens: PatternToken[] = [];
  for (const p of parts) {
    if (p === '*') {
      tokens.push({ kind: 'any' });
      continue;
    }
    const optional = p.endsWith('?');
    const body = optional ? p.slice(0, -1) : p;
    const options = body.split('|').map((o) => {
      if (!PATTERN_WORD_RE.test(o)) throw new Error(`fair-housing pattern "${source}": bad word "${o}"`);
      return o.endsWith('*') ? { word: o.slice(0, -1), prefix: true } : { word: o, prefix: false };
    });
    tokens.push({ kind: 'alt', optional, options });
  }
  if (!tokens.some((t) => t.kind === 'alt' && !t.optional)) throw new Error(`fair-housing pattern "${source}": needs at least one word`);
  const edge = (t: PatternToken): boolean => t.kind === 'any' || t.optional;
  if (edge(tokens[0] as PatternToken) || edge(tokens[tokens.length - 1] as PatternToken)) {
    throw new Error(`fair-housing pattern "${source}": cannot start or end with * or an optional word`);
  }
  return { source, tokens, squeezed: squeeze(tokens) };
}

const esc = (w: string): string => w.replace(/[+]/g, '\\+');

function squeeze(tokens: readonly PatternToken[]): RegExp {
  const parts = tokens.map((t) => {
    if (t.kind === 'any') return '[\\p{L}\\p{N}+]{0,30}?';
    const alt = `(?:${t.options.map((o) => (o.prefix ? `${esc(o.word)}[\\p{L}\\p{N}+]*?` : esc(o.word))).join('|')})`;
    return t.optional ? `${alt}?` : alt;
  });
  return new RegExp(parts.join(''), 'u');
}

function wordMatches(tok: string, opt: { word: string; prefix: boolean }): boolean {
  return opt.prefix ? tok.startsWith(opt.word) : tok === opt.word;
}

/** Index of the last token of a match of `pat` starting at token `i`, or -1. */
function matchFrom(tokens: readonly Token[], i: number, pat: readonly PatternToken[], j: number): number {
  if (j === pat.length) return i - 1;
  const p = pat[j] as PatternToken;
  if (p.kind === 'any') {
    // zero tokens, then one token (same sentence)
    // `*` is never first, so a previous token always exists
    const skip = matchFrom(tokens, i, pat, j + 1);
    if (skip !== -1) return skip;
    const t = tokens[i];
    if (t === undefined || (tokens[i - 1] as Token).sentence !== t.sentence) return -1;
    return matchFrom(tokens, i + 1, pat, j + 1);
  }
  if (p.optional) {
    const taken = matchAlt(tokens, i, p, pat, j);
    return taken !== -1 ? taken : matchFrom(tokens, i, pat, j + 1);
  }
  return matchAlt(tokens, i, p, pat, j);
}

function matchAlt(tokens: readonly Token[], i: number, p: Extract<PatternToken, { kind: 'alt' }>, pat: readonly PatternToken[], j: number): number {
  const t = tokens[i];
  if (t === undefined) return -1;
  if (j > 0) {
    const prev = tokens[i - 1] as Token;
    if (prev.sentence !== t.sentence) return -1; // a phrase never spans two sentences
  }
  if (!p.options.some((o) => wordMatches(t.text, o))) return -1;
  return matchFrom(tokens, i + 1, pat, j + 1);
}

/** Every [firstToken, lastToken] span where the pattern matches. */
export function findSpans(tokens: readonly Token[], pat: CompiledPattern): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.merged) {
      if (pat.squeezed.test(t.text)) spans.push([i, i]);
      continue;
    }
    const end = matchFrom(tokens, i, pat.tokens, 0);
    if (end >= 0) spans.push([i, end]);
  }
  return spans;
}

// ---- compiled packs ----------------------------------------------------

interface CompiledTerm {
  term: Term;
  severity: 'hard' | 'soft';
  patterns: CompiledPattern[];
}
interface CompiledExemption {
  exemption: Exemption;
  patterns: CompiledPattern[];
}
interface CompiledPack {
  terms: CompiledTerm[];
  exemptions: CompiledExemption[];
}

function compilePack(pack: FairHousingPack): CompiledPack {
  return {
    terms: [
      ...pack.hard.map((term) => ({ term, severity: 'hard' as const, patterns: term.patterns.map(compilePattern) })),
      ...pack.soft.map((term) => ({ term, severity: 'soft' as const, patterns: term.patterns.map(compilePattern) })),
    ],
    exemptions: pack.exemptions.map((exemption) => ({ exemption, patterns: exemption.patterns.map(compilePattern) })),
  };
}

/** Tokens after an equal-opportunity frame within which a match counts as negated. */
export const FRAME_WINDOW = 3;

// ---- the check ----------------------------------------------------------------------------------

/**
 * Invisible characters are read two ways: dropped ("fa\u200Bmilies" is "families") and as word
 * breaks ("adults\u00ADonly" is "adults only"). A match in either reading counts.
 */
export function check(text: string, pack: FairHousingPack): CheckResult {
  const c = compilePack(pack);
  const raw: Match[] = [];
  for (const tokens of [tokenize(text), tokenize(text, { invisibleBreaks: true })]) {
    const spansOf = (effect: Exemption['effect']): [number, number][] =>
      c.exemptions.filter((e) => e.exemption.effect === effect).flatMap((e) => e.patterns.flatMap((p) => findSpans(tokens, p)));
    const notARef = spansOf('not_a_reference');
    const frames = spansOf('anti_discrimination');
    const exempt = (last: number): boolean => notARef.some(([a, b]) => last >= a && last <= b);
    // inside the frame, or at most FRAME_WINDOW tokens after its end, in the frame's sentence
    const negated = (first: number): boolean =>
      frames.some(([a, b]) => first >= a && first <= b + FRAME_WINDOW && (tokens[b] as Token).sentence === (tokens[first] as Token).sentence);
    for (const ct of c.terms) {
      for (const p of ct.patterns) {
        for (const [a, b] of findSpans(tokens, p)) {
          if (exempt(b)) continue;
          const start = (tokens[a] as Token).start;
          const end = (tokens[b] as Token).end;
          const neg = negated(a);
          const severity = ct.severity === 'hard' && !neg ? 'hard' : 'soft';
          if (raw.some((m) => m.termId === ct.term.id && m.start === start && m.end === end)) continue;
          raw.push({ termId: ct.term.id, label: ct.term.label, class: ct.term.class, severity, start, end, text: text.slice(start, end), negated: neg });
        }
      }
    }
  }
  // a soft match inside a hard match's span adds nothing
  const kept = raw.filter((m) => m.severity === 'hard' || !raw.some((h) => h.severity === 'hard' && h.start <= m.start && m.end <= h.end));
  kept.sort((x, y) => x.start - y.start || y.end - x.end || x.termId.localeCompare(y.termId));
  return { hard: kept.filter((m) => m.severity === 'hard'), soft: kept.filter((m) => m.severity === 'soft') };
}

/** True when the text has any hard or soft match (assistant output with one is never autonomous, R-FH-2). */
export function hasAnyMatch(r: CheckResult): boolean {
  return r.hard.length > 0 || r.soft.length > 0;
}
