import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at, zone } from '../../foundation/index.js';
import {
  ALL_PEOPLE,
  comingUpMonthDays,
  compileList,
  containsPattern,
  decodeCursor,
  encodeCursor,
  monthDayRanges,
  nextAnnualLocalDate,
  SmartListDefinitionSchema,
  validateDefinition,
} from './index.js';
import { F_AREA, F_BIRTHDAY, F_BUDGET, F_CLOSED_ON, F_FEATURES, F_TIMELINE, fixtureViewer, T_BUYER, T_HOT, T_VA } from './testing.js';

const NY = zone('America/New_York');

describe('SmartListDefinition v1 (R-PAR-27, R-PAR-29)', () => {
  it('R-PAR-29: an AND of up to 20 clauses plus at most one OR group of 2-10; unknown keys and kinds are refused', () => {
    const stage = { kind: 'stage', in: ['new'] };
    expect(validateDefinition({ v: 1, all: Array(20).fill(stage) }, 'personal').ok).toBe(true);
    expect(validateDefinition({ v: 1, all: Array(21).fill(stage) }, 'personal')).toMatchObject({ ok: false, code: 'LIST_DEFINITION_INVALID' });
    expect(validateDefinition({ v: 1, any: Array(10).fill(stage) }, 'personal').ok).toBe(true);
    expect(validateDefinition({ v: 1, any: Array(11).fill(stage) }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, any: [stage] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 2, all: [] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [], or2: [] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'sql', where: '1=1' }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'stage', in: ['new'], column: 'owner_user_id' }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'stage', in: ['deleted'] }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'tag', op: 'any', tagIds: ['not-a-uuid'] }] }, 'personal').ok).toBe(false);
    expect(validateDefinition(ALL_PEOPLE, 'team').ok).toBe(true);
  });

  it('R-PAR-27: team lists carry no free-text clauses (name, text field values), in the AND list or the OR group; personal lists may', () => {
    const name = { kind: 'name', contains: 'Jane' };
    const text = { kind: 'field', fieldId: F_AREA, op: 'text_contains', value: 'Lakeview' };
    expect(validateDefinition({ v: 1, all: [name] }, 'personal').ok).toBe(true);
    expect(validateDefinition({ v: 1, all: [name] }, 'team')).toMatchObject({ ok: false, code: 'LIST_FREE_TEXT_IN_TEAM_LIST', issues: [{ path: '/all/0' }] });
    expect(validateDefinition({ v: 1, any: [{ kind: 'stage', in: ['new'] }, text] }, 'team')).toMatchObject({ ok: false, code: 'LIST_FREE_TEXT_IN_TEAM_LIST', issues: [{ path: '/any/1' }] });
    // numbers, dates, options and tags are not typed text
    expect(validateDefinition({ v: 1, all: [{ kind: 'field', fieldId: F_BUDGET, op: 'num_gte', value: 500000 }, { kind: 'tag', op: 'any', tagIds: [T_BUYER] }] }, 'team').ok).toBe(true);
  });

  it('R-PAR-29: free text is 1-60 characters without control characters; the definition is at most 8 KB', () => {
    expect(validateDefinition({ v: 1, all: [{ kind: 'name', contains: 'x'.repeat(61) }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'name', contains: 'a\u0000' }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'name', contains: '   ' }] }, 'personal').ok).toBe(false);
    const big = { v: 1, all: Array(20).fill({ kind: 'source', in: Array(50).fill(T_BUYER) }) };
    expect(validateDefinition(big, 'personal')).toMatchObject({ ok: false, code: 'LIST_DEFINITION_TOO_LARGE' });
  });
});

