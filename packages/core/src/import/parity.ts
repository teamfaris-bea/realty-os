// FUB/CSV import parity (PARITY_PLAN module 65; R-PAR-46, R-PAR-6, R-PAR-8, R-PAR-10, R-PAR-17, R-PAR-18,
// E190, E191). Pure: no I/O, no clock.
//
// Inside the existing contacts stage:
//   - Stages: the source's distinct stage labels, with counts. A label that plainly names one of the eight
//     stages is suggested; every other label must be mapped by an Admin before the contacts stage can be
//     approved (STAGE_MAP_INCOMPLETE). A label never silently becomes `new`. `keepStageAsTag` adds the tag
//     "FUB stage: <label>" (Q-PAR-1 default: on).
//   - Tags: upserted into the catalog by name key (first spelling wins, R-PAR-6); a catalog that would pass
//     1,000 tags reports TAG_LIMIT for the tags that do not fit (their raw text stays in imported_fields).
//   - Custom fields: each source field maps to a new typed definition, an existing one, or is skipped. A
//     value that does not fit the type is an issue and stays as raw text in imported_fields. A field whose
//     name or options read like a protected fair-housing attribute is never created as a custom field
//     (CUSTOM_FIELD_PROTECTED, R-PAR-18): its raw text stays in imported_fields only.
//   - Opt-outs: no tag ever acts as anything but a tag, except the existing opt-out tag conversion
//     (fub.ts mapConsent: a DNC-looking tag becomes a real opt-out).
//
// Module 59 (core/parity/tags, core/parity/fields; PARITY_PLAN §4.2) decides what a tag name and its key
// are, what reads like a protected attribute and what fits a typed field. This file only reads the
// source's text into the shape those functions take:
//   normalizeTagName  → core/parity/tags normalizeTagName, after the import's clean-up of the source text
//                       (control characters out, cut to the tag length: a long FUB tag is shortened, not lost)
//   classifyProtected → core/parity/tags classifyProtected (core module 20's lexicon + the parity proxy list),
//                       exactly as the tag writer (api/lists ensureTags) applies it; fieldKeyProtected also
//                       reads a source field KEY ("customMilitaryStatus") as its words
//   typedFieldValue   → core/parity/fields validateFieldValue, after reading the source's formats ("$1,250",
//                       M/D/YYYY dates, option labels → option ids, "a, b" lists)
import { BUILT_IN_PROTECTED_KEYS, CUSTOM_FIELD_LIMIT as PARITY_FIELD_LIMIT, FIELD_TYPES as PARITY_FIELD_TYPES, type FieldDef, type FieldOption as ParityFieldOption, type FieldType as ParityFieldType, type TypedValue as ParityTypedValue, validateFieldValue } from '../parity/fields/index.js';
import { TAG_LIMIT_PER_CONTACT, TAG_LIMIT_PER_TENANT, TAG_NAME_MAX, classifyProtected as classifyParityProtected, normalizeTagName as normalizeParityTagName } from '../parity/tags/index.js';
import { suggestStage } from './csv.js';
import type { ContactStage, NormalizedContact } from './types.js';

export const PARITY_STAGES: readonly ContactStage[] = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'];
export const FIELD_TYPES = PARITY_FIELD_TYPES;
export type FieldType = ParityFieldType;

export const TAG_CATALOG_LIMIT = TAG_LIMIT_PER_TENANT;
export const CUSTOM_FIELD_LIMIT = PARITY_FIELD_LIMIT;
export const CONTACT_TAG_LIMIT = TAG_LIMIT_PER_CONTACT;
export const MAX_TAG_NAME = TAG_NAME_MAX;

export type FieldOption = ParityFieldOption;

/** What to do with one source custom field (keyed by its source key, e.g. `customLeadScore`). */
export type FieldAction =
  | { action: 'skip' }
  | { action: 'create'; type: FieldType; label: string }
  | { action: 'existing'; fieldId: string };

/** import_batches.options.parity (no PII: stage labels, field keys, choices). */
export interface ParityOptions {
  /** source stage label → one of the eight stage keys; changing it resets the contacts dry run */
  stageMap: Record<string, ContactStage>;
  /** Q-PAR-1 default: keep each source stage as the tag "FUB stage: <label>" */
  keepStageAsTag: boolean;
  fields: Record<string, FieldAction>;
}

