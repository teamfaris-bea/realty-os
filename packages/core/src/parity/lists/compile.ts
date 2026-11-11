// The smart-list compiler plan (R-PAR-28, R-PAR-29). `compileList(def, viewer)` turns a validated
// SmartListDefinition into PLAN NODES: a closed set of predicate shapes with typed, resolved values
// (instants, month-day keys, escaped LIKE patterns, ids). It produces no SQL. api/lists maps each node
// to one whitelisted, parameterised Kysely fragment (every value a bound parameter), and the run is
// under the viewer's own RLS, returning only people whose detail the viewer sees.
//
// The plan also says what the definition references, so callers can apply the audience rule
// (R-PAR-8): a definition that references a protected-proxy tag never defines the audience of a bulk
// email, text or enrollment (`audienceProtected`). Pure: `now` and the zone are injected.
import { addLocalDays, type IanaZone, type Instant, localDateOf, plusMs, DAY_MS, type Role } from '../../foundation/index.js';
import type { FieldDef, FieldType } from '../fields/types.js';
import { comingUpMonthDays, monthDayRanges } from './dates.js';
import { isFreeTextClause, type ListClause, type ListSort, type SmartListDefinition } from './definition.js';

export type NumCmp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

/** Every predicate a plan can hold. Adding one means adding its fragment in api/lists (and a test). */
export type ListPredicate =
  | { p: 'and'; of: ListPredicate[] }
  | { p: 'or'; of: ListPredicate[] }
  | { p: 'stage_in'; stages: string[] }
  | { p: 'intent_in'; intents: string[] }
  | { p: 'contact_type_in'; types: string[] }
  | { p: 'source_in'; sourceIds: string[] }
  | { p: 'owner_in'; userIds: string[] }
  // exclusions (E194-E197): a person with no value (NULL source, owner or intent) is kept
  | { p: 'stage_not_in'; stages: string[] }
  | { p: 'intent_not_in'; intents: string[] }
  | { p: 'contact_type_not_in'; types: string[] }
  | { p: 'source_not_in'; sourceIds: string[] }
  | { p: 'owner_not_in'; userIds: string[] }
  | { p: 'owner_none' }
  | { p: 'tag_any'; tagIds: string[] }
  | { p: 'tag_all'; tagIds: string[] }
  | { p: 'tag_none'; tagIds: string[] }
  | { p: 'activity_since'; at: Instant }
  | { p: 'activity_before_or_never'; at: Instant }
  | { p: 'activity_never' }
  | { p: 'created_since'; at: Instant }
  | { p: 'created_before'; at: Instant }
  | { p: 'task_overdue'; now: Instant }
  | { p: 'task_due_between'; from: Instant; to: Instant }
  | { p: 'task_any' }
  | { p: 'task_none' }
  | { p: 'name_like'; pattern: string }
  | { p: 'field_set'; fieldId: string }
  | { p: 'field_empty'; fieldId: string }
  | { p: 'field_text_eq'; fieldId: string; text: string }
  | { p: 'field_text_like'; fieldId: string; pattern: string }
  | { p: 'field_num'; fieldId: string; cmp: NumCmp; value: number }
  | { p: 'field_date_between'; fieldId: string; from: string | null; to: string | null }
  | { p: 'field_md_in'; fieldId: string; ranges: [number, number][] }
  | { p: 'field_opt_any'; fieldId: string; optionIds: string[] }
  | { p: 'field_opt_all'; fieldId: string; optionIds: string[] }
  | { p: 'field_opt_none'; fieldId: string; optionIds: string[] };

export type ListPredicateKind = ListPredicate['p'];

/** The whitelist (the fuzz test proves a plan never holds anything else). */
export const PREDICATE_KINDS: readonly ListPredicateKind[] = [
  'and', 'or', 'stage_in', 'intent_in', 'contact_type_in', 'source_in', 'owner_in', 'owner_none',
  'stage_not_in', 'intent_not_in', 'contact_type_not_in', 'source_not_in', 'owner_not_in', 'tag_any', 'tag_all', 'tag_none',
  'activity_since', 'activity_before_or_never', 'activity_never', 'created_since', 'created_before', 'task_overdue', 'task_due_between',
  'task_any', 'task_none', 'name_like', 'field_set', 'field_empty', 'field_text_eq', 'field_text_like', 'field_num', 'field_date_between',
  'field_md_in', 'field_opt_any', 'field_opt_all', 'field_opt_none',
];

