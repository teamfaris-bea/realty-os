// Custom field definitions (R-PAR-17, R-PAR-18): typed, at most 50 live per tenant (the database
// counts under an advisory lock), key and type immutable, options archived and never removed, and no
// field may recreate a fair-housing protected attribute. The database refuses the built-in keys
// (R-AST-12 list); core also refuses a label or option matching the protected-proxy lexicon
// (CUSTOM_FIELD_PROTECTED) and points to the built-in self-reported attributes, the only home for
// such facts. **VERIFY WITH COUNSEL (C-PAR-3).** Pure.
import { protectedMatch, type ProtectedLexicon, type ProtectedMatch, DEFAULT_PROTECTED_LEXICON } from '../tags/protected.js';
import { BUILT_IN_PROTECTED_KEYS, FIELD_LABEL_MAX, FIELD_OPTION_LIMIT, FIELD_TYPES, type FieldDef, type FieldOption, type FieldType } from './types.js';

export type FieldDefIssueCode =
  | 'CUSTOM_FIELD_LABEL_INVALID'
  | 'CUSTOM_FIELD_KEY_INVALID'
  | 'CUSTOM_FIELD_TYPE_INVALID'
  | 'CUSTOM_FIELD_PROTECTED'
  | 'CUSTOM_FIELD_OPTIONS_INVALID'
  | 'CUSTOM_FIELD_ANNUAL_INVALID'
  | 'CUSTOM_FIELD_IMMUTABLE'
  | 'CUSTOM_FIELD_OPTION_REMOVED';

export type FieldDefIssue = { ok: false; code: FieldDefIssueCode; path?: string; match?: ProtectedMatch };

export interface NewFieldDefInput {
  label: string;
  fieldType: string;
  key?: string;
  options?: readonly { id?: string; label: string }[];
  annual?: boolean;
}

export interface ValidFieldDef {
  key: string;
  label: string;
  fieldType: FieldType;
  options: FieldOption[];
  annual: boolean;
}

/** Where a refused protected field should go instead (shown on the sheet, E175). */
export const PROTECTED_FIELD_POINTER =
  'This would record a fair-housing protected trait. Use the built-in self-reported details on the person instead ("the client told me").';

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const OPTION_ID_RE = /^[a-z0-9_]{1,40}$/;
// eslint-disable-next-line no-control-regex -- control characters are refused
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

/** A label as stored: whitespace collapsed and trimmed, 1-60 characters, no control characters. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/[\t\n\r]+/g, ' ').replace(/\s+/gu, ' ').trim();
  if (s === '' || CONTROL_RE.test(s) || [...s].length > FIELD_LABEL_MAX) return null;
  return s;
}

/** ASCII slug: "Home anniversary" → "home_anniversary"; may be '' for labels without Latin letters. */
export function slug(label: string, max = 40): string {
  return label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
}

/** A field key from a label (prefix `f_` when the slug does not start with a letter or is too short). */
export function keyFromLabel(label: string): string {
  let k = slug(label, 40);
  if (!/^[a-z]/.test(k)) k = `f_${k}`.slice(0, 41).replace(/_+$/g, '');
  if (k.length < 2) k = 'field';
  return k;
}

/** The first key not in `taken`: key, key_2, key_3, … (always ≤ 41 characters). */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const k = `${base.slice(0, 41 - suffix.length)}${suffix}`;
    if (!taken.has(k)) return k;
  }
}

function protectedIssue(text: string, path: string, lexicon: ProtectedLexicon): FieldDefIssue | null {
  const match = protectedMatch(text, lexicon);
  return match ? { ok: false, code: 'CUSTOM_FIELD_PROTECTED', path, match } : null;
}