export const DEFAULT_PARITY_OPTIONS: ParityOptions = { stageMap: {}, keepStageAsTag: true, fields: {} };

/** A field definition as the commit resolves it (existing, or created by this import). */
export interface ResolvedField {
  sourceKey: string;
  fieldId: string;
  key: string;
  type: FieldType;
  options: readonly FieldOption[];
}

// ---- names -------------------------------------------------------------------------------------------

/** C0 and C1 control characters out (tabs and newlines become spaces first). */
export function stripControls(s: string): string {
  return [...s.replace(/[\t\n\r]/g, ' ')].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return !(c < 0x20 || (c >= 0x7f && c <= 0x9f));
  }).join('');
}

/**
 * A source tag as a catalog name (R-PAR-6). The source text is cleaned up first (control characters out,
 * whitespace collapsed, cut to the 64-character tag length, so a long FUB tag is shortened rather than
 * lost); module 59's normalizeTagName then decides the stored name and its key (the key `tags.name_key`
 * computes). Null when nothing is left.
 */
export function normalizeTagName(raw: string): { name: string; key: string } | null {
  const cleaned = stripControls(raw.normalize('NFC')).replace(/\s+/g, ' ').trim();
  const n = normalizeParityTagName([...cleaned].slice(0, MAX_TAG_NAME).join(''));
  return n.ok ? { name: n.name, key: n.key } : null;
}

/** E191: the tag that keeps a source stage ("FUB stage: Hot Prospect"), cut to the tag length. */
export function stageTagName(label: string, source: 'fub' | 'csv' = 'fub'): string {
  const n = normalizeTagName(`${source === 'fub' ? 'FUB' : 'Imported'} stage: ${label}`);
  return n ? n.name : `${source === 'fub' ? 'FUB' : 'Imported'} stage`;
}

/**
 * R-PAR-8, R-PAR-18: a tag name, field label or choice that reads like a fair-housing protected attribute.
 * This is module 59's classifier, exactly as the tag writer applies it when it creates a tag, so the dry
 * run's "created protected" count is what the catalog gets. **VERIFY WITH COUNSEL (C-PAR-3).**
 */
export function classifyProtected(name: string): boolean {
  return classifyParityProtected(name);
}

/** A source field KEY ("customMilitaryStatus") is classified as typed and as the words of its label ("Military Status"). */
export function fieldKeyProtected(sourceKey: string): boolean {
  return classifyProtected(sourceKey) || classifyProtected(fieldLabelFromKey(sourceKey));
}

const BUILTIN_PROTECTED_KEYS: ReadonlySet<string> = new Set(BUILT_IN_PROTECTED_KEYS);

/** "customLeadScore" / "Lead score" → "Lead Score" (a readable label, ≤ 60). */
export function fieldLabelFromKey(sourceKey: string): string {
  const s = sourceKey
    .replace(/^custom(?=[A-Z0-9_])/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const label = s === '' ? sourceKey : s.charAt(0).toUpperCase() + s.slice(1);
  return label.slice(0, 60);
}

/** A definition key (`^[a-z][a-z0-9_]{1,40}$`) for a source field: `fub_lead_score`. Null when none fits. */
export function fieldKeyFrom(sourceKey: string, prefix: 'fub' | 'csv' = 'fub'): string | null {
  const body = fieldLabelFromKey(sourceKey)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = `${prefix}_${body}`.slice(0, 41).replace(/_+$/, '');
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key) || BUILTIN_PROTECTED_KEYS.has(key)) return null;
  return key;
}

// ---- values ------------------------------------------------------------------------------------------

function optionId(label: string): string {
  const id = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  return id === '' ? 'opt' : id;
}

