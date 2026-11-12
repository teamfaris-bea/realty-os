// The statement rules of a client CMA (module 71, D9 V2-A; R-CMA-9, E604, E605). Pure, and exported for ISA-3's comps
// email (docs/AI_ISA.md §6.3): a valuation statement, an attribution and a disclaimer are never substituted, and a
// statement is never set smaller than 12 pt or the state's minimum.
//
// Printable (rule 5): a text t (NFC, CRLF made LF) is renderable iff winAnsi(t) === fold(t), where fold is exactly the
// four replacements the PDF renderer makes (pdf.ts winAnsi: curly single and double quotes, en and em dashes, NBSP).
// So curly quotes, dashes, NBSP and CRLF are allowed (folded in the PDF, unchanged in the email); anything NFKC alone
// changes ("…", "™", "²", ligatures), anything the renderer turns into '?' (an emoji, "•", "Đ"), a tab and a lone CR
// are refused, naming their code points.
//
// Prominence: the PDF sets a statement at the smallest renderer size that is ≥ max(12, minPointSize) (a fractional
// minimum moves up to the next size), and refuses one above the largest. A plain-text email carries no type size, so
// it carries a statement only when its minimum is ≤ 12 (owner question e). VERIFY WITH COUNSEL / MLS.
import { SIZE, winAnsi } from './deps.js';

export type Prominence = 'display' | 'heading' | 'body' | 'small' | 'footnote';

/** The renderer's four folds (pdf.ts winAnsi, after its NFKC step), restated: statement.test.ts pins them to winAnsi. */
export function fold(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** NFC with CRLF made LF: the text a statement is judged and sent as. */
export function canonicalText(s: string): string {
  return s.normalize('NFC').replace(/\r\n/g, '\n');
}

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

export type Printable = { ok: true; text: string } | { ok: false; codePoints: string[] };

/** Whether the PDF renders `text` without a substitution (rule 5); the refused code points, in order, once each. */
export function printable(text: string): Printable {
  const t = canonicalText(text);
  if (winAnsi(t) === fold(t)) return { ok: true, text: t };
  const bad: string[] = [];
  for (const ch of t) {
    if (winAnsi(ch) !== fold(ch)) {
      const c = hex(ch.codePointAt(0)!);
      if (!bad.includes(c)) bad.push(c);
    }
  }
  // a difference only in a combination of characters (never seen with NFC input): name the whole text's first one
  return { ok: false, codePoints: bad.length > 0 ? bad : [hex(t.codePointAt(0) ?? 0)] };
}

/** The renderer's sizes that a statement may take, smallest first (never small or footnote: below 12 pt). */
const STATEMENT_PROMINENCES: readonly Prominence[] = (['body', 'heading', 'display'] as const).filter((p) => SIZE[p] !== undefined).sort((a, b) => SIZE[a]! - SIZE[b]!);

/** The PDF prominence of a statement with this minimum point size, or null when no renderer size is large enough. */
export function statementProminence(minPointSize: number): Prominence | null {
  if (!Number.isFinite(minPointSize)) return null;
  const need = Math.max(12, minPointSize);
  return STATEMENT_PROMINENCES.find((p) => SIZE[p]! >= need) ?? null;
}

/** The largest minimum a plain-text email carries (owner question e: no type size in plain text; VERIFY WITH COUNSEL). */
export const EMAIL_MAX_STATEMENT_POINT_SIZE = 12;

/** Whether a plain-text email may carry a statement with this minimum point size. */
export function emailStatementOk(minPointSize: number): boolean {
  return Number.isFinite(minPointSize) && minPointSize <= EMAIL_MAX_STATEMENT_POINT_SIZE;
}
