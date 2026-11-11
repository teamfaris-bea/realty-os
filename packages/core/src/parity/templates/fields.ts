// Merge fields of human message templates (PARITY_PLAN module 62; R-PAR-24).
//
// The set is CLOSED: contact.first_name/last_name/display_name, agent.first_name/last_name/phone/email
// (the sender's own), team.name, brokerage.name, and field.<key> for a live custom field. Anything else
// in braces is refused at save, so a template can never ask for another person's data, an internal id,
// a phone number of the contact, or anything the renderer would have to look up.
//
// Syntax: `{{ name }}` or `{{ name | fallback }}`. There is no logic, no nesting and no escaping. A
// fallback is plain text (≤ 60 characters, no braces, bars or control characters). Parsing is a single
// left-to-right scan; text outside the tokens is never interpreted.
import { type Result, fail, ok } from '../../foundation/index.js';

export const BUILT_IN_FIELDS = [
  'contact.first_name',
  'contact.last_name',
  'contact.display_name',
  'agent.first_name',
  'agent.last_name',
  'agent.phone',
  'agent.email',
  'team.name',
  'brokerage.name',
] as const;
export type BuiltInField = (typeof BUILT_IN_FIELDS)[number];

/** A custom field's key (the custom_field_defs.key CHECK). */
export const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

/** A merge field name: a built-in, or `field.<key>`. */
export type MergeField = BuiltInField | `field.${string}`;

/** The DB CHECK on message_templates.merge_fields, restated for core (the same shapes, nothing else). */
export const MERGE_FIELD_RE = /^(contact\.(first_name|last_name|display_name)|agent\.(first_name|last_name|phone|email)|team\.name|brokerage\.name|field\.[a-z][a-z0-9_]{1,40})$/;

export const FALLBACK_MAX = 60;
/** At most this many tokens in one template (a cheap bound on render work). */
export const MAX_TOKENS = 100;

export function isMergeField(s: string): s is MergeField {
  return MERGE_FIELD_RE.test(s);
}

export function customFieldKey(f: MergeField): string | null {
  return f.startsWith('field.') ? f.slice('field.'.length) : null;
}

export interface MergeToken {
  field: MergeField;
  /** null: no fallback given ("{{x}}"); a string (possibly empty after trim is refused) otherwise */
  fallback: string | null;
  /** offsets into the source text: [start, end) covers the whole `{{…}}` */
  start: number;
  end: number;
}

export type ParseErrorCode = 'MERGE_FIELD_UNKNOWN' | 'MERGE_FIELD_MALFORMED' | 'MERGE_FIELD_FALLBACK_INVALID' | 'MERGE_FIELD_TOO_MANY';

// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Parses the merge tokens of one text. Single pass: `{{` opens a token that must close with `}}` before
 * any other `{` or `}`; a lone `{` or `}` outside a token is ordinary text. Errors carry the offending
 * token text (never more than 80 characters of it) so the editor can point at it.
 */
export function parseMergeTokens(text: string): Result<{ tokens: MergeToken[] }, ParseErrorCode, { token?: string }> {
  const tokens: MergeToken[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) break;
    const close = text.indexOf('}}', open + 2);
    if (close < 0) return fail('MERGE_FIELD_MALFORMED', { token: text.slice(open, open + 80) });
    const inner = text.slice(open + 2, close);
    if (inner.includes('{') || inner.includes('}')) return fail('MERGE_FIELD_MALFORMED', { token: text.slice(open, Math.min(close + 2, open + 80)) });
    const bar = inner.indexOf('|');
    const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (!isMergeField(name)) return fail('MERGE_FIELD_UNKNOWN', { token: name.slice(0, 80) });
    let fallback: string | null = null;
    if (bar >= 0) {
      const raw = inner.slice(bar + 1);
      fallback = raw.trim();
      if (fallback.length === 0 || fallback.length > FALLBACK_MAX || fallback.includes('|') || CONTROL_RE.test(raw)) {
        return fail('MERGE_FIELD_FALLBACK_INVALID', { token: name });
      }
    }
    tokens.push({ field: name, fallback, start: open, end: close + 2 });
    if (tokens.length > MAX_TOKENS) return fail('MERGE_FIELD_TOO_MANY');
    i = close + 2;
  }
  return ok({ tokens });
}

/** The distinct fields of a list of tokens, sorted (what message_templates.merge_fields stores). */
export function fieldsOf(tokens: readonly MergeToken[]): MergeField[] {
  return [...new Set(tokens.map((t) => t.field))].sort();
}
