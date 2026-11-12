// The leadmetadata.org convention (R-LEM-10): a lead notification's HTML part labels the lead in <meta> elements,
//   <meta name="lead_information_version" content="1.0">
//   <meta name="lead_name" content="Jane Q. Buyer"> <meta name="lead_email" content="jane@example.test"> ...
// in the head or the body. Pure, linear: one hand-written pass over the RAW HTML (no backtracking regex over the
// document), capped at MAX_INPUT_CHARS.
//
// Only real <meta name="lead_..." content="..."> elements are read: never text that entity decoding produces (an
// escaped &lt;meta ...&gt; is text, not a tag), never a text/plain part, never anything inside <!-- -->, <script>,
// <style>, <textarea> or <title>. The content attribute is entity-decoded only after the tag is recognised, then
// cleaned. An unknown version is not read. A lead_* name appearing twice with different values is a conflict (the
// email is held PARTIAL_FORMAT). lead_source is read (for the conflict check) but never changes the lead source.
// The values are prepended to the normalized body as "lead_name: …" lines (index.ts), so every span points into it.
import { cleanField } from './fields.js';
import { cutAt, decodeEntities } from './html.js';
import { MAX_INPUT_CHARS } from './limits.js';

export const LEAD_META_VERSION_NAME = 'lead_information_version';
/** The only version we read. */
export const LEAD_META_VERSION = '1.0';

/**
 * The lead_* names we read, in the order they are prepended. lead_name, lead_email, lead_source and lead_type are
 * confirmed in the spec; VERIFY 3: lead_phone, lead_message and lead_property_address (names to be confirmed).
 */
export const LEAD_META_NAMES = ['lead_name', 'lead_email', 'lead_phone', 'lead_message', 'lead_property_address', 'lead_type', 'lead_source'] as const;
export type LeadMetaName = (typeof LEAD_META_NAMES)[number];

/** At most this many lead_* meta elements are read; the rest are ignored. */
export const MAX_META_TAGS = 64;
/** A value is capped at this many characters (after decoding and cleaning). */
export const MAX_META_VALUE = 2000;
/** Raw attribute text kept per attribute before decoding (decoding only shrinks). */
const MAX_RAW_ATTR = 8 * MAX_META_VALUE;
const MAX_TAG_NAME = 16;
const MAX_ATTR_NAME = 64;

/** Elements whose content is never markup we read (unterminated ⇒ to the end). */
const OPAQUE = new Set(['script', 'style', 'textarea', 'title']);

export interface LeadMetadata {
  /** a lead_information_version element says 1.0 (and none says otherwise) */
  declared: boolean;
  /** non-empty values of the names we read, in LEAD_META_NAMES order; conflicting names are left out */
  values: { name: LeadMetaName; value: string }[];
  /** names that appeared twice with different values */
  conflicts: string[];
}

const NONE: LeadMetadata = { declared: false, values: [], conflicts: [] };
const KNOWN: ReadonlySet<string> = new Set(LEAD_META_NAMES);

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isNameChar = (c: number) => isAlpha(c) || isDigit(c) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** True when src[at..] starts with `name` (ASCII, case-insensitive; `name` is lowercase). */
function matchesCI(src: string, at: number, name: string): boolean {
  if (at + name.length > src.length) return false;
  for (let k = 0; k < name.length; k++) {
    let c = src.charCodeAt(at + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== name.charCodeAt(k)) return false;
  }
  return true;
}

/** The value of a meta content attribute: entity-decoded (after the tag was recognised), NFKC, cleaned, capped. */
export function metaValue(raw: string): string {
  return cleanField(decodeEntities(raw.slice(0, MAX_RAW_ATTR)).normalize('NFKC'), MAX_META_VALUE);
}

/** Never throws; linear in min(html.length, MAX_INPUT_CHARS). */
export function scanLeadMetadata(html: unknown): LeadMetadata {
  if (typeof html !== 'string' || html.indexOf('<') < 0) return NONE;
  const src = cutAt(html, MAX_INPUT_CHARS);
  const n = src.length;
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  let metas = 0;
  let declaredV1 = false;

  let i = 0;
  while (i < n && metas < MAX_META_TAGS) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
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
      i++;
      continue;
    }
    let p = j;
    while (p < n && isNameChar(src.charCodeAt(p))) p++;
    const name = p - j <= MAX_TAG_NAME ? src.slice(j, p).toLowerCase() : '';
    const collect = !closing && name === 'meta';
    const attrs = new Map<string, string>();

    // attributes: name[=value], value quoted ('…' or "…") or unquoted; the first of a repeated name wins
    for (;;) {
      while (p < n && (isSpace(src.charCodeAt(p)) || src.charCodeAt(p) === 47)) p++;
      if (p >= n || src.charCodeAt(p) === 62 /* > */) break;
      const as = p;
      while (p < n) {
        const c = src.charCodeAt(p);
        if (isSpace(c) || c === 47 || c === 62 || c === 61 /* = */) break;
        p++;
      }
      const an = p - as <= MAX_ATTR_NAME ? src.slice(as, p).toLowerCase() : '';
      while (p < n && isSpace(src.charCodeAt(p))) p++;
      let value = '';
      if (p < n && src.charCodeAt(p) === 61) {
        p++;
        while (p < n && isSpace(src.charCodeAt(p))) p++;
        const q = src.charCodeAt(p);
        if (q === 34 || q === 39) {
          const e = src.indexOf(q === 34 ? '"' : "'", p + 1);
          if (e < 0) {
            p = n;
            break;
          }
          if (collect) value = src.slice(p + 1, Math.min(e, p + 1 + MAX_RAW_ATTR));
          p = e + 1;
        } else {
          const vs = p;
          while (p < n && !isSpace(src.charCodeAt(p)) && src.charCodeAt(p) !== 62) p++;
          if (collect) value = src.slice(vs, Math.min(p, vs + MAX_RAW_ATTR));
        }
      }
      if (collect && an !== '' && !attrs.has(an)) attrs.set(an, value);
    }
    if (p >= n) break; // unterminated tag: nothing more is read
    i = p + 1;

    if (!closing && OPAQUE.has(name)) {
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
    if (!collect) continue;

    const metaName = decodeEntities(attrs.get('name') ?? '').trim().toLowerCase();
    if (!metaName.startsWith('lead_') || !attrs.has('content')) continue;
    metas++;
    if (metaName !== LEAD_META_VERSION_NAME && !KNOWN.has(metaName)) continue;
    let value = metaValue(attrs.get('content')!);
    if (metaName === 'lead_email') value = value.toLowerCase();
    if (metaName === LEAD_META_VERSION_NAME && value === LEAD_META_VERSION) declaredV1 = true;
    const prev = seen.get(metaName);
    if (prev === undefined) seen.set(metaName, value);
    else if (prev !== value) conflicts.add(metaName);
  }

  // an unknown version is not read; a 1.0 declaration contradicted by another version is a conflict (held)
  if (!declaredV1) return NONE;
  const values: LeadMetadata['values'] = [];
  for (const k of LEAD_META_NAMES) {
    const v = seen.get(k);
    if (v !== undefined && v !== '' && !conflicts.has(k)) values.push({ name: k, value: v });
  }
  return { declared: true, values, conflicts: [...conflicts].sort() };
}

/** The lines prepended to the normalized body ("lead_name: …"), ending with a blank line; '' when nothing is read. */
export function metadataPrefix(meta: LeadMetadata): string {
  if (!meta.declared || meta.values.length === 0) return '';
  return meta.values.map((v) => `${v.name}: ${v.value}\n`).join('') + '\n';
}
