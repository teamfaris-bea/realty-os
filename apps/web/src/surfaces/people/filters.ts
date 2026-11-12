// The People filter builder's model (lane people-filters): the fields and operators an agent picks, each mapped
// to one SmartListDefinition v1 clause (core module 59; the server validates every definition again), the
// plain-words label of a clause for its chip, and the URL form of an unsaved filter. Pure: no React, no fetch.
//
// Semantics the labels promise (DATA_MODEL Part 3 E195-E197): "is not" keeps people with no value, so
// "Source is not Zillow" includes people with no source and "Owner is not Avery" includes people with no owner. A
// person has no owner when the engine says so: unassigned, in a pond, on offer to an agent, or closed (batch 6 review
// F6), so "Owner is nobody" names all four.
import type { Clause, Definition, FieldDefView, TagView } from './api.js';

export const STAGE_KEYS = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export const INTENTS: { key: string; label: string }[] = [
  { key: 'buyer', label: 'Buyer' },
  { key: 'seller', label: 'Seller' },
  { key: 'buyer_seller', label: 'Buyer and seller' },
  { key: 'renter', label: 'Renter' },
  { key: 'landlord', label: 'Landlord' },
  { key: 'investor', label: 'Investor' },
];
export const CONTACT_TYPES: { key: string; label: string }[] = [
  { key: 'lead', label: 'Lead' },
  { key: 'sphere', label: 'Sphere' },
  { key: 'past_client', label: 'Past client' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'other', label: 'Other' },
];
/** The definition limits of core (MAX_AND_CLAUSES, MAX_OR_CLAUSES, MAX_DAYS). */
export const MAX_ALL = 20;
export const MAX_ANY = 10;
export const MAX_DAYS = 3650;

export interface Catalogs {
  stageLabel: (key: string) => string;
  sources: { id: string; name: string; active: boolean }[];
  members: { userId: string; name: string; active: boolean }[];
  tags: Pick<TagView, 'id' | 'name' | 'protected'>[];
  fields: FieldDefView[];
  meId: string | null;
}

/** A field of the builder's first step. `field:<id>` is a custom field. */
export type FilterField = 'stage' | 'source' | 'tag' | 'owner' | 'intent' | 'contact_type' | 'last_activity' | 'created' | 'next_task' | 'name' | `field:${string}`;

/** The kinds of value an operator asks for. */
export type ValueKind = 'none' | 'choices' | 'days' | 'days0' | 'number' | 'date' | 'text';

export interface OperatorSpec {
  /** stable id within the field */
  op: string;
  label: string;
  value: ValueKind;
  /** typed text: the clause can never be on a team list (R-PAR-27) */
  freeText?: boolean;
}

export interface FieldSpec {
  field: FilterField;
  label: string;
  operators: OperatorSpec[];
}

const IS_ISNOT: OperatorSpec[] = [
  { op: 'in', label: 'is', value: 'choices' },
  { op: 'not_in', label: 'is not', value: 'choices' },
];

