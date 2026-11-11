// Tag names (R-PAR-6): one spelling per tenant, compared case- and width-insensitively, stored trimmed.
//
// The database is the authority on uniqueness: `tags.name_key` is generated as
// lower(normalize(name, NFKC)) and unique per tenant. `normalizeTagName` produces the stored display
// form (whitespace collapsed and trimmed, invisible characters dropped, control characters refused,
// 1-64 characters) and the same key the database will compute, so the UI can say "Buyer already
// exists" before the round trip (E165). Pure.

export const TAG_NAME_MAX = 64;
export const TAG_LIMIT_PER_TENANT = 1_000;
export const TAG_LIMIT_PER_CONTACT = 100;

/** The 12 palette tokens of `tags.color` (NULL = no color). */
export const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'slate'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export type TagNameIssueCode = 'TAG_NAME_EMPTY' | 'TAG_NAME_TOO_LONG' | 'TAG_NAME_INVALID';
export type TagNameResult = { ok: true; name: string; key: string } | { ok: false; code: TagNameIssueCode };

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SPACES_RE = /\s+/gu; // with the u flag \s covers every Unicode space (NBSP, U+2000-U+200A, U+2028/9, U+3000)

/** The display form and the case/width-insensitive key of a typed tag name. */
export function normalizeTagName(raw: string): TagNameResult {
  if (typeof raw !== 'string') return { ok: false, code: 'TAG_NAME_INVALID' };
  // tabs and newlines are whitespace here (collapsed); other control characters are refused
  const spaced = raw.replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ');
  if (CONTROL_RE.test(spaced)) return { ok: false, code: 'TAG_NAME_INVALID' };
  const name = spaced.trim();
  if (name === '') return { ok: false, code: 'TAG_NAME_EMPTY' };
  if ([...name].length > TAG_NAME_MAX) return { ok: false, code: 'TAG_NAME_TOO_LONG' };
  return { ok: true, name, key: tagNameKey(name) };
}

/** The same key as `tags.name_key` (lower(normalize(name, NFKC))). */
export function tagNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

// The importer's opt-out tag patterns (core/import fub.ts TAG_DNC / TAG_OPT_OUT / TAG_UNSUB), matched
// on the normalized name. R-PAR-7: such a tag never blocks anything; adding one prompts the real
// person-level do-not-contact instead (E167).
const TAG_DNC = /^(dnc|do[\s_-]*not[\s_-]*(contact|call))$/i;
const TAG_OPT_OUT = /^(opted[\s_-]*out|opt[\s_-]*out|stop)$/i;
const TAG_UNSUB = /^unsubscribed$/i;

/** True when a tag name reads like an opt-out ("DNC", "Opt out", "Unsubscribed"). It changes nothing by itself. */
export function tagReadsLikeOptOut(name: string): boolean {
  const n = normalizeTagName(name);
  if (!n.ok) return false;
  return TAG_DNC.test(n.name) || TAG_OPT_OUT.test(n.name) || TAG_UNSUB.test(n.name);
}