describe('compileList (R-PAR-28, R-PAR-29)', () => {
  it('R-PAR-28: every plan is detail-only and resolves "me" to the viewer; activity windows are instants from the injected clock', () => {
    const v = fixtureViewer();
    const r = compileList(SmartListDefinitionSchema.parse({ v: 1, all: [{ kind: 'owner', is: 'me' }, { kind: 'last_activity', op: 'within_days', days: 7 }, { kind: 'next_task', op: 'due_within_days', days: 2 }] }), v);
    expect(r).toMatchObject({ ok: true, plan: { detailOnly: true, sort: 'last_activity_desc' } });
    if (!r.ok) return;
    expect(r.plan.where.of).toEqual([
      { p: 'owner_in', userIds: [v.userId] },
      { p: 'activity_since', at: at('2026-11-04T15:00:00Z') },
      { p: 'task_due_between', from: v.now, to: at('2026-11-13T15:00:00Z') },
    ]);
  });

  it('R-PAR-8: a definition referencing a protected tag (any, all or none; AND or OR) is flagged for the audience check', () => {
    const v = fixtureViewer();
    for (const d of [
      { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [T_VA] }] },
      { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [T_VA, T_HOT] }] },
      { v: 1, any: [{ kind: 'stage', in: ['new'] }, { kind: 'tag', op: 'all', tagIds: [T_BUYER, T_VA] }] },
    ]) {
      const r = compileList(SmartListDefinitionSchema.parse(d), v);
      expect(r.ok && r.plan.audienceProtected, JSON.stringify(d)).toBe(true);
      expect(r.ok && r.plan.references.protectedTagIds).toEqual([T_VA]);
    }
    const plain = compileList(SmartListDefinitionSchema.parse({ v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [T_BUYER, T_HOT] }] }), v);
    expect(plain.ok && plain.plan.audienceProtected).toBe(false);
  });

  it('R-PAR-29: field clauses must fit the field type; unknown fields and options are refused; strict saves refuse unknown tags', () => {
    const v = fixtureViewer();
    const c = (clause: object, strict = false) => compileList(SmartListDefinitionSchema.parse({ v: 1, all: [clause] }), v, { strict });
    expect(c({ kind: 'field', fieldId: F_BUDGET, op: 'text_eq', value: 'x' })).toMatchObject({ ok: false, code: 'LIST_FIELD_OP_INVALID', path: '/all/0' });
    expect(c({ kind: 'field', fieldId: F_CLOSED_ON, op: 'coming_up', days: 7 })).toMatchObject({ ok: false, code: 'LIST_FIELD_OP_INVALID' }); // not annual
    expect(c({ kind: 'field', fieldId: F_TIMELINE, op: 'opt_all', optionIds: ['now'] })).toMatchObject({ ok: false, code: 'LIST_FIELD_OP_INVALID' }); // single select
    expect(c({ kind: 'field', fieldId: F_TIMELINE, op: 'opt_any', optionIds: ['soon'] })).toMatchObject({ ok: false, code: 'LIST_OPTION_UNKNOWN' });
    expect(c({ kind: 'field', fieldId: T_BUYER, op: 'set' })).toMatchObject({ ok: false, code: 'LIST_FIELD_UNKNOWN' });
    expect(c({ kind: 'tag', op: 'any', tagIds: [F_AREA] }, true)).toMatchObject({ ok: false, code: 'LIST_TAG_UNKNOWN' });
    expect(c({ kind: 'tag', op: 'any', tagIds: [F_AREA] }, false).ok).toBe(true);
    expect(c({ kind: 'field', fieldId: F_FEATURES, op: 'opt_all', optionIds: ['pool', 'garage'] })).toMatchObject({ ok: true, plan: { where: { of: [{ p: 'field_opt_all', optionIds: ['garage', 'pool'] }] } } });
    expect(c({ kind: 'field', fieldId: F_BUDGET, op: 'num_gte', value: 5e5 })).toMatchObject({ ok: true, plan: { where: { of: [{ p: 'field_num', cmp: 'gte', value: 5e5 }] } } });
    expect(c({ kind: 'field', fieldId: F_CLOSED_ON, op: 'date_before', value: '2026-03-01' })).toMatchObject({ ok: true, plan: { where: { of: [{ p: 'field_date_between', from: null, to: '2026-02-28' }] } } });
    expect(c({ kind: 'field', fieldId: F_CLOSED_ON, op: 'date_within_next_days', days: 30 })).toMatchObject({ ok: true, plan: { where: { of: [{ p: 'field_date_between', from: '2026-11-11', to: '2026-12-11' }] } } });
  });

  it('R-PAR-29: "contains" escapes LIKE wildcards so typed text matches literally', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    const r = compileList(SmartListDefinitionSchema.parse({ v: 1, all: [{ kind: 'name', contains: 'O%Brien' }] }), fixtureViewer());
    expect(r.ok && r.plan.where.of[0]).toEqual({ p: 'name_like', pattern: '%o\\%brien%' });
    expect(r.ok && r.plan.freeText).toBe(true);
  });
});