/** Every field the builder offers, in the order of the field list (custom fields last, by position). */
export function fieldSpecs(fields: readonly FieldDefView[]): FieldSpec[] {
  const base: FieldSpec[] = [
    { field: 'stage', label: 'Stage', operators: IS_ISNOT },
    { field: 'source', label: 'Source', operators: IS_ISNOT },
    {
      field: 'tag',
      label: 'Tags',
      operators: [
        { op: 'any', label: 'has any of', value: 'choices' },
        { op: 'all', label: 'has all of', value: 'choices' },
        { op: 'none', label: 'has none of', value: 'choices' },
      ],
    },
    {
      field: 'owner',
      label: 'Owner',
      operators: [
        { op: 'me', label: 'is me', value: 'none' },
        { op: 'none', label: 'is nobody (unassigned, in a pond, on offer or closed)', value: 'none' },
        { op: 'in', label: 'is', value: 'choices' },
        { op: 'not_in', label: 'is not', value: 'choices' },
      ],
    },
    { field: 'intent', label: 'Intent', operators: IS_ISNOT },
    { field: 'contact_type', label: 'Contact type', operators: IS_ISNOT },
    {
      field: 'last_activity',
      label: 'Last activity',
      operators: [
        { op: 'within_days', label: 'within the last', value: 'days' },
        { op: 'older_than_days', label: 'more than … ago', value: 'days' },
        { op: 'never', label: 'never', value: 'none' },
      ],
    },
    {
      field: 'created',
      label: 'Created',
      operators: [
        { op: 'within_days', label: 'within the last', value: 'days' },
        { op: 'older_than_days', label: 'more than … ago', value: 'days' },
      ],
    },
    {
      field: 'next_task',
      label: 'Next task',
      operators: [
        { op: 'overdue', label: 'is overdue', value: 'none' },
        { op: 'due_within_days', label: 'is due within', value: 'days' },
        { op: 'any', label: 'is any open task', value: 'none' },
        { op: 'none', label: 'none', value: 'none' },
      ],
    },
    { field: 'name', label: 'Name', operators: [{ op: 'contains', label: 'contains', value: 'text', freeText: true }] },
  ];
  const custom = [...fields]
    .filter((f) => !f.archived)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map((f): FieldSpec => ({ field: `field:${f.id}`, label: f.label, operators: fieldOperators(f) }));
  return [...base, ...custom];
}

const SET_EMPTY: OperatorSpec[] = [
  { op: 'set', label: 'has a value', value: 'none' },
  { op: 'empty', label: 'is empty', value: 'none' },
];

export function fieldOperators(f: Pick<FieldDefView, 'fieldType' | 'annual'>): OperatorSpec[] {
  switch (f.fieldType) {
    case 'text':
      return [{ op: 'text_contains', label: 'contains', value: 'text', freeText: true }, { op: 'text_eq', label: 'is exactly', value: 'text', freeText: true }, ...SET_EMPTY];
    case 'number':
      return [
        { op: 'num_gte', label: 'is at least', value: 'number' },
        { op: 'num_lte', label: 'is at most', value: 'number' },
        { op: 'num_gt', label: 'is more than', value: 'number' },
        { op: 'num_lt', label: 'is less than', value: 'number' },
        { op: 'num_eq', label: 'is', value: 'number' },
        ...SET_EMPTY,
      ];
    case 'date':
      return [
        ...(f.annual ? [{ op: 'coming_up', label: 'is coming up within', value: 'days0' as const }] : []),
        { op: 'date_within_last_days', label: 'was within the last', value: 'days' },
        { op: 'date_within_next_days', label: 'is within the next', value: 'days' },
        { op: 'date_before', label: 'is before', value: 'date' },
        { op: 'date_after', label: 'is after', value: 'date' },
        { op: 'date_on', label: 'is on', value: 'date' },
        ...SET_EMPTY,
      ];
    case 'single_select':
      return [{ op: 'opt_any', label: 'is any of', value: 'choices' }, { op: 'opt_none', label: 'is none of', value: 'choices' }, ...SET_EMPTY];
    case 'multi_select':
      return [
        { op: 'opt_any', label: 'has any of', value: 'choices' },
        { op: 'opt_all', label: 'has all of', value: 'choices' },
        { op: 'opt_none', label: 'has none of', value: 'choices' },
        ...SET_EMPTY,
      ];
  }
}

/** The value an operator holds while it is being edited. */
export interface DraftValue {
  choices: string[];
  days: string;
  number: string;
  date: string;
  text: string;
}
export const EMPTY_VALUE: DraftValue = { choices: [], days: '', number: '', date: '', text: '' };

/** The choices of a field ("choices" operators): id + label. */
export function choicesOf(field: FilterField, c: Catalogs): { id: string; label: string; muted?: boolean }[] {
  switch (field) {
    case 'stage':
      return STAGE_KEYS.map((k) => ({ id: k, label: c.stageLabel(k) }));
    case 'source':
      return c.sources.map((s) => ({ id: s.id, label: s.name, ...(s.active ? {} : { muted: true }) }));
    case 'owner':
      return c.members.map((m) => ({ id: m.userId, label: m.userId === c.meId ? `${m.name} (me)` : m.name, ...(m.active ? {} : { muted: true }) }));
    case 'intent':
      return INTENTS.map((i) => ({ id: i.key, label: i.label }));
    case 'contact_type':
      return CONTACT_TYPES.map((t) => ({ id: t.key, label: t.label }));
    case 'tag':
      return c.tags.map((t) => ({ id: t.id, label: t.name }));
    default: {
      const f = customField(field, c);
      return f ? f.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label })) : [];
    }
  }
}

