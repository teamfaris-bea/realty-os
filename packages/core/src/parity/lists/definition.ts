// SmartListDefinition v1 (R-PAR-27, R-PAR-29). A list is a definition, never a stored result: an AND of
// up to 20 clauses plus at most one OR group of up to 10. Every clause is a closed, typed shape: there
// is no expression language, no column names and no SQL in a definition. Values are ids, enums,
// bounded numbers, ISO dates and (personal lists only) short free text.
//
// Team lists carry no free-text clauses (R-PAR-27): no names, phones or emails typed into a shared
// definition. `validateDefinition(def, scope)` enforces it.
import { z } from 'zod';

export const LIST_STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export type ListStage = (typeof LIST_STAGES)[number];
export const LIST_INTENTS = ['buyer', 'seller', 'buyer_seller', 'renter', 'landlord', 'investor'] as const;
export const LIST_CONTACT_TYPES = ['lead', 'sphere', 'past_client', 'vendor', 'other'] as const;
export const LIST_SORTS = ['last_activity_desc', 'created_desc', 'name_asc', 'next_task_asc', 'stage_entered_desc'] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export const MAX_AND_CLAUSES = 20;
export const MAX_OR_CLAUSES = 10;
export const MAX_DAYS = 3_650;
export const MAX_COMING_UP_DAYS = 366;
export const FREE_TEXT_MAX = 60;
/** The serialized definition limit of `smart_lists.definition` (bytes). */
export const DEFINITION_MAX_BYTES = 8_192;

/** Ids are stored lower-case (the tag-merge rewrite of saved lists relies on it). */
const Id = z.uuid().transform((s) => s.toLowerCase());
const Ids = (max: number) => z.array(Id).min(1).max(max);
const Days = z.number().int().min(1).max(MAX_DAYS);
/** A real calendar date (security review: "2025-02-31" or "0000-01-01" used to reach Postgres and 500 every run). */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    if (y < 1000) return false; // Date.UTC maps years 0-99 to 1900-1999
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'not a calendar date');
const OptionId = z.string().regex(/^[a-z0-9_]{1,40}$/);
// eslint-disable-next-line no-control-regex -- free text never carries control characters
const FreeText = z.string().trim().min(1).max(FREE_TEXT_MAX).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);

// Exclusions ("is not", lane people-filters, E194-E197) are NEW union members with a `not_in` key, so every
// saved v1 definition (`in`, `is`) still parses unchanged. NULL semantics are explicit and plain: "is not X"
// keeps the people with no value (no source, no owner, no intent), because they are not X (E195-E197).
const StageClause = z.union([
  z.strictObject({ kind: z.literal('stage'), in: z.array(z.enum(LIST_STAGES)).min(1).max(8) }),
  z.strictObject({ kind: z.literal('stage'), not_in: z.array(z.enum(LIST_STAGES)).min(1).max(8) }),
]);
const TagClause = z.strictObject({ kind: z.literal('tag'), op: z.enum(['any', 'all', 'none']), tagIds: Ids(20) });
const SourceClause = z.union([
  z.strictObject({ kind: z.literal('source'), in: Ids(50) }),
  z.strictObject({ kind: z.literal('source'), not_in: Ids(50) }),
]);
const OwnerClause = z.union([
  z.strictObject({ kind: z.literal('owner'), is: z.enum(['me', 'none']) }),
  z.strictObject({ kind: z.literal('owner'), in: Ids(50) }),
  z.strictObject({ kind: z.literal('owner'), not_in: Ids(50) }),
]);
const IntentClause = z.union([
  z.strictObject({ kind: z.literal('intent'), in: z.array(z.enum(LIST_INTENTS)).min(1).max(6) }),
  z.strictObject({ kind: z.literal('intent'), not_in: z.array(z.enum(LIST_INTENTS)).min(1).max(6) }),
]);
const ContactTypeClause = z.union([
  z.strictObject({ kind: z.literal('contact_type'), in: z.array(z.enum(LIST_CONTACT_TYPES)).min(1).max(5) }),
  z.strictObject({ kind: z.literal('contact_type'), not_in: z.array(z.enum(LIST_CONTACT_TYPES)).min(1).max(5) }),
]);
const ActivityClause = z.union([
  z.strictObject({ kind: z.literal('last_activity'), op: z.enum(['within_days', 'older_than_days']), days: Days }),
  z.strictObject({ kind: z.literal('last_activity'), op: z.literal('never') }),
]);
const CreatedClause = z.strictObject({ kind: z.literal('created'), op: z.enum(['within_days', 'older_than_days']), days: Days });
const NextTaskClause = z.union([
  z.strictObject({ kind: z.literal('next_task'), op: z.enum(['overdue', 'none', 'any']) }),
  z.strictObject({ kind: z.literal('next_task'), op: z.literal('due_within_days'), days: Days }),
]);
/** Personal lists only: the person's name contains the text (case-insensitive). */
const NameClause = z.strictObject({ kind: z.literal('name'), contains: FreeText });
const FieldClause = z.union([
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['set', 'empty']) }),
  /** free text: personal lists only */
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['text_eq', 'text_contains']), value: FreeText }),
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['num_eq', 'num_gt', 'num_gte', 'num_lt', 'num_lte']), value: z.number().finite().gt(-1e15).lt(1e15) }),
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['date_before', 'date_after', 'date_on']), value: IsoDate }),
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['date_within_last_days', 'date_within_next_days']), days: Days }),
  /** annual fields only: the next occurrence (month/day) is within `days` of today, today included */
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.literal('coming_up'), days: z.number().int().min(0).max(MAX_COMING_UP_DAYS) }),
  z.strictObject({ kind: z.literal('field'), fieldId: Id, op: z.enum(['opt_any', 'opt_all', 'opt_none']), optionIds: z.array(OptionId).min(1).max(50) }),
]);