/** Distinct option labels (in first-seen order) → options with unique ids; at most 100. */
export function optionsFromValues(values: readonly string[], multi: boolean): FieldOption[] {
  const out: FieldOption[] = [];
  const seenLabel = new Set<string>();
  const seenId = new Set<string>();
  for (const v of values) {
    for (const part of multi ? v.split(/[,;|]/) : [v]) {
      const label = part.trim().slice(0, 60);
      if (label === '' || seenLabel.has(label.toLowerCase())) continue;
      if (out.length >= 100) return out;
      seenLabel.add(label.toLowerCase());
      let id = optionId(label);
      for (let i = 2; seenId.has(id); i++) id = `${optionId(label).slice(0, 33)}_${i}`;
      seenId.add(id);
      out.push({ id, label });
    }
  }
  return out;
}

export type TypedValue = { text: string } | { number: number } | { date: string } | { options: string[] };

/** A source date ("2026-12-15", "2026-12-15T10:00:00Z", "12/31/2026") as `YYYY-MM-DD`; the calendar is checked by module 59. */
function sourceDate(t: string): string | null {
  let y: string;
  let m: string;
  let d: string;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (r) [y, m, d] = [r[1]!, r[2]!, r[3]!];
  else {
    r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (!r) return null;
    [m, d, y] = [r[1]!, r[2]!, r[3]!];
  }
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** The live option whose label is `label` (case and spacing aside): source values carry labels, a value holds the option id. */
function optionIdOf(options: readonly FieldOption[], label: string): string | null {
  const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const l = fold(label);
  return options.find((o) => o.archived !== true && fold(o.label) === l)?.id ?? null;
}

/**
 * The source's text as the input module 59's validateFieldValue reads for this type, or null when the text
 * cannot be one: "$1,250.50" → "1,250.50" (validateFieldValue drops the separators), M/D/YYYY → YYYY-MM-DD,
 * option labels → option ids ("a, b; c" for several), deduped. An empty text is never a value (it would
 * clear one).
 */
function fieldInput(type: FieldType, options: readonly FieldOption[], raw: string): string | string[] | null {
  const v = raw.trim();
  if (v === '') return null;
  switch (type) {
    case 'text':
      return v;
    case 'number':
      return v.replace(/[$\s]/g, '');
    case 'date':
      return sourceDate(v);
    case 'single_select':
      return optionIdOf(options, v);
    case 'multi_select': {
      const ids: string[] = [];
      for (const p of v.split(/[,;|]/).map((x) => x.trim()).filter((x) => x !== '')) {
        const id = optionIdOf(options, p);
        if (id === null) return null;
        if (!ids.includes(id)) ids.push(id);
      }
      return ids.length === 0 ? null : ids;
    }
  }
}

function importValue(v: ParityTypedValue): TypedValue {
  switch (v.type) {
    case 'text':
      return { text: v.text };
    case 'number':
      return { number: v.number };
    case 'date':
      return { date: v.date };
    case 'options':
      return { options: [...v.optionIds] };
  }
}

/**
 * A raw source value as the field's type, decided by module 59's validateFieldValue, or CUSTOM_VALUE_INVALID
 * (the raw text then stays in imported_fields only). Select values match a live option's label, case-insensitively.
 */
export function typedFieldValue(type: FieldType, options: readonly FieldOption[], raw: string): { ok: true; value: TypedValue } | { ok: false; code: 'CUSTOM_VALUE_INVALID' } {
  const input = fieldInput(type, options, raw);
  if (input === null) return { ok: false, code: 'CUSTOM_VALUE_INVALID' };
  const def: FieldDef = { id: '', key: '', label: '', fieldType: type, options, annual: false, archived: false };
  const r = validateFieldValue(def, input);
  if (!r.ok || r.value === null) return { ok: false, code: 'CUSTOM_VALUE_INVALID' };
  return { ok: true, value: importValue(r.value) };
}

/** A typed value as the input module 60's setFieldValue takes (it validates it again, against the stored definition). */
export function fieldValueInput(v: TypedValue): string | number | string[] {
  return 'text' in v ? v.text : 'number' in v ? v.number : 'date' in v ? v.date : v.options;
}

/** A suggested type from the values seen (the Admin decides; the suggestion never imports anything). */
export function suggestFieldType(values: readonly string[]): FieldType {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '');
  if (vs.length === 0) return 'text';
  if (vs.every((v) => typedFieldValue('number', [], v).ok)) return 'number';
  if (vs.every((v) => typedFieldValue('date', [], v).ok)) return 'date';
  const distinct = new Set(vs.map((v) => v.toLowerCase()));
  if (distinct.size <= 10 && vs.length >= distinct.size * 2) return vs.some((v) => /[,;|]/.test(v)) ? 'multi_select' : 'single_select';
  return 'text';
}