function customField(field: FilterField, c: Pick<Catalogs, 'fields'>): FieldDefView | undefined {
  return field.startsWith('field:') ? c.fields.find((f) => f.id === field.slice(6)) : undefined;
}

const intOf = (s: string, min: number): number | null => {
  const t = s.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= MAX_DAYS ? n : null;
};

/** The clause for a field + operator + value, or a plain sentence saying what is missing. */
export function buildClause(field: FilterField, op: string, v: DraftValue): { ok: true; clause: Clause } | { ok: false; message: string } {
  const need = (m: string) => ({ ok: false as const, message: m });
  const days = (min = 1) => intOf(v.days, min);
  switch (field) {
    case 'stage':
    case 'source':
    case 'intent':
    case 'contact_type':
      if (v.choices.length === 0) return need('Pick at least one.');
      if (v.choices.length > 50) return need('Pick at most 50.');
      return { ok: true, clause: { kind: field, [op === 'not_in' ? 'not_in' : 'in']: v.choices } };
    case 'tag':
      if (v.choices.length === 0) return need('Pick at least one tag.');
      if (v.choices.length > 20) return need('Pick at most 20 tags.');
      return { ok: true, clause: { kind: 'tag', op, tagIds: v.choices } };
    case 'owner':
      if (op === 'me' || op === 'none') return { ok: true, clause: { kind: 'owner', is: op } };
      if (v.choices.length === 0) return need('Pick at least one person.');
      if (v.choices.length > 50) return need('Pick at most 50 people.');
      return { ok: true, clause: { kind: 'owner', [op === 'not_in' ? 'not_in' : 'in']: v.choices } };
    case 'last_activity':
      if (op === 'never') return { ok: true, clause: { kind: 'last_activity', op: 'never' } };
      return days() === null ? need(`Type a number of days from 1 to ${MAX_DAYS}.`) : { ok: true, clause: { kind: 'last_activity', op, days: days() } };
    case 'created':
      return days() === null ? need(`Type a number of days from 1 to ${MAX_DAYS}.`) : { ok: true, clause: { kind: 'created', op, days: days() } };
    case 'next_task':
      if (op === 'due_within_days') return days() === null ? need(`Type a number of days from 1 to ${MAX_DAYS}.`) : { ok: true, clause: { kind: 'next_task', op, days: days() } };
      return { ok: true, clause: { kind: 'next_task', op } };
    case 'name': {
      const t = v.text.trim();
      return t === '' ? need('Type part of a name.') : t.length > 60 ? need('At most 60 characters.') : { ok: true, clause: { kind: 'name', contains: t } };
    }
    default: {
      const fieldId = field.slice(6);
      if (op === 'set' || op === 'empty') return { ok: true, clause: { kind: 'field', fieldId, op } };
      if (op === 'text_eq' || op === 'text_contains') {
        const t = v.text.trim();
        return t === '' ? need('Type a value.') : t.length > 60 ? need('At most 60 characters.') : { ok: true, clause: { kind: 'field', fieldId, op, value: t } };
      }
      if (op.startsWith('num_')) {
        const n = Number(v.number.trim().replace(/,/g, ''));
        return v.number.trim() === '' || !Number.isFinite(n) || Math.abs(n) >= 1e15 ? need('Type a number.') : { ok: true, clause: { kind: 'field', fieldId, op, value: n } };
      }
      if (op === 'date_before' || op === 'date_after' || op === 'date_on') return /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? { ok: true, clause: { kind: 'field', fieldId, op, value: v.date } } : need('Pick a date.');
      if (op === 'coming_up') {
        const d = intOf(v.days, 0);
        return d === null || d > 366 ? need('Type a number of days from 0 to 366.') : { ok: true, clause: { kind: 'field', fieldId, op, days: d } };
      }
      if (op === 'date_within_last_days' || op === 'date_within_next_days') return days() === null ? need(`Type a number of days from 1 to ${MAX_DAYS}.`) : { ok: true, clause: { kind: 'field', fieldId, op, days: days() } };
      if (v.choices.length === 0) return need('Pick at least one choice.');
      if (v.choices.length > 50) return need('Pick at most 50 choices.');
      return { ok: true, clause: { kind: 'field', fieldId, op, optionIds: v.choices } };
    }
  }
}