describe('"coming up" annual dates (R-PAR-20)', () => {
  it('R-PAR-20 E176: a 29 February birthday comes up on 28 February in a non-leap year, and on 29 February in a leap year', () => {
    const nonLeap = comingUpMonthDays(at('2027-02-27T17:00:00Z'), NY, 1); // 27 and 28 Feb 2027
    expect(nonLeap).toEqual([227, 228, 229]);
    const leap = comingUpMonthDays(at('2028-02-27T17:00:00Z'), NY, 1); // 27 and 28 Feb 2028
    expect(leap).toEqual([227, 228]);
    expect(comingUpMonthDays(at('2028-02-28T17:00:00Z'), NY, 1)).toEqual([228, 229]);
    expect(nextAnnualLocalDate('1992-02-29', at('2027-02-10T12:00:00Z'), NY)).toBe('2027-02-28');
    expect(nextAnnualLocalDate('1992-02-29', at('2028-02-10T12:00:00Z'), NY)).toBe('2028-02-29');
    expect(nextAnnualLocalDate('1980-11-10', at('2026-11-11T15:00:00Z'), NY)).toBe('2027-11-10');
    expect(nextAnnualLocalDate('1980-11-11', at('2026-11-11T15:00:00Z'), NY)).toBe('2026-11-11');
  });

  it("R-PAR-20: today is the tenant's local day (02:00 UTC on 1 Jan is still 31 Dec in New York); windows wrap the year", () => {
    expect(comingUpMonthDays(at('2027-01-01T02:00:00Z'), NY, 0)).toEqual([1231]);
    expect(comingUpMonthDays(at('2027-01-01T02:00:00Z'), zone('Asia/Tokyo'), 0)).toEqual([101]);
    expect(monthDayRanges(comingUpMonthDays(at('2026-12-30T15:00:00Z'), NY, 4))).toEqual([[101, 103], [1230, 1231]]);
    const plan = compileList(SmartListDefinitionSchema.parse({ v: 1, all: [{ kind: 'field', fieldId: F_BIRTHDAY, op: 'coming_up', days: 14 }] }), fixtureViewer());
    expect(plan.ok && plan.plan.where.of[0]).toEqual({ p: 'field_md_in', fieldId: F_BIRTHDAY, ranges: [[1111, 1125]] });
  });

  it('R-PAR-20 property: the window is exactly the month-days of today..today+N in the tenant zone (plus 229 on a non-leap 28 Feb)', () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31) }), fc.integer({ min: 0, max: 366 }), fc.constantFrom('America/New_York', 'Pacific/Auckland', 'UTC', 'America/Los_Angeles'), (ms, days, z) => {
        // independent oracle: the local date via Intl, then whole UTC days
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
        const [y, m, d] = local.split('-').map(Number) as [number, number, number];
        const want = new Set<number>();
        for (let i = 0; i <= days; i++) {
          const t = new Date(Date.UTC(y, m - 1, d + i));
          const mm = t.getUTCMonth() + 1;
          const dd = t.getUTCDate();
          want.add(mm * 100 + dd);
          const yy = t.getUTCFullYear();
          const leap = (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
          if (mm === 2 && dd === 28 && !leap) want.add(229);
        }
        const keys = comingUpMonthDays(at(new Date(ms).toISOString()), zone(z), days);
        expect(keys).toEqual([...want].sort((a, b) => a - b));
        const ranges = monthDayRanges(keys);
        expect(ranges.flatMap(([a, b]) => keys.filter((k) => k >= a && k <= b))).toHaveLength(keys.length);
      }),
      { numRuns: 400 },
    );
  });
});

describe('keyset cursors (R-PAR-29)', () => {
  it('R-PAR-29: cursors round-trip, are bound to their sort, and reject anything malformed', () => {
    const c = { sort: 'last_activity_desc' as const, key: '2026-11-10T12:00:00.123456+00:00', id: '00000000-0000-4000-8000-0000000000aa' };
    expect(decodeCursor(encodeCursor(c), 'last_activity_desc')).toEqual(c);
    expect(decodeCursor(encodeCursor({ ...c, key: null }), 'last_activity_desc')).toEqual({ ...c, key: null });
    const n = { sort: 'name_asc' as const, key: "zoë o'brien", id: c.id };
    expect(decodeCursor(encodeCursor(n), 'name_asc')).toEqual(n);
    expect(decodeCursor(encodeCursor(c), 'created_desc')).toBeNull();
    for (const bad of ['', '!!!', 'eyJ4IjoxfQ', encodeCursor({ ...c, id: "1' OR '1'='1" }), encodeCursor({ ...c, key: 'not a date' })]) expect(decodeCursor(bad, 'last_activity_desc'), bad).toBeNull();
  });
});