// ---- the parity summary of a stage (dry run) ------------------------------------------------------------

export interface StageRow {
  label: string;
  people: number;
  suggested: ContactStage | null;
  mapped: ContactStage | null;
}

export interface FieldRow {
  sourceKey: string;
  label: string;
  people: number;
  suggestedType: FieldType;
  /** the field reads like a protected fair-housing attribute: never created as a custom field (R-PAR-18) */
  protected: boolean;
  action: FieldAction;
  /** values that fit the chosen type / do not (kept as text in imported_fields) */
  fit: number;
  misfit: number;
  /** the option labels a new select field would get */
  options: FieldOption[];
}

export interface TagSummary {
  /** distinct tags in the source (by name key), stage tags included */
  distinct: number;
  /** already in the catalog */
  existing: number;
  /** new catalog entries the import will create */
  toCreate: number;
  /** tags that do not fit the 1,000-tag catalog (TAG_LIMIT): kept as text in imported_fields */
  overLimit: number;
  /** person-tag pairs in the source (stage tags included) */
  sourceLinks: number;
  /** links to people the import will write (pairs whose tag fits the catalog) */
  links: number;
  /** new tags that read like a protected attribute: created protected (R-PAR-8) */
  protectedNew: number;
  /** how many of the people carry a tag that reads as an opt-out (honoured as a real opt-out by the consent rules) */
  optOutTagged: number;
  overLimitNames: string[];
}

export interface ParitySummary {
  stages: StageRow[];
  tags: TagSummary;
  fields: FieldRow[];
  blockers: ParityBlocker[];
}

export type ParityBlocker = 'STAGE_MAP_INCOMPLETE' | 'TAG_LIMIT' | 'CUSTOM_FIELD_LIMIT';

const OPT_OUT_TAG = /^(dnc|do[\s_-]*not[\s_-]*(contact|call)|opted[\s_-]*out|opt[\s_-]*out|stop|unsubscribed)$/i;

/** The stage a contact gets: the Admin's mapping, else the plain suggestion; null when nobody mapped the label. */
export function mappedStage(label: string | null | undefined, o: ParityOptions): ContactStage | null {
  if (label === null || label === undefined) return 'new';
  // own keys only: a source label such as "constructor" or "valueOf" is a label, not Object.prototype's member
  return Object.hasOwn(o.stageMap, label) ? (o.stageMap[label] ?? null) : suggestStage(label);
}

/** The tag names a contact gets (the source's tags + the kept stage), deduped by name key, in order. */
export function contactTagNames(c: NormalizedContact, o: ParityOptions, source: 'fub' | 'csv'): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeTagName(raw);
    if (!n || seen.has(n.key) || out.length >= CONTACT_TAG_LIMIT) return;
    seen.add(n.key);
    out.push(n);
  };
  for (const t of c.tags) add(t);
  if (o.keepStageAsTag && c.stageLabel) add(stageTagName(c.stageLabel, source));
  return out;
}

/**
 * The dry run's parity summary over the contacts stage's records. `catalogKeys` are the name keys
 * already in the tenant's catalog; `liveFields` how many custom fields are live now.
 */