export const ListClauseSchema = z.union([
  StageClause,
  TagClause,
  SourceClause,
  OwnerClause,
  IntentClause,
  ContactTypeClause,
  ActivityClause,
  CreatedClause,
  NextTaskClause,
  NameClause,
  FieldClause,
]);
export type ListClause = z.infer<typeof ListClauseSchema>;

export const SmartListDefinitionSchema = z.strictObject({
  v: z.literal(1),
  /** AND of these */
  all: z.array(ListClauseSchema).max(MAX_AND_CLAUSES).default([]),
  /** plus at most one OR group (at least 2 alternatives when present) */
  any: z.array(ListClauseSchema).min(2).max(MAX_OR_CLAUSES).optional(),
});
export type SmartListDefinition = z.infer<typeof SmartListDefinitionSchema>;
export type SmartListDefinitionInput = z.input<typeof SmartListDefinitionSchema>;

/** The empty definition: everyone the viewer can see (the People tab's default). */
export const ALL_PEOPLE: SmartListDefinition = { v: 1, all: [] };

export type ListScope = 'team' | 'personal';

export type DefinitionIssueCode = 'LIST_DEFINITION_INVALID' | 'LIST_FREE_TEXT_IN_TEAM_LIST' | 'LIST_DEFINITION_TOO_LARGE';
export interface DefinitionIssue {
  ok: false;
  code: DefinitionIssueCode;
  issues: { path: string; message: string }[];
}

/** UTF-8 byte length (what `octet_length(definition::text)` bounds, approximately: jsonb re-spaces). */
export function utf8Length(s: string): number {
  return encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, 'x').length;
}

/** True when the clause carries text a person typed (a name, a text value). */
export function isFreeTextClause(c: ListClause): boolean {
  return c.kind === 'name' || (c.kind === 'field' && (c.op === 'text_eq' || c.op === 'text_contains'));
}

/**
 * The definition as Postgres prints `jsonb::text` (a space after every `:` and `,`), which is what the
 * `smart_lists.definition` CHECK measures. Plain `JSON.stringify` is shorter, so a definition core accepted
 * could fail the CHECK with a 500 (security review).
 */
function jsonbText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(v);
}

/** Parses and checks a definition for a scope (R-PAR-27: team lists carry no free text). */
export function validateDefinition(raw: unknown, scope: ListScope): { ok: true; definition: SmartListDefinition } | DefinitionIssue {
  const parsed = SmartListDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'LIST_DEFINITION_INVALID',
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: `/${i.path.join('/')}`, message: i.message })),
    };
  }
  const def = parsed.data;
  if (utf8Length(jsonbText(def)) > DEFINITION_MAX_BYTES) {
    return { ok: false, code: 'LIST_DEFINITION_TOO_LARGE', issues: [{ path: '/', message: `at most ${DEFINITION_MAX_BYTES} bytes` }] };
  }
  if (scope === 'team') {
    const issues: { path: string; message: string }[] = [];
    def.all.forEach((c, i) => isFreeTextClause(c) && issues.push({ path: `/all/${i}`, message: 'team lists cannot hold typed text' }));
    def.any?.forEach((c, i) => isFreeTextClause(c) && issues.push({ path: `/any/${i}`, message: 'team lists cannot hold typed text' }));
    if (issues.length > 0) return { ok: false, code: 'LIST_FREE_TEXT_IN_TEAM_LIST', issues };
  }
  return { ok: true, definition: def };
}