function buildOptions(raw: readonly { id?: string; label: string }[], existing: readonly FieldOption[], lexicon: ProtectedLexicon): FieldOption[] | FieldDefIssue {
  if (existing.length + raw.length > FIELD_OPTION_LIMIT) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: '/options' };
  const taken = new Set(existing.map((o) => o.id));
  const labels = new Set(existing.filter((o) => o.archived !== true).map((o) => o.label.toLowerCase()));
  const out: FieldOption[] = [];
  for (const [i, o] of raw.entries()) {
    const label = cleanLabel(o.label);
    if (label === null) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/options/${i}/label` };
    const p = protectedIssue(label, `/options/${i}/label`, lexicon);
    if (p) return p;
    if (labels.has(label.toLowerCase())) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/options/${i}/label` };
    labels.add(label.toLowerCase());
    let id = o.id;
    if (id !== undefined && (!OPTION_ID_RE.test(id) || taken.has(id))) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/options/${i}/id` };
    if (id === undefined) id = uniqueKey(slug(label, 36) || `opt${existing.length + i + 1}`, taken).slice(0, 40);
    taken.add(id);
    out.push({ id, label });
  }
  return out;
}

/** Validates a new field definition (the database still enforces the limit and uniqueness). */
export function validateNewFieldDef(input: NewFieldDefInput, takenKeys: ReadonlySet<string>, lexicon: ProtectedLexicon = DEFAULT_PROTECTED_LEXICON): { ok: true; def: ValidFieldDef } | FieldDefIssue {
  const label = cleanLabel(input.label);
  if (label === null) return { ok: false, code: 'CUSTOM_FIELD_LABEL_INVALID', path: '/label' };
  if (!(FIELD_TYPES as readonly string[]).includes(input.fieldType)) return { ok: false, code: 'CUSTOM_FIELD_TYPE_INVALID', path: '/fieldType' };
  const fieldType = input.fieldType as FieldType;
  const p = protectedIssue(label, '/label', lexicon);
  if (p) return p;
  let key: string;
  if (input.key !== undefined) {
    if (!KEY_RE.test(input.key)) return { ok: false, code: 'CUSTOM_FIELD_KEY_INVALID', path: '/key' };
    if (takenKeys.has(input.key)) return { ok: false, code: 'CUSTOM_FIELD_KEY_INVALID', path: '/key' };
    key = input.key;
  } else {
    key = uniqueKey(keyFromLabel(label), new Set([...takenKeys, ...BUILT_IN_PROTECTED_KEYS]));
  }
  if ((BUILT_IN_PROTECTED_KEYS as readonly string[]).includes(key)) return { ok: false, code: 'CUSTOM_FIELD_PROTECTED', path: '/key' };
  const kp = protectedIssue(key.replace(/_/g, ' '), '/key', lexicon);
  if (kp) return kp;
  const annual = input.annual === true;
  if (annual && fieldType !== 'date') return { ok: false, code: 'CUSTOM_FIELD_ANNUAL_INVALID', path: '/annual' };
  const isSelect = fieldType === 'single_select' || fieldType === 'multi_select';
  const rawOptions = input.options ?? [];
  if (!isSelect && rawOptions.length > 0) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: '/options' };
  if (isSelect && rawOptions.length === 0) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: '/options' };
  const options = buildOptions(rawOptions, [], lexicon);
  if (!Array.isArray(options)) return options;
  return { ok: true, def: { key, label, fieldType, options, annual } };
}

export interface FieldDefPatch {
  label?: string;
  /** New options (appended; never replaces existing ones). */
  addOptions?: readonly { id?: string; label: string }[];
  /** Relabel existing options by id (E174: values keep the id). */
  renameOptions?: Readonly<Record<string, string>>;
  archiveOptions?: readonly string[];
  unarchiveOptions?: readonly string[];
  position?: number;
  key?: string;
  fieldType?: string;
}

/** Applies an edit to a definition: key and type never change, options are appended or archived, never removed. */
export function applyFieldDefPatch(def: FieldDef, patch: FieldDefPatch, lexicon: ProtectedLexicon = DEFAULT_PROTECTED_LEXICON): { ok: true; label: string; options: FieldOption[] } | FieldDefIssue {
  if ((patch.key !== undefined && patch.key !== def.key) || (patch.fieldType !== undefined && patch.fieldType !== def.fieldType)) {
    return { ok: false, code: 'CUSTOM_FIELD_IMMUTABLE' };
  }
  let label = def.label;
  if (patch.label !== undefined) {
    const l = cleanLabel(patch.label);
    if (l === null) return { ok: false, code: 'CUSTOM_FIELD_LABEL_INVALID', path: '/label' };
    const p = protectedIssue(l, '/label', lexicon);
    if (p) return p;
    label = l;
  }
  const isSelect = def.fieldType === 'single_select' || def.fieldType === 'multi_select';
  const touchesOptions = (patch.addOptions?.length ?? 0) + Object.keys(patch.renameOptions ?? {}).length + (patch.archiveOptions?.length ?? 0) + (patch.unarchiveOptions?.length ?? 0) > 0;
  if (!isSelect && touchesOptions) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: '/options' };
  const byId = new Map(def.options.map((o) => [o.id, { ...o }]));
  for (const [id, raw] of Object.entries(patch.renameOptions ?? {})) {
    const o = byId.get(id);
    const l = cleanLabel(raw);
    if (!o || l === null) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/renameOptions/${id}` };
    const p = protectedIssue(l, `/renameOptions/${id}`, lexicon);
    if (p) return p;
    o.label = l;
  }
  for (const id of patch.archiveOptions ?? []) {
    const o = byId.get(id);
    if (!o) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/archiveOptions/${id}` };
    o.archived = true;
  }
  for (const id of patch.unarchiveOptions ?? []) {
    const o = byId.get(id);
    if (!o) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: `/unarchiveOptions/${id}` };
    delete o.archived;
  }
  const kept = def.options.map((o) => byId.get(o.id)!);
  const live = kept.filter((o) => o.archived !== true).map((o) => o.label.toLowerCase());
  if (new Set(live).size !== live.length) return { ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID', path: '/options' };
  const added = buildOptions(patch.addOptions ?? [], kept, lexicon);
  if (!Array.isArray(added)) return added;
  return { ok: true, label, options: [...kept, ...added] };
}
