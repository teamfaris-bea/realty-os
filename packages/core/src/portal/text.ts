// Plain-text helpers for portal copies. Lengths are counted in Unicode code points, as Postgres
// length() counts characters of a UTF-8 text: a JavaScript string's .length (UTF-16 units) would
// count an astral character twice.

/** portal_items.title: length(btrim(title)) BETWEEN 1 AND 120. */
export const TITLE_MAX = 120;
/** portal_items.body: length(body) <= 4000. */
export const BODY_MAX = 4000;
/** Ends a title that was shortened, so the cut is visible. */
export const ELLIPSIS = '…';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** C0 and C1 controls except tab, line feed and carriage return. */
// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Every control character (titles are one line). */
// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** Bidirectional embedding, override and isolate controls: they can reorder how a title reads. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Lone surrogates become U+FFFD (Postgres cannot store them). */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

/** Verbatim text may be published only as it is: well formed, no control other than tab and newlines. */
export function isPlainVerbatim(s: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  FORBIDDEN_CONTROL.lastIndex = 0;
  return !LONE_SURROGATE.test(s) && !FORBIDDEN_CONTROL.test(s);
}

/**
 * A one-line title from staff-entered text: whitespace runs (tabs, newlines, U+00A0, U+3000, …) become
 * one space, controls and bidi controls are dropped, the ends are trimmed (JavaScript trim, so the
 * result has no leading or trailing U+0020 and Postgres's one-argument btrim changes nothing), and a
 * title over 120 code points is shortened visibly: 119 code points and an ellipsis. Empty after
 * cleaning ⇒ `fallback`.
 */
export function cleanTitle(raw: string, fallback: string): string {
  const one = wellFormed(raw).replace(/\s+/gu, ' ').replace(ANY_CONTROL, '').replace(BIDI_CONTROL, '').replace(/\s+/gu, ' ').trim();
  const t = one === '' ? fallback : one;
  const cps = Array.from(t);
  if (cps.length <= TITLE_MAX) return t;
  return `${cps.slice(0, TITLE_MAX - 1).join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * Verbatim text for a body. publishable() refuses text that is not plain or is over 4000 code points,
 * so a published copy is always exactly the source. For a staff preview of such text this stays
 * within the CHECK and shows what happened instead of cutting silently: a forbidden character
 * becomes U+FFFD and an over-long text ends with a visible "shortened" marker.
 */
export function verbatimBody(raw: string): string | null {
  if (raw === '') return null;
  const plain = wellFormed(raw).replace(FORBIDDEN_CONTROL, '�');
  const cps = Array.from(plain);
  if (cps.length <= BODY_MAX) return plain;
  const marker = `${ELLIPSIS} [shortened here: the full text is ${cps.length} characters]`;
  return `${cps.slice(0, BODY_MAX - codePointLength(marker)).join('')}${marker}`;
}