export interface ListPlan {
  version: 1;
  where: { p: 'and'; of: ListPredicate[] };
  sort: ListSort;
  /** Always true: lists return only people whose detail the viewer sees (R-PAR-28). */
  detailOnly: true;
  references: { tagIds: string[]; fieldIds: string[]; protectedTagIds: string[] };
  /** R-PAR-8: the definition references a protected-proxy tag, so it never defines a bulk send/enroll audience. */
  audienceProtected: boolean;
  freeText: boolean;
}

export interface ListViewerTag {
  id: string;
  protectedProxy: boolean;
}

/** What the compiler needs about the viewer and the team's catalog (read from the viewer's RLS). */
export interface ListViewer {
  userId: string;
  role: Role;
  now: Instant;
  zone: IanaZone;
  fields: readonly FieldDef[];
  tags: readonly ListViewerTag[];
}

export type CompileIssueCode = 'LIST_FIELD_UNKNOWN' | 'LIST_FIELD_OP_INVALID' | 'LIST_TAG_UNKNOWN' | 'LIST_OPTION_UNKNOWN';
export type CompileResult = { ok: true; plan: ListPlan } | { ok: false; code: CompileIssueCode; path: string };

/** LIKE pattern for "contains", with \, % and _ escaped (the pattern is still a bound parameter). */
export function containsPattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const OPS_BY_TYPE: Readonly<Record<FieldType, ReadonlySet<string>>> = {
  text: new Set(['set', 'empty', 'text_eq', 'text_contains']),
  number: new Set(['set', 'empty', 'num_eq', 'num_gt', 'num_gte', 'num_lt', 'num_lte']),
  date: new Set(['set', 'empty', 'date_before', 'date_after', 'date_on', 'date_within_last_days', 'date_within_next_days', 'coming_up']),
  single_select: new Set(['set', 'empty', 'opt_any', 'opt_none']),
  multi_select: new Set(['set', 'empty', 'opt_any', 'opt_all', 'opt_none']),
};

function localDay(now: Instant, zone: IanaZone, offsetDays: number): string {
  return String(localDateOf(addLocalDays(now, offsetDays, zone), zone));
}

/** The day before / after an ISO date (for strict before/after on a date column). */
function shiftIso(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + days * DAY_MS;
  const d = new Date(t);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function sortedUnique<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort();
}

/**
 * Compiles a definition for one viewer. `strict` (saving a list) also refuses tag ids that are not in
 * the catalog; a run treats an unknown tag as matching nobody.
 */