/** The builder's field, operator and value for an existing clause (to edit it). Null: not a builder clause. */
export function clauseToDraft(c: Clause): { field: FilterField; op: string; value: DraftValue } | null {
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const val = { ...EMPTY_VALUE };
  switch (c.kind) {
    case 'stage':
    case 'source':
    case 'intent':
    case 'contact_type':
      return 'not_in' in c ? { field: c.kind, op: 'not_in', value: { ...val, choices: arr(c.not_in) } } : { field: c.kind, op: 'in', value: { ...val, choices: arr(c.in) } };
    case 'tag':
      return { field: 'tag', op: String(c.op), value: { ...val, choices: arr(c.tagIds) } };
    case 'owner':
      if ('is' in c) return { field: 'owner', op: String(c.is), value: val };
      return 'not_in' in c ? { field: 'owner', op: 'not_in', value: { ...val, choices: arr(c.not_in) } } : { field: 'owner', op: 'in', value: { ...val, choices: arr(c.in) } };
    case 'last_activity':
    case 'created':
    case 'next_task':
      return { field: c.kind, op: String(c.op), value: { ...val, days: c.days === undefined ? '' : String(c.days) } };
    case 'name':
      return { field: 'name', op: 'contains', value: { ...val, text: String(c.contains ?? '') } };
    case 'field':
      return {
        field: `field:${String(c.fieldId)}`,
        op: String(c.op),
        value: {
          ...val,
          choices: arr(c.optionIds),
          days: c.days === undefined ? '' : String(c.days),
          number: typeof c.value === 'number' ? String(c.value) : '',
          date: typeof c.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? c.value : '',
          text: typeof c.value === 'string' ? c.value : '',
        },
      };
    default:
      return null;
  }
}

const listOf = (xs: string[]): string => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);
const daysText = (n: unknown) => `${String(n)} ${n === 1 ? 'day' : 'days'}`;

/** The chip text of a clause: "Stage is not Closed, Lost", "Source is Zillow", "Tags has none of DNC". */
export function clauseLabel(c: Clause, cat: Catalogs): string {
  const names = (field: FilterField, ids: unknown): string[] => {
    const all = choicesOf(field, cat);
    return (Array.isArray(ids) ? ids : []).map((id) => all.find((x) => x.id === id)?.label ?? (field === 'tag' ? 'a deleted tag' : field === 'owner' ? 'a former member' : field === 'source' ? 'a removed source' : String(id)));
  };
  switch (c.kind) {
    case 'stage':
    case 'source':
    case 'intent':
    case 'contact_type': {
      const label = { stage: 'Stage', source: 'Source', intent: 'Intent', contact_type: 'Contact type' }[c.kind];
      return 'not_in' in c ? `${label} is not ${listOf(names(c.kind, c.not_in))}` : `${label} is ${listOf(names(c.kind, c.in))}`;
    }
    case 'tag':
      return `Tags ${c.op === 'all' ? 'has all of' : c.op === 'none' ? 'has none of' : 'has any of'} ${listOf(names('tag', c.tagIds))}`;
    case 'owner':
      if ('is' in c) return c.is === 'me' ? 'Owner is me' : 'Owner: nobody (unassigned, in a pond, on offer or closed)';
      return 'not_in' in c ? `Owner is not ${listOf(names('owner', c.not_in))}` : `Owner is ${listOf(names('owner', c.in))}`;
    case 'last_activity':
      return c.op === 'never' ? 'No activity yet' : c.op === 'within_days' ? `Last activity within ${daysText(c.days)}` : `Last activity more than ${daysText(c.days)} ago`;
    case 'created':
      return c.op === 'within_days' ? `Created within ${daysText(c.days)}` : `Created more than ${daysText(c.days)} ago`;
    case 'next_task':
      return c.op === 'overdue' ? 'Next task is overdue' : c.op === 'none' ? 'No open task' : c.op === 'any' ? 'Has an open task' : `Next task due within ${daysText(c.days)}`;
    case 'name':
      return `Name contains “${String(c.contains)}”`;
    case 'field': {
      const f = cat.fields.find((x) => x.id === c.fieldId);
      const label = f?.label ?? 'A removed field';
      const op = f ? fieldOperators(f).find((o) => o.op === c.op)?.label : undefined;
      const opText = op ?? String(c.op);
      if (c.op === 'set' || c.op === 'empty') return `${label} ${opText}`;
      if (Array.isArray(c.optionIds)) return `${label} ${opText} ${listOf(names(`field:${String(c.fieldId)}`, c.optionIds))}`;
      if (c.days !== undefined) return `${label} ${opText} ${daysText(c.days)}`;
      if (typeof c.value === 'string' && f?.fieldType === 'text') return `${label} ${opText} “${c.value}”`;
      return `${label} ${opText} ${String(c.value)}`;
    }
    default:
      return 'A filter';
  }
}