export function paritySummary(contacts: readonly NormalizedContact[], o: ParityOptions, ctx: { catalogKeys: ReadonlySet<string>; liveFields: number; existingFields: ReadonlyMap<string, { type: FieldType; options: readonly FieldOption[] }>; source: 'fub' | 'csv' }): ParitySummary {
  // stages
  const stageCount = new Map<string, number>();
  for (const c of contacts) if (c.stageLabel) stageCount.set(c.stageLabel, (stageCount.get(c.stageLabel) ?? 0) + 1);
  const stages: StageRow[] = [...stageCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, people]) => ({ label, people, suggested: suggestStage(label), mapped: mappedStage(label, o) }));

  // tags (first spelling wins; catalog order: existing first, then new ones by first appearance)
  const firstName = new Map<string, string>();
  let links = 0;
  let optOutTagged = 0;
  for (const c of contacts) {
    const names = contactTagNames(c, o, ctx.source);
    links += names.length;
    if (c.tags.some((t) => OPT_OUT_TAG.test(t.trim()))) optOutTagged += 1;
    for (const n of names) if (!firstName.has(n.key)) firstName.set(n.key, n.name);
  }
  const keys = [...firstName.keys()];
  const existing = keys.filter((k) => ctx.catalogKeys.has(k));
  const fresh = keys.filter((k) => !ctx.catalogKeys.has(k));
  const room = Math.max(0, TAG_CATALOG_LIMIT - ctx.catalogKeys.size);
  const created = fresh.slice(0, room);
  const over = fresh.slice(room);
  const overSet = new Set(over);
  const sourceLinks = links;
  if (overSet.size > 0) {
    links = 0;
    for (const c of contacts) links += contactTagNames(c, o, ctx.source).filter((n) => !overSet.has(n.key)).length;
  }
  const tags: TagSummary = {
    distinct: keys.length,
    existing: existing.length,
    toCreate: created.length,
    overLimit: over.length,
    sourceLinks,
    links,
    protectedNew: created.filter((k) => classifyProtected(firstName.get(k) as string)).length,
    optOutTagged,
    overLimitNames: over.slice(0, 50).map((k) => firstName.get(k) as string),
  };

  // custom fields
  const byKey = new Map<string, string[]>();
  for (const c of contacts) for (const [k, v] of Object.entries(c.customFields ?? {})) (byKey.get(k) ?? byKey.set(k, []).get(k))!.push(v);
  const fields: FieldRow[] = [...byKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sourceKey, values]) => {
      const label = fieldLabelFromKey(sourceKey);
      const suggestedType = suggestFieldType(values);
      // R-PAR-18: the key (as its label's words), or (for a choice-like field) one of its options, reads like a protected attribute
      const choiceLike = suggestedType === 'single_select' || suggestedType === 'multi_select';
      const prot = fieldKeyProtected(sourceKey) || (choiceLike && optionsFromValues(values, suggestedType === 'multi_select').some((x) => classifyProtected(x.label)));
      const chosen = o.fields[sourceKey];
      const action: FieldAction = prot ? { action: 'skip' } : (chosen ?? { action: 'skip' });
      const multi = action.action === 'create' ? action.type === 'multi_select' : suggestedType === 'multi_select';
      const options = optionsFromValues(values, multi);
      let fit = 0;
      let misfit = 0;
      if (action.action !== 'skip') {
        const def = action.action === 'create' ? { type: action.type, options: action.type.endsWith('select') ? options : [] } : ctx.existingFields.get(action.fieldId);
        for (const v of values) {
          if (def && typedFieldValue(def.type, def.options, v).ok) fit += 1;
          else misfit += 1;
        }
      }
      return { sourceKey, label, people: values.length, suggestedType, protected: prot, action, fit, misfit, options };
    });

  const blockers: ParityBlocker[] = [];
  if (stages.some((s) => s.mapped === null)) blockers.push('STAGE_MAP_INCOMPLETE');
  if (over.length > 0) blockers.push('TAG_LIMIT');
  if (ctx.liveFields + fields.filter((f) => f.action.action === 'create').length > CUSTOM_FIELD_LIMIT) blockers.push('CUSTOM_FIELD_LIMIT');
  return { stages, tags, fields, blockers };
}

/**
 * R-PAR-46: the per-category parity report rows. Units: stages and custom fields count people's values,
 * tags count person-tag links. Every row reconciles: source = imported + needs_review + rejected + duplicate.
 */
export interface ParityReportRow {
  category: 'stages' | 'tags' | 'custom_fields';
  source: number;
  imported: number;
  needs_review: number;
  rejected: number;
  /** already here: the person kept their own stage, tag or value (E41 fill-empty) */
  duplicate: number;
}

