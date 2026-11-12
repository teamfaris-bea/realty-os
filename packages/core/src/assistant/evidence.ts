// Evidence refs and verbatim quote verification (A2; R-AST-1, R-AST-2; E33).
//
// The assistant never asserts something it cannot point at. Every claim cites the exact words in a
// source (a call transcript, a text, an email, a note, a listing field ...). `verifyQuote` checks
// that the cited snippet really is there:
//   - whitespace, case and typographic quotes/dashes are normalized on both sides (NFKC, smart
//     quotes → straight, en/em dashes → '-', '…' → '...', runs of whitespace → one space);
//   - surrounding quote marks and edge punctuation of the snippet are ignored (models often wrap
//     a quote in “…” or drop the final period), but nothing inside the snippet is;
//   - for transcripts, the match must fall within the cited [startMs, endMs] widened by one
//     segment on each side (the model's offsets are segment-granular at best);
//   - for a char_range, the match must lie inside the cited range;
//   - for a field, the snippet must appear in that field's value.
// A snippet that does not appear is NOT_FOUND; one that appears only elsewhere is OUT_OF_RANGE.
// Either way the claim becomes needs_review and is never used in outbound text, search criteria
// or due dates (R-AST-5).
import type { Instant } from '../foundation/index.js';
import { instant } from '../foundation/index.js';
import type { EvidenceRef, Locator, QuoteFailure, SourceType } from './types.js';
import { SNIPPET_MAX } from './types.js';

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
}

/** Who wrote a text source. Client-authored content is untrusted in prompts (R-AST-14). */
export type Author = 'client' | 'agent' | 'assistant' | 'system';

/** The plaintext of one source, as the API decrypted/loaded it for this one contact. */
export type SourceText =
  | { kind: 'text'; sourceType: SourceType; sourceId: string; handle?: string; text: string; at: Instant; author: Author }
  | { kind: 'transcript'; sourceType: 'call'; sourceId: string; handle?: string; startedAt: Instant; segments: readonly TranscriptSegment[] }
  | {
      kind: 'fields';
      sourceType: SourceType;
      sourceId: string;
      handle?: string;
      at: Instant;
      fields: Readonly<Record<string, string | number | boolean | null>>;
    };

/** Sources by `${sourceType}:${sourceId}` and by prompt handle (e.g. "S3"). */
export interface SourceIndex {
  byKey: ReadonlyMap<string, SourceText>;
  byHandle: ReadonlyMap<string, SourceText>;
}

export function sourceKey(sourceType: SourceType, sourceId: string): string {
  return `${sourceType}:${sourceId.toLowerCase()}`;
}

export function sourceIndex(sources: readonly SourceText[]): SourceIndex {
  const byKey = new Map<string, SourceText>();
  const byHandle = new Map<string, SourceText>();
  for (const s of sources) {
    byKey.set(sourceKey(s.sourceType, s.sourceId), s);
    if (s.handle !== undefined) byHandle.set(s.handle, s);
  }
  return { byKey, byHandle };
}

// ---- normalization ------------------------------------------------------------------------------