export function compileList(def: SmartListDefinition, viewer: ListViewer, opts: { sort?: ListSort; strict?: boolean } = {}): CompileResult {
  const fields = new Map(viewer.fields.map((f) => [f.id, f]));
  const tags = new Map(viewer.tags.map((t) => [t.id, t]));
  const tagIds = new Set<string>();
  const fieldIds = new Set<string>();
  let freeText = false;

  const one = (c: ListClause, path: string): ListPredicate | { issue: CompileIssueCode; path: string } => {
    if (isFreeTextClause(c)) freeText = true;
    switch (c.kind) {
      case 'stage':
        return 'not_in' in c ? { p: 'stage_not_in', stages: sortedUnique(c.not_in) } : { p: 'stage_in', stages: sortedUnique(c.in) };
      case 'intent':
        return 'not_in' in c ? { p: 'intent_not_in', intents: sortedUnique(c.not_in) } : { p: 'intent_in', intents: sortedUnique(c.in) };
      case 'contact_type':
        return 'not_in' in c ? { p: 'contact_type_not_in', types: sortedUnique(c.not_in) } : { p: 'contact_type_in', types: sortedUnique(c.in) };
      case 'source':
        return 'not_in' in c ? { p: 'source_not_in', sourceIds: sortedUnique(c.not_in) } : { p: 'source_in', sourceIds: sortedUnique(c.in) };
      case 'owner':
        if ('not_in' in c) return { p: 'owner_not_in', userIds: sortedUnique(c.not_in) };
        if ('in' in c) return { p: 'owner_in', userIds: sortedUnique(c.in) };
        return c.is === 'me' ? { p: 'owner_in', userIds: [viewer.userId] } : { p: 'owner_none' };
      case 'tag': {
        const ids = sortedUnique(c.tagIds);
        if (opts.strict && ids.some((id) => !tags.has(id))) return { issue: 'LIST_TAG_UNKNOWN', path };
        ids.forEach((id) => tagIds.add(id));
        return c.op === 'any' ? { p: 'tag_any', tagIds: ids } : c.op === 'all' ? { p: 'tag_all', tagIds: ids } : { p: 'tag_none', tagIds: ids };
      }
      case 'last_activity':
        if (c.op === 'never') return { p: 'activity_never' };
        return c.op === 'within_days' ? { p: 'activity_since', at: plusMs(viewer.now, -c.days * DAY_MS) } : { p: 'activity_before_or_never', at: plusMs(viewer.now, -c.days * DAY_MS) };
      case 'created':
        return c.op === 'within_days' ? { p: 'created_since', at: plusMs(viewer.now, -c.days * DAY_MS) } : { p: 'created_before', at: plusMs(viewer.now, -c.days * DAY_MS) };
      case 'next_task':
        if ('days' in c) return { p: 'task_due_between', from: viewer.now, to: plusMs(viewer.now, c.days * DAY_MS) };
        if (c.op === 'overdue') return { p: 'task_overdue', now: viewer.now };
        return c.op === 'none' ? { p: 'task_none' } : { p: 'task_any' };
      case 'name':
        return { p: 'name_like', pattern: containsPattern(c.contains) };
      case 'field': {
        const f = fields.get(c.fieldId);
        if (!f) return { issue: 'LIST_FIELD_UNKNOWN', path };
        if (!OPS_BY_TYPE[f.fieldType].has(c.op)) return { issue: 'LIST_FIELD_OP_INVALID', path };
        fieldIds.add(f.id);
        switch (c.op) {
          case 'set':
            return { p: 'field_set', fieldId: f.id };
          case 'empty':
            return { p: 'field_empty', fieldId: f.id };
          case 'text_eq':
            return { p: 'field_text_eq', fieldId: f.id, text: c.value.toLowerCase() };
          case 'text_contains':
            return { p: 'field_text_like', fieldId: f.id, pattern: containsPattern(c.value) };
          case 'num_eq':
          case 'num_gt':
          case 'num_gte':
          case 'num_lt':
          case 'num_lte':
            return { p: 'field_num', fieldId: f.id, cmp: c.op.slice(4) as NumCmp, value: c.value };
          case 'date_before':
            return { p: 'field_date_between', fieldId: f.id, from: null, to: shiftIso(c.value, -1) };
          case 'date_after':
            return { p: 'field_date_between', fieldId: f.id, from: shiftIso(c.value, 1), to: null };
          case 'date_on':
            return { p: 'field_date_between', fieldId: f.id, from: c.value, to: c.value };
          case 'date_within_last_days':
            return { p: 'field_date_between', fieldId: f.id, from: localDay(viewer.now, viewer.zone, -c.days), to: localDay(viewer.now, viewer.zone, 0) };
          case 'date_within_next_days':
            return { p: 'field_date_between', fieldId: f.id, from: localDay(viewer.now, viewer.zone, 0), to: localDay(viewer.now, viewer.zone, c.days) };
          case 'coming_up':
            if (!f.annual) return { issue: 'LIST_FIELD_OP_INVALID', path };
            return { p: 'field_md_in', fieldId: f.id, ranges: monthDayRanges(comingUpMonthDays(viewer.now, viewer.zone, c.days)) };
          case 'opt_any':
          case 'opt_all':
          case 'opt_none': {
            const known = new Set(f.options.map((o) => o.id));
            const ids = sortedUnique(c.optionIds);
            if (ids.some((id) => !known.has(id))) return { issue: 'LIST_OPTION_UNKNOWN', path };
            return { p: c.op === 'opt_any' ? 'field_opt_any' : c.op === 'opt_all' ? 'field_opt_all' : 'field_opt_none', fieldId: f.id, optionIds: ids };
          }
        }
      }
    }
  };

  const and: ListPredicate[] = [];
  for (const [i, c] of def.all.entries()) {
    const r = one(c, `/all/${i}`);
    if ('issue' in r) return { ok: false, code: r.issue, path: r.path };
    and.push(r);
  }
  if (def.any && def.any.length > 0) {
    const or: ListPredicate[] = [];
    for (const [i, c] of def.any.entries()) {
      const r = one(c, `/any/${i}`);
      if ('issue' in r) return { ok: false, code: r.issue, path: r.path };
      or.push(r);
    }
    and.push({ p: 'or', of: or });
  }
  const protectedTagIds = [...tagIds].filter((id) => tags.get(id)?.protectedProxy === true).sort();
  return {
    ok: true,
    plan: {
      version: 1,
      where: { p: 'and', of: and },
      sort: opts.sort ?? 'last_activity_desc',
      detailOnly: true,
      references: { tagIds: [...tagIds].sort(), fieldIds: [...fieldIds].sort(), protectedTagIds },
      audienceProtected: protectedTagIds.length > 0,
      freeText,
    },
  };
}

/** Visits every predicate of a plan (depth first). */
export function walkPlan(p: ListPredicate, visit: (n: ListPredicate) => void): void {
  visit(p);
  if (p.p === 'and' || p.p === 'or') p.of.forEach((x) => walkPlan(x, visit));
}
