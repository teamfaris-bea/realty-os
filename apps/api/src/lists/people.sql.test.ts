// R-PAR-29 fuzz: the plan → SQL mapping never puts an input value into SQL text. Every definition the
// core schema accepts is compiled for a viewer and rendered to SQL; each typed value (names, text
// values, numbers, dates, ids) must appear only among the bound parameters, never in the SQL string,
// and the SQL text must be one of a finite set of fixed shapes (fragments only).
import { compileList, SmartListDefinitionSchema, validateDefinition } from '@realty/core/parity/lists';
import { F_AREA, F_BIRTHDAY, F_BUDGET, F_CLOSED_ON, F_FEATURES, F_TIMELINE, fixtureViewer, T_BUYER, T_HOT, T_VA } from '@realty/core/parity/lists/testing';
import fc from 'fast-check';
import { Kysely, PostgresDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { countQuery, pageQuery } from './repos/people.js';

// compile-only Kysely (never connects)
const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: { connect: () => Promise.reject(new Error('no db')), end: async () => {} } as never }) });

const EVIL = ["'; DROP TABLE contacts; --", "') OR ('1'='1", '$1', '%', '_', '\\', 'app.evil_fn()', 'SELECT', '"', '/*', '*/', '--', 'Ω≈ç√'];
// eslint-disable-next-line no-control-regex -- free text never carries control characters
const text = fc.oneof(fc.constantFrom(...EVIL), fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(s)));
const clause = fc.oneof(
  fc.record({ kind: fc.constant('name'), contains: text }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_AREA), op: fc.constantFrom('text_eq', 'text_contains'), value: text }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_BUDGET), op: fc.constantFrom('num_eq', 'num_gt', 'num_gte', 'num_lt', 'num_lte'), value: fc.double({ min: -1e14, max: 1e14, noNaN: true }) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_CLOSED_ON), op: fc.constantFrom('date_before', 'date_after', 'date_on'), value: fc.date({ min: new Date('1900-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_BIRTHDAY), op: fc.constant('coming_up'), days: fc.integer({ min: 0, max: 366 }) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constantFrom(F_TIMELINE, F_FEATURES), op: fc.constant('opt_any'), optionIds: fc.constant(['now']) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_FEATURES), op: fc.constantFrom('opt_all', 'opt_none'), optionIds: fc.subarray(['pool', 'garage'], { minLength: 1 }) }),
  fc.record({ kind: fc.constant('tag'), op: fc.constantFrom('any', 'all', 'none'), tagIds: fc.subarray([T_BUYER, T_HOT, T_VA], { minLength: 1 }) }),
  fc.record({ kind: fc.constant('stage'), in: fc.subarray(['new', 'attempting', 'active', 'lost'], { minLength: 1 }) }),
  fc.record({ kind: fc.constant('last_activity'), op: fc.constantFrom('within_days', 'older_than_days'), days: fc.integer({ min: 1, max: 3650 }) }),
  fc.record({ kind: fc.constant('next_task'), op: fc.constantFrom('overdue', 'none', 'any') }),
  fc.record({ kind: fc.constant('owner'), is: fc.constantFrom('me', 'none') }),
  fc.record({ kind: fc.constant('source'), in: fc.array(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 3 }) }),
);
const definition = fc.record({ v: fc.constant(1), all: fc.array(clause, { maxLength: 8 }), any: fc.option(fc.array(clause, { minLength: 2, maxLength: 4 }), { nil: undefined }) });

const SENTINEL = 'zq7sentinelzq';

/** The same definition with every typed text replaced by a sentinel, numbers and dates by others. */
function mutate(def: unknown): unknown {
  if (Array.isArray(def)) return def.map(mutate);
  if (!def || typeof def !== 'object') return def;
  const o = def as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'contains' || (k === 'value' && typeof v === 'string' && (o.op === 'text_eq' || o.op === 'text_contains'))) out[k] = SENTINEL;
    else if (k === 'value' && typeof v === 'number') out[k] = 424242.5;
    else if (k === 'value' && typeof v === 'string') out[k] = '1999-12-31';
    else out[k] = mutate(v);
  }
  return out;
}

describe('R-PAR-29 the list SQL is fixed fragments plus bound parameters', () => {
  it('R-PAR-29 fuzz: the SQL text never depends on a typed value (swapping every value for a sentinel leaves the text identical; the sentinel appears only as a parameter)', () => {
    const shapes = new Set<string>();
    fc.assert(
      fc.property(definition, fc.constantFrom('last_activity_desc', 'created_desc', 'name_asc', 'next_task_asc', 'stage_entered_desc') as fc.Arbitrary<'name_asc'>, (raw, sort) => {
        const a = validateDefinition(raw, 'personal');
        const b = validateDefinition(mutate(raw), 'personal');
        if (!a.ok || !b.ok) return;
        const ra = compileList(a.definition, fixtureViewer(), { sort });
        const rb = compileList(b.definition, fixtureViewer(), { sort });
        if (!ra.ok || !rb.ok) return;
        const cursorA = { sort, key: sort === 'name_asc' ? "o'brien" : '2026-01-01T00:00:00.000000Z', id: '00000000-0000-4000-8000-000000000001' };
        const cursorB = { sort, key: sort === 'name_asc' ? SENTINEL : '2000-01-01T00:00:00.000000Z', id: '00000000-0000-4000-8000-000000000002' };
        const pairs = [
          [pageQuery(ra.plan, null, 51), pageQuery(rb.plan, null, 51)],
          [pageQuery(ra.plan, cursorA, 51), pageQuery(rb.plan, cursorB, 51)],
          [countQuery(ra.plan, 10000), countQuery(rb.plan, 10000)],
        ] as const;
        for (const [qa, qb] of pairs) {
          const ca = qa.compile(db);
          const cb = qb.compile(db);
          expect(cb.sql).toBe(ca.sql);
          expect(cb.sql.includes(SENTINEL)).toBe(false);
          for (const evil of EVIL) if (evil.length > 3 && evil !== 'SELECT') expect(ca.sql.includes(evil), evil).toBe(false);
          expect(ca.parameters.length).toBe(new Set(ca.sql.match(/\$\d+/g) ?? []).size);
          shapes.add(ca.sql);
        }
        if (JSON.stringify(b.definition).includes(SENTINEL)) expect(JSON.stringify(pageQuery(rb.plan, null, 51).compile(db).parameters)).toContain(SENTINEL);
      }),
      { numRuns: 600 },
    );
    expect(shapes.size).toBeGreaterThan(10);
  });

  it('R-PAR-29: an injection attempt in a name filter is a parameter (escaped for LIKE), never SQL', () => {
    const def = SmartListDefinitionSchema.parse({ v: 1, all: [{ kind: 'name', contains: "x'; DROP TABLE contacts; --" }] });
    const r = compileList(def, fixtureViewer());
    if (!r.ok) throw new Error('compile');
    const c = pageQuery(r.plan, null, 51).compile(db);
    expect(c.sql).not.toContain('DROP');
    expect(c.parameters).toContain("%x'; drop table contacts; --%");
  });
});