const SINGLE_QUOTES = /[‘’‚‛′`´ʼ]/u;
const DOUBLE_QUOTES = /[“”„‟″«»]/u;
const DASHES = /[‐‑‒–—―−]/u;

function foldChar(ch: string): string {
  if (/\s/u.test(ch)) return ' ';
  if (SINGLE_QUOTES.test(ch)) return "'";
  if (DOUBLE_QUOTES.test(ch)) return '"';
  if (DASHES.test(ch)) return '-';
  if (ch === '…') return '...';
  return ch.normalize('NFKC').toLowerCase();
}

export interface Normalized {
  text: string;
  /** For each UTF-16 unit of `text`, the index of the raw character it came from. */
  map: number[];
}

/** Normalizes whitespace, case, quotes and dashes, keeping a map back to raw offsets. */
export function normalizeForQuote(raw: string): Normalized {
  let text = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of raw) {
    const folded = foldChar(ch);
    for (const unit of folded) {
      if (unit === ' ' && (text === '' || text.endsWith(' '))) continue; // collapse / trim start
      text += unit;
      for (let k = 0; k < unit.length; k++) map.push(i);
    }
    i += ch.length;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

const EDGE = /^[\s"'.,!?;:()[\]{}\-–—“”‘’]+|[\s"'.,!?;:()[\]{}\-–—“”‘’]+$/gu;

/** The snippet as it is searched for: normalized, with edge punctuation and wrapping quotes dropped. */
export function normalizeSnippet(snippet: string): string {
  return normalizeForQuote(snippet.replace(EDGE, '')).text.replace(EDGE, '');
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whether `needle` at `i` starts and ends on a word boundary of `hay`: a quote never cuts a word
 * or a number ("budget is 500" is not in "budget is 5000", "pool" is not in "carpool").
 */
function onWordBoundaries(hay: string, i: number, len: number): boolean {
  // charAt returns '' outside the string, which is never a word character or digit
  const first = hay.charAt(i);
  const last = hay.charAt(i + len - 1);
  const before = hay.charAt(i - 1);
  const after = hay.charAt(i + len);
  if (WORD_CHAR.test(first) && WORD_CHAR.test(before)) return false;
  if (WORD_CHAR.test(last) && WORD_CHAR.test(after)) return false;
  // a number continues across a thousands separator or decimal point ("2" is not in "2,500")
  if (/\d/.test(last) && /[.,]/.test(after) && /\d/.test(hay.charAt(i + len + 1))) return false;
  if (/\d/.test(first) && /[.,]/.test(before) && /\d/.test(hay.charAt(i - 2))) return false;
  return true;
}

/** Every start index of a non-empty `needle` in `hay`, on word boundaries. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return out;
    if (onWordBoundaries(hay, i, needle.length)) out.push(i);
    from = i + 1;
  }
}

/** Whether normalized `needle` occurs in normalized `hay` as whole words (see onWordBoundaries). */
export function containsWords(hay: string, needle: string): boolean {
  return needle !== '' && occurrences(hay, needle).length > 0;
}

/** Raw [start, end) of the normalized match at `i` (indexes are in bounds by construction). */
function rawSpan(hay: Normalized, i: number, len: number): [number, number] {
  return [hay.map[i] as number, (hay.map[i + len - 1] as number) + 1];
}

// ---- locating -----------------------------------------------------------------------------------

export interface QuoteMatch {
  /** Raw offsets in the source text (for transcripts: in the space-joined segment texts). */
  rawStart: number;
  rawEnd: number;
  /** Transcript only: first and last segment the match touches. */
  segFirst?: number;
  segLast?: number;
  /** When the quoted words were said or written (source timestamp; transcripts: segment start). */
  at: Instant;
  inRange: boolean;
}

export type QuoteLocation = { found: false } | { found: true; matches: QuoteMatch[] };

function segmentRange(segments: readonly TranscriptSegment[], startMs: number, endMs: number): [number, number] | null {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || startMs > endMs || segments.length === 0) return null;
  let first = -1;
  let last = -1;
  segments.forEach((s, i) => {
    if (s.startMs <= endMs && s.endMs >= startMs) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) {
    // The cited range falls between (or beyond) segments: the neighbours on each side.
    const after = segments.findIndex((s) => s.startMs > endMs);
    if (after < 0) return [segments.length - 1, segments.length - 1];
    first = Math.max(0, after - 1);
    last = after;
    return [first, last];
  }
  return [Math.max(0, first - 1), Math.min(segments.length - 1, last + 1)];
}

/** Finds every occurrence of the ref's snippet in `source` and says which ones the locator covers. */
export function locateQuote(source: SourceText, ref: Pick<EvidenceRef, 'locator' | 'snippet'>): QuoteLocation {
  const needle = normalizeSnippet(ref.snippet);
  if (needle === '') return { found: false };
  const loc: Locator = ref.locator;

  if (source.kind === 'fields') {
    const matches: QuoteMatch[] = [];
    for (const [name, value] of Object.entries(source.fields)) {
      if (value === null) continue;
      const hay = normalizeForQuote(String(value));
      for (const i of occurrences(hay.text, needle)) {
        const [rawStart, rawEnd] = rawSpan(hay, i, needle.length);
        matches.push({
          rawStart,
          rawEnd,
          at: source.at,
          inRange: loc.kind === 'field' && loc.name === name,
        });
      }
    }
    return matches.length === 0 ? { found: false } : { found: true, matches };
  }

  if (source.kind === 'text') {
    const hay = normalizeForQuote(source.text);
    const idx = occurrences(hay.text, needle);
    if (idx.length === 0) return { found: false };
    return {
      found: true,
      matches: idx.map((i) => {
        const [rawStart, rawEnd] = rawSpan(hay, i, needle.length);
        let inRange = false;
        if (loc.kind === 'message') inRange = true;
        else if (loc.kind === 'char_range') {
          inRange = Number.isInteger(loc.start) && Number.isInteger(loc.end) && loc.start >= 0 && loc.start <= loc.end && rawStart >= loc.start && rawEnd <= loc.end;
        }
        return { rawStart, rawEnd, at: source.at, inRange };
      }),
    };
  }

  // transcript: the segments joined by one space, so a quote may span a segment boundary
  const segments = [...source.segments].sort((a, b) => a.startMs - b.startMs);
  const segOfRaw: number[] = [];
  let joined = '';
  segments.forEach((s, i) => {
    if (i > 0) {
      joined += ' ';
      segOfRaw.push(i);
    }
    joined += s.text;
    for (let k = 0; k < s.text.length; k++) segOfRaw.push(i);
  });
  const hay = normalizeForQuote(joined);
  const idx = occurrences(hay.text, needle);
  if (idx.length === 0) return { found: false };
  const range = loc.kind === 'transcript_offset' ? segmentRange(segments, loc.startMs, loc.endMs) : null;
  return {
    found: true,
    matches: idx.map((i) => {
      const [rawStart, rawEnd] = rawSpan(hay, i, needle.length);
      const segFirst = segOfRaw[rawStart] as number;
      const segLast = segOfRaw[rawEnd - 1] as number;
      const inRange = range !== null && segFirst >= range[0] && segLast <= range[1];
      const startMs = Math.max(0, Math.floor((segments[segFirst] as TranscriptSegment).startMs));
      return { rawStart, rawEnd, segFirst, segLast, at: instant(source.startedAt + startMs), inRange };
    }),
  };
}

/**
 * R-AST-2: does the ref's snippet appear verbatim (modulo whitespace, case and quotes) in the
 * source, at the place the locator says? A ref whose type/id does not match the source, or whose
 * snippet is empty or longer than the stored maximum (500), is NOT_FOUND.
 */
export function verifyQuote(source: SourceText, ref: EvidenceRef): { verified: true } | { verified: false; reason: QuoteFailure } {
  if (ref.sourceType !== source.sourceType || ref.sourceId.toLowerCase() !== source.sourceId.toLowerCase()) {
    return { verified: false, reason: 'NOT_FOUND' };
  }
  if (ref.snippet.length > SNIPPET_MAX) return { verified: false, reason: 'NOT_FOUND' };
  const loc = locateQuote(source, ref);
  if (!loc.found) return { verified: false, reason: 'NOT_FOUND' };
  return loc.matches.some((m) => m.inRange) ? { verified: true } : { verified: false, reason: 'OUT_OF_RANGE' };
}

/** The first in-range match (the place the claim's words were said), or null. */
export function verifiedMatch(source: SourceText, ref: EvidenceRef): QuoteMatch | null {
  if (!verifyQuote(source, ref).verified) return null;
  // verified ⇒ found with at least one in-range match
  const loc = locateQuote(source, ref) as Extract<QuoteLocation, { found: true }>;
  return loc.matches.find((m) => m.inRange) as QuoteMatch;
}

// ---- display ------------------------------------------------------------------------------------

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${h > 0 ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

const WHERE: Record<SourceType, string> = {
  call: 'in the call',
  message: 'in the text',
  email: 'in the email',
  note: 'in a note',
  listing: 'on the listing',
  import: 'in imported history',
  behavior_event: 'in website activity',
  deal: 'on the deal',
  task: 'on a task',
  appointment: 'on the appointment',
  home_valuation: 'in the home value estimate',
};

/**
 * The agent-facing evidence line (ARCHITECTURE §11): `“call me Thursday around four” at 2:14 in
 * the call`. Tapping it opens the source at the locator. Never a score.
 */
export function formatEvidence(ref: EvidenceRef): string {
  const quote = `“${ref.snippet.replace(EDGE, '')}”`;
  switch (ref.locator.kind) {
    case 'transcript_offset':
      return `${quote} at ${clock(ref.locator.startMs)} ${WHERE[ref.sourceType]}`;
    case 'field':
      return `${quote} (${ref.locator.name.replace(/_/g, ' ')}) ${WHERE[ref.sourceType]}`;
    default:
      return `${quote} ${WHERE[ref.sourceType]}`;
  }
}