export function parityReport(s: ParitySummary): ParityReportRow[] {
  const stagePeople = s.stages.reduce((n, r) => n + r.people, 0);
  const unmapped = s.stages.filter((r) => r.mapped === null).reduce((n, r) => n + r.people, 0);
  const values = s.fields.reduce((n, f) => n + f.people, 0);
  const fit = s.fields.reduce((n, f) => n + f.fit, 0);
  return [
    { category: 'stages', source: stagePeople, imported: stagePeople - unmapped, needs_review: unmapped, rejected: 0, duplicate: 0 },
    { category: 'tags', source: s.tags.sourceLinks, imported: s.tags.links, needs_review: 0, rejected: s.tags.sourceLinks - s.tags.links, duplicate: 0 },
    { category: 'custom_fields', source: values, imported: fit, needs_review: 0, rejected: values - fit, duplicate: 0 },
  ];
}

/** What the contacts commit wrote (import_batches.options.parityCommitted) as report rows. */
export function parityCommittedReport(c: Readonly<Record<string, number>>): ParityReportRow[] {
  const v = (k: string) => c[k] ?? 0;
  return [
    { category: 'stages', source: v('stagesSet') + v('stagesKept'), imported: v('stagesSet'), needs_review: 0, rejected: 0, duplicate: v('stagesKept') },
    { category: 'tags', source: v('tagLinks') + v('tagLinksExisting') + v('tagsSkipped'), imported: v('tagLinks'), needs_review: 0, rejected: v('tagsSkipped'), duplicate: v('tagLinksExisting') },
    { category: 'custom_fields', source: v('values') + v('valuesKept') + v('valuesMisfit'), imported: v('values'), needs_review: 0, rejected: v('valuesMisfit'), duplicate: v('valuesKept') },
  ];
}

/** Plain sentences for the dry run's parity section. Every number is one of the summary's counts. */
export function parityLines(s: ParitySummary, sourceName: 'Follow Up Boss' | 'your file'): string[] {
  const lines: string[] = [];
  const unmapped = s.stages.filter((r) => r.mapped === null);
  lines.push(
    s.stages.length === 0
      ? `No stages in ${sourceName}: everyone starts as New.`
      : `${s.stages.length} ${s.stages.length === 1 ? 'stage' : 'stages'} in ${sourceName}. ${unmapped.length === 0 ? 'Every stage is mapped.' : `${unmapped.length} still ${unmapped.length === 1 ? 'needs' : 'need'} a stage before you can approve.`}`,
  );
  if (s.tags.distinct === 0) lines.push(`No tags in ${sourceName}.`);
  else lines.push(`${s.tags.distinct} ${s.tags.distinct === 1 ? 'tag' : 'tags'}: ${s.tags.existing} already here, ${s.tags.toCreate} new${s.tags.overLimit > 0 ? `, ${s.tags.overLimit} over the 1,000-tag limit (kept as text on each person; merge or skip some first)` : ''}.`);
  if (s.tags.protectedNew > 0) lines.push(`${s.tags.protectedNew} new ${s.tags.protectedNew === 1 ? 'tag reads' : 'tags read'} like a protected attribute: ${s.tags.protectedNew === 1 ? 'it is' : 'they are'} created protected (never used for bulk audiences).`);
  if (s.tags.optOutTagged > 0) lines.push(`${s.tags.optOutTagged} ${s.tags.optOutTagged === 1 ? 'person has' : 'people have'} a tag like "DNC" or "Opted out". That is recorded as a real opt-out, not just a tag.`);
  const kept = s.fields.filter((f) => f.action.action !== 'skip');
  const skipped = s.fields.length - kept.length;
  if (s.fields.length > 0) lines.push(`${s.fields.length} custom ${s.fields.length === 1 ? 'field' : 'fields'}: ${kept.length} mapped, ${skipped} kept as text only.`);
  const prot = s.fields.filter((f) => f.protected).length;
  if (prot > 0) lines.push(`${prot} ${prot === 1 ? 'field reads' : 'fields read'} like a protected attribute (for example military status or familial status): kept as text only, never a custom field.`);
  const misfit = s.fields.reduce((n, f) => n + f.misfit, 0);
  if (misfit > 0) lines.push(`${misfit} ${misfit === 1 ? 'value does' : 'values do'} not fit the chosen type: kept as text on the person.`);
  return lines;
}