/** True when a clause carries typed text (core isFreeTextClause): never allowed on a team list (R-PAR-27). */
export function isFreeTextClause(c: Clause): boolean {
  return c.kind === 'name' || (c.kind === 'field' && (c.op === 'text_eq' || c.op === 'text_contains'));
}

export function hasFreeText(d: Definition): boolean {
  return [...(d.all ?? []), ...(d.any ?? [])].some(isFreeTextClause);
}

/** The team-list refusal, in the words the owner asked for (R-PAR-27). */
export const TEAM_TEXT_REFUSAL = "Team lists can't include typed text. Remove the name search or save it as your own list.";

/**
 * The definition the builder's groups make. An OR group needs two or more filters (core), so a single "any of"
 * filter joins the "all of" filters: with one alternative "any of" means the same thing.
 */
export function definitionOf(all: readonly Clause[], any: readonly Clause[]): Definition {
  if (any.length >= 2) return { v: 1, all: [...all], any: [...any] };
  return { v: 1, all: [...all, ...any] };
}

export function isEmptyDefinition(d: Definition): boolean {
  return (d.all ?? []).length === 0 && (d.any ?? []).length === 0;
}

/** The page's name search added to a definition (personal or unsaved runs only). */
export function withNameSearch(d: Definition, q: string): Definition {
  const t = q.trim().slice(0, 60);
  if (t === '') return d;
  return { ...d, v: 1, all: [...(d.all ?? []), { kind: 'name', contains: t }] };
}

/** URL form of an unsaved filter (?f=…): JSON of the definition; anything unreadable is "no filter". */
export function encodeDefinition(d: Definition): string {
  return JSON.stringify(d.any && d.any.length > 0 ? { v: 1, all: d.all ?? [], any: d.any } : { v: 1, all: d.all ?? [] });
}

export function decodeDefinition(s: string | null): Definition | null {
  if (!s) return null;
  try {
    const d = JSON.parse(s) as unknown;
    if (!d || typeof d !== 'object' || (d as { v?: unknown }).v !== 1) return null;
    const all = (d as { all?: unknown }).all;
    const any = (d as { any?: unknown }).any;
    const ok = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((c) => c && typeof c === 'object' && typeof (c as { kind?: unknown }).kind === 'string'));
    if (!ok(all) || !ok(any)) return null;
    return { v: 1, all: (all as Clause[] | undefined) ?? [], ...(Array.isArray(any) && any.length > 0 ? { any: any as Clause[] } : {}) };
  } catch {
    return null;
  }
}

/** The empty state names what to loosen: "Try removing Stage is not Closed, Lost or Source is Zillow." */
export function loosenText(labels: readonly string[]): string {
  if (labels.length === 0) return 'No one you can see is here yet.';
  if (labels.length === 1) return `No one you can see matches ${labels[0]}. Remove or change that filter to see more people.`;
  return `No one you can see matches all of these filters. Try removing ${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}.`;
}
