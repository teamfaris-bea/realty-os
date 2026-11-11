// A single-pass, linear-time HTML → text scanner for lead emails (no backtracking regex over the input).
// Tags are dropped (attributes, hence href/src URLs, are never kept; link text is), the content of
// script/style/head/title/template/noscript is dropped (unterminated ⇒ dropped to the end), <br> and
// block-closing tags become newlines (</p>, </h1-6>, </ul>, </ol>, </table>: a blank line, so a multi-line
// label value ends with its block), and only a handful of entities are decoded.
import { MAX_INPUT_CHARS } from './limits.js';

const RAW_TEXT = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);
const NEWLINE_CLOSE = new Set(['p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** paragraphs, headings, lists and tables end a block: a blank line follows (a multi-line value stops there) */
const BLANK_LINE_CLOSE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table']);
/** table cells end with a space so `<td>Name:</td><td>Jane</td>` reads `Name: Jane` */
const SPACE_CLOSE = new Set(['td', 'th']);
const NAMED: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&nbsp;', ' '],
];
const MAX_TAG_NAME = 16;
/** our own input cap, whatever maxChars asks for (markup inflates text, hence above MAX_INPUT_CHARS) */
export const MAX_HTML_INPUT_CHARS = 5 * MAX_INPUT_CHARS;

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameChar = (c: number) => isAlpha(c) || isDigit(c) || c === 45 /* - */ || c === 58 /* : */ || c === 95; /* _ */
const isHtmlSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** Drops a trailing lone high surrogate left by a cut. */
export function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** True when src[at..] starts with `name` (ASCII, case-insensitive). */
function matchesCI(src: string, at: number, name: string): boolean {
  if (at + name.length > src.length) return false;
  for (let k = 0; k < name.length; k++) {
    let c = src.charCodeAt(at + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== name.charCodeAt(k)) return false;
  }
  return true;
}

export function htmlToText(html: string, maxChars: number = MAX_INPUT_CHARS): string {
  if (typeof html !== 'string' || html === '') return '';
  const max = typeof maxChars === 'number' && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : MAX_INPUT_CHARS;
  if (max === 0) return '';
  // our own input cap: the scan below is linear, this bounds it
  const src = cutAt(html, MAX_HTML_INPUT_CHARS);
  const n = src.length;

  // appended as a string (V8 ropes: cheap appends, one flatten at the end); never read back while growing
  let out = '';
  let len = 0;
  /** last emitted char code (0: nothing yet); tracked so we never read back from a growing string */
  let last = 0;
  /** consecutive newlines at the end of the output */
  let newlines = 0;
  const emit = (s: string) => {
    if (s === '') return;
    out += s;
    len += s.length;
    last = s.charCodeAt(s.length - 1);
    newlines = s === '\n' ? newlines + 1 : last === 10 ? 1 : 0;
  };
  /** a text run: whitespace collapses to one space, none at a line start or after a space */
  const emitText = (a: number, b: number) => {
    let runStart = -1;
    for (let p = a; p < b; p++) {
      const c = src.charCodeAt(p);
      if (isHtmlSpace(c)) {
        if (runStart >= 0) {
          emit(src.slice(runStart, p));
          runStart = -1;
        }
        if (last !== 0 && last !== 10 && last !== 32) emit(' ');
      } else if (runStart < 0) runStart = p;
      if (len >= max) return;
    }
    if (runStart >= 0) emit(src.slice(runStart, b));
  };

  let nextLt = -1;
  let nextAmp = -1;
  let i = 0;
  while (i < n && len < max) {
    if (nextLt < i) {
      nextLt = src.indexOf('<', i);
      if (nextLt < 0) nextLt = n;
    }
    if (nextAmp < i) {
      nextAmp = src.indexOf('&', i);
      if (nextAmp < 0) nextAmp = n;
    }
    const k = Math.min(nextLt, nextAmp);
    if (k > i) {
      emitText(i, k);
      i = k;
      continue;
    }
    if (k >= n) break;

    if (src.charCodeAt(i) === 38 /* & */) {
      i = decodeEntity(src, i, emit);
      continue;
    }

    // '<'
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      const e = src.indexOf('>', i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const closing = c1 === 47; /* / */
    const j = i + (closing ? 2 : 1);
    if (j >= n || !isAlpha(src.charCodeAt(j))) {
      emit('<');
      i++;
      continue;
    }
    let p = j;
    while (p < n && isNameChar(src.charCodeAt(p))) p++;
    const name = p - j <= MAX_TAG_NAME ? src.slice(j, p).toLowerCase() : '';
    // the end of the tag, respecting quoted attribute values
    let quote = 0;
    let prevSig = 0;
    for (; p < n; p++) {
      const c = src.charCodeAt(p);
      if (quote !== 0) {
        if (c === quote) {
          quote = 0;
          prevSig = c;
        }
        continue;
      }
      if (c === 62 /* > */) break;
      if ((c === 34 || c === 39) && prevSig === 61 /* = */) quote = c;
      else if (!isHtmlSpace(c)) prevSig = c;
    }
    if (p >= n) break; // unterminated tag: drop to the end
    const selfClosing = src.charCodeAt(p - 1) === 47;
    i = p + 1;

    if (!closing && !selfClosing && RAW_TEXT.has(name)) {
      let s = i;
      for (;;) {
        const c = src.indexOf('</', s);
        if (c < 0) {
          i = n;
          break;
        }
        const after = c + 2 + name.length;
        if (matchesCI(src, c + 2, name) && (after >= n || !isNameChar(src.charCodeAt(after)))) {
          const e = src.indexOf('>', after);
          i = e < 0 ? n : e + 1;
          break;
        }
        s = c + 2;
      }
      continue;
    }
    if (closing && BLANK_LINE_CLOSE.has(name)) {
      while (newlines < 2 && last !== 0) emit('\n');
    } else if (name === 'br') emit('\n');
    else if (closing && NEWLINE_CLOSE.has(name)) {
      if (newlines === 0) emit('\n');
    }
    else if (closing && SPACE_CLOSE.has(name) && last !== 0 && last !== 10 && last !== 32) emit(' ');
  }
  return cutAt(out, max);
}

/** Decodes the entity at src[i] (an '&'); returns the index after it. Unknown entities stay literal. */
function decodeEntity(src: string, i: number, emit: (s: string) => void): number {
  const c1 = src.charCodeAt(i + 1);
  for (const [ent, ch] of NAMED) {
    if (ent.charCodeAt(1) !== c1) continue;
    if (src.startsWith(ent, i)) {
      emit(ch);
      return i + ent.length;
    }
  }
  if (src.charCodeAt(i + 1) === 35 /* # */) {
    const x = src.charCodeAt(i + 2);
    const hex = x === 120 || x === 88; /* x X */
    const start = i + (hex ? 3 : 2);
    const maxDigits = hex ? 6 : 8;
    let p = start;
    while (p < src.length && p - start < maxDigits && (hex ? isHex(src.charCodeAt(p)) : isDigit(src.charCodeAt(p)))) p++;
    if (p > start && src.charCodeAt(p) === 59 /* ; */) {
      const cp = Number.parseInt(src.slice(start, p), hex ? 16 : 10);
      // valid code points only (no NUL, no surrogates), else the entity is dropped
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) emit(String.fromCodePoint(cp));
      return p + 1;
    }
  }
  emit('&');
  return i + 1;
}
