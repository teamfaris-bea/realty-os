// Adversarial tests for the list definition and compiler (module 59, critical): injection, smuggled
// keys, oversized input, free text hidden in a team list, protected tags hidden in negations.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileList, type ListPredicate, PREDICATE_KINDS, SmartListDefinitionSchema, validateDefinition, walkPlan } from './index.js';
import { F_AREA, F_BUDGET, F_FEATURES, fixtureViewer, T_BUYER, T_VA } from './testing.js';

const INJECTIONS = ["'; DROP TABLE contacts; --", '" OR 1=1 --', '%_\\', 'app.tenant_id()', '$1', '{{agent.email}}', 'SELECT * FROM users', '‮evil'];

/** Arbitrary clause in the v1 vocabulary (valid and invalid values mixed). */
const clause = fc.oneof(
  fc.record({ kind: fc.constant('stage'), in: fc.array(fc.constantFrom('new', 'active', 'lost', 'x'), { minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constant('tag'), op: fc.constantFrom('any', 'all', 'none'), tagIds: fc.array(fc.constantFrom(T_BUYER, T_VA, fc.sample(fc.uuid(), 1)[0]!), { minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constant('name'), contains: fc.oneof(fc.constantFrom(...INJECTIONS), fc.string({ maxLength: 70 })) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_AREA), op: fc.constantFrom('text_eq', 'text_contains'), value: fc.oneof(fc.constantFrom(...INJECTIONS), fc.string({ maxLength: 70 })) }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_BUDGET), op: fc.constantFrom('num_gt', 'num_lte', 'num_eq'), value: fc.double() }),
  fc.record({ kind: fc.constant('field'), fieldId: fc.constant(F_FEATURES), op: fc.constantFrom('opt_any', 'opt_all', 'opt_none'), optionIds: fc.array(fc.constantFrom('pool', 'garage', "pool'--"), { minLength: 1, maxLength: 2 }) }),
  fc.record({ kind: fc.constant('last_activity'), op: fc.constantFrom('within_days', 'older_than_days'), days: fc.integer({ min: -5, max: 5000 }) }),
  fc.record({ kind: fc.constant('owner'), is: fc.constantFrom('me', 'none', 'everyone') }),
  fc.record({ kind: fc.constantFrom('sql', 'raw', '__proto__', 'constructor'), where: fc.string() }),
);
const definition = fc.record({ v: fc.constantFrom(1, 1, 1, 2), all: fc.array(clause, { maxLength: 22 }), any: fc.option(fc.array(clause, { minLength: 0, maxLength: 11 }), { nil: undefined }) });

function collect(plan: { where: ListPredicate }) {
  const nodes: ListPredicate[] = [];
  walkPlan(plan.where, (n) => nodes.push(n));
  return nodes;
}

describe('adversarial: the list compiler (R-PAR-29)', () => {
  it('R-PAR-29 fuzz: any accepted definition compiles to whitelisted plan nodes only, and typed text survives only as an escaped value', () => {
    fc.assert(
      fc.property(definition, fc.constantFrom('team', 'personal') as fc.Arbitrary<'team' | 'personal'>, (raw, scope) => {
        const v = validateDefinition(raw, scope);
        if (!v.ok) return;
        const r = compileList(v.definition, fixtureViewer());
        if (!r.ok) return;
        for (const n of collect(r.plan)) {
          expect(PREDICATE_KINDS).toContain(n.p);
          // the only string-bearing members are ids, enum values, ISO instants/dates and escaped patterns
          for (const [k, val] of Object.entries(n)) {
            if (k === 'p' || k === 'of') continue;
            if (k === 'pattern') expect(val).toMatch(/^%.*%$/s);
          }
          if (scope === 'team') expect(n.p === 'name_like' || n.p === 'field_text_like' || n.p === 'field_text_eq').toBe(false);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('R-PAR-29: smuggled keys (__proto__, constructor, column names) and prototype tricks are refused, never copied into a plan', () => {
    const smuggled = JSON.parse('{"v":1,"all":[{"kind":"stage","in":["new"],"__proto__":{"admin":true}}]}');
    expect(validateDefinition(smuggled, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'stage', in: ['new'], sql: 'true' }] }, 'personal').ok).toBe(false);
    expect(validateDefinition({ v: 1, all: [], having: 'x' }, 'personal').ok).toBe(false);
    expect(validateDefinition(JSON.parse('{"v":1,"all":[],"__proto__":{"any":[]}}'), 'personal').ok).toBe(false);
    expect(validateDefinition(null, 'personal').ok).toBe(false);
    expect(validateDefinition([], 'personal').ok).toBe(false);
    expect(validateDefinition('{"v":1}', 'personal').ok).toBe(false);
  });

  it('R-PAR-27: free text cannot be hidden in a team list through the OR group or a text field', () => {
    for (const d of [
      { v: 1, any: [{ kind: 'stage', in: ['new'] }, { kind: 'name', contains: 'Jane' }] },
      { v: 1, all: [{ kind: 'field', fieldId: F_AREA, op: 'text_eq', value: '555-0100' }] },
      { v: 1, all: [{ kind: 'field', fieldId: F_AREA, op: 'text_contains', value: 'jane@example.com' }] },
    ]) expect(validateDefinition(d, 'team')).toMatchObject({ ok: false, code: 'LIST_FREE_TEXT_IN_TEAM_LIST' });
  });

  it('R-PAR-8: a protected tag cannot be laundered through a negation, an OR group or duplicate ids; the audience flag stays on', () => {
    const v = fixtureViewer();
    for (const d of [
      { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [T_VA] }] },
      { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [T_VA, T_VA, T_BUYER] }] },
      { v: 1, any: [{ kind: 'tag', op: 'any', tagIds: [T_BUYER] }, { kind: 'tag', op: 'any', tagIds: [T_VA] }] },
    ]) {
      const r = compileList(SmartListDefinitionSchema.parse(d), v);
      expect(r.ok && r.plan.audienceProtected, JSON.stringify(d)).toBe(true);
    }
  });

  it('R-PAR-29: numbers and days are bounded; NaN and infinities never reach a plan', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e15, -1e15]) {
      expect(validateDefinition({ v: 1, all: [{ kind: 'field', fieldId: F_BUDGET, op: 'num_gt', value }] }, 'personal').ok, String(value)).toBe(false);
    }
    for (const days of [0, -1, 3651, 1.5]) expect(validateDefinition({ v: 1, all: [{ kind: 'created', op: 'within_days', days }] }, 'personal').ok, String(days)).toBe(false);
    expect(validateDefinition({ v: 1, all: [{ kind: 'field', fieldId: F_BUDGET, op: 'coming_up', days: 367 }] }, 'personal').ok).toBe(false);
  });
});
