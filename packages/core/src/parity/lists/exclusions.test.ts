// Exclusions ("is not") of SmartListDefinition v1 (lane people-filters, E194-E200): new union members, NULL
// semantics, backward compatibility of every saved v1 shape, and the reference evaluator's own properties.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileList, LIST_CONTACT_TYPES, LIST_INTENTS, LIST_STAGES, type ListPredicate, PREDICATE_KINDS, type SmartListDefinition, validateDefinition, walkPlan } from './index.js';
import { fixtureViewer, refEvaluate, type RefPerson } from './testing/index.js';
import golden from './testing/v1Plans.golden.json' with { type: 'json' };
import { V1_FIXTURE_DEFINITIONS } from './testing/v1Fixtures.js';

const U1 = '00000000-0000-4000-8000-00000000bbb1';
const S1 = '00000000-0000-4000-8000-00000000ddd1';
const S2 = '00000000-0000-4000-8000-00000000ddd2';

function nodes(def: unknown, scope: 'team' | 'personal' = 'team'): ListPredicate[] {
  const v = validateDefinition(def, scope);
  if (!v.ok) throw new Error(JSON.stringify(v));
  const r = compileList(v.definition, fixtureViewer());
  if (!r.ok) throw new Error(JSON.stringify(r));
  const out: ListPredicate[] = [];
  walkPlan(r.plan.where, (n) => out.push(n));
  return out.slice(1);
}

describe('exclusions: "is not" (lane people-filters)', () => {
  it('E194 R-PAR-29: every saved v1 definition still parses and compiles to the exact plan of the pre-exclusion compiler (golden from 1781638)', () => {
    const g = golden as Record<string, { definition: unknown; plan: unknown }>;
    expect(Object.keys(g).sort()).toEqual(V1_FIXTURE_DEFINITIONS.map((f) => f.name).sort());
    for (const f of V1_FIXTURE_DEFINITIONS) {
      const v = validateDefinition(f.definition, f.scope);
      expect(v.ok, f.name).toBe(true);
      if (!v.ok) continue;
      expect(v.definition, f.name).toEqual(g[f.name]!.definition);
      const r = compileList(v.definition, fixtureViewer());
      expect(r.ok && r.plan, f.name).toEqual(g[f.name]!.plan);
    }
  });

  it('E194: stage, source, owner, intent and contact type take `not_in`; the definition stays v: 1 and the plan nodes are whitelisted', () => {
    expect(nodes({ v: 1, all: [{ kind: 'stage', not_in: ['lost', 'closed', 'lost'] }] })).toEqual([{ p: 'stage_not_in', stages: ['closed', 'lost'] }]);
    expect(nodes({ v: 1, all: [{ kind: 'source', not_in: [S2.toUpperCase(), S1] }] })).toEqual([{ p: 'source_not_in', sourceIds: [S1, S2] }]);
    expect(nodes({ v: 1, all: [{ kind: 'owner', not_in: [U1] }] })).toEqual([{ p: 'owner_not_in', userIds: [U1] }]);
    expect(nodes({ v: 1, all: [{ kind: 'intent', not_in: ['buyer'] }] })).toEqual([{ p: 'intent_not_in', intents: ['buyer'] }]);
    expect(nodes({ v: 1, all: [{ kind: 'contact_type', not_in: ['vendor'] }] })).toEqual([{ p: 'contact_type_not_in', types: ['vendor'] }]);
    for (const k of ['stage_not_in', 'source_not_in', 'owner_not_in', 'intent_not_in', 'contact_type_not_in'] as const) expect(PREDICATE_KINDS).toContain(k);
    // an exclusion is not typed text: allowed in a team list, in the AND list and in the OR group
    expect(validateDefinition({ v: 1, all: [{ kind: 'stage', not_in: ['closed', 'lost'] }], any: [{ kind: 'source', not_in: [S1] }, { kind: 'owner', not_in: [U1] }] }, 'team').ok).toBe(true);
  });

  it('E194: one clause holds `in` or `not_in`, never both, never empty, never an unknown value; limits are unchanged', () => {
    const bad: unknown[] = [
      { kind: 'stage', in: ['new'], not_in: ['lost'] },
      { kind: 'stage', not_in: [] },
      { kind: 'stage', not_in: ['deleted'] },
      { kind: 'source', not_in: ['not-a-uuid'] },
      { kind: 'source', not_in: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) },
      { kind: 'owner', is: 'me', not_in: [U1] },
      { kind: 'owner', not_in: 'me' },
      { kind: 'intent', not_in: ['tenant'] },
      { kind: 'contact_type', not_in: ['lead', 'lead', 'lead', 'lead', 'lead', 'lead'] },
      { kind: 'tag', op: 'not', tagIds: [U1] },
      { kind: 'stage', exclude: ['lost'] },
    ];
    for (const c of bad) expect(validateDefinition({ v: 1, all: [c] }, 'personal').ok, JSON.stringify(c)).toBe(false);
    const ex = { kind: 'stage', not_in: ['lost'] };
    expect(validateDefinition({ v: 1, all: Array(20).fill(ex) }, 'team').ok).toBe(true);
    expect(validateDefinition({ v: 1, all: Array(21).fill(ex) }, 'team').ok).toBe(false);
    expect(validateDefinition({ v: 2, all: [ex] }, 'team').ok).toBe(false);
  });

  it('E195 E196 E197: "is not" keeps people with no value; "is" never matches a missing value (reference evaluator)', () => {
    const base: Omit<RefPerson, 'id'> = { displayName: 'X', stage: 'new', intent: null, contactType: 'lead', sourceId: null, ownerId: null, tagIds: [], lastActivityMs: null, createdMs: 0 };
    const people: RefPerson[] = [
      { ...base, id: 'none' },
      { ...base, id: 'zillow', sourceId: S1, ownerId: U1, intent: 'buyer' },
      { ...base, id: 'other', sourceId: S2, ownerId: 'u2', intent: 'seller' },
    ];
    const ctx = { meId: U1, nowMs: 0 };
    const ev = (c: unknown) => refEvaluate({ v: 1, all: [c] } as SmartListDefinition, people, ctx);
    expect(ev({ kind: 'source', not_in: [S1] })).toEqual(['none', 'other']);
    expect(ev({ kind: 'source', in: [S1] })).toEqual(['zillow']);
    expect(ev({ kind: 'owner', not_in: [U1] })).toEqual(['none', 'other']);
    expect(ev({ kind: 'intent', not_in: ['buyer'] })).toEqual(['none', 'other']);
    expect(ev({ kind: 'intent', in: ['buyer'] })).toEqual(['zillow']);
  });

  it('E198 property: for every value set, "is" and "is not" partition the people (each person in exactly one)', () => {
    const person = fc.record({
      id: fc.uuid(),
      displayName: fc.string(),
      stage: fc.constantFrom(...LIST_STAGES),
      intent: fc.option(fc.constantFrom(...LIST_INTENTS), { nil: null }),
      contactType: fc.constantFrom(...LIST_CONTACT_TYPES),
      sourceId: fc.option(fc.constantFrom(S1, S2), { nil: null }),
      ownerId: fc.option(fc.constantFrom(U1, '00000000-0000-4000-8000-00000000bbb2'), { nil: null }),
      tagIds: fc.constant([] as string[]),
      lastActivityMs: fc.constant(null),
      createdMs: fc.constant(0),
    });
    const pick = <T>(xs: readonly T[]) => fc.subarray([...xs], { minLength: 1 });
    const clauseOf = fc.oneof(
      pick(LIST_STAGES).map((v) => ['stage', v] as const),
      pick(LIST_INTENTS).map((v) => ['intent', v] as const),
      pick(LIST_CONTACT_TYPES).map((v) => ['contact_type', v] as const),
      pick([S1, S2]).map((v) => ['source', v] as const),
      pick([U1, '00000000-0000-4000-8000-00000000bbb2']).map((v) => ['owner', v] as const),
    );
    fc.assert(
      fc.property(fc.array(person, { maxLength: 30 }), clauseOf, (people, [kind, values]) => {
        const ctx = { meId: U1, nowMs: 0 };
        const pos = refEvaluate(validDef({ kind, in: values }), people, ctx);
        const neg = refEvaluate(validDef({ kind, not_in: values }), people, ctx);
        expect([...pos, ...neg].sort()).toEqual(people.map((p) => p.id).sort());
        expect(pos.filter((x) => neg.includes(x))).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('E198 fuzz: any accepted definition with exclusions compiles to whitelisted nodes holding only ids and enum values', () => {
    const ids = fc.array(fc.constantFrom(S1, S2, U1, "'; DROP TABLE contacts; --", 'x'), { minLength: 0, maxLength: 3 });
    const cl = fc.oneof(
      fc.record({ kind: fc.constantFrom('stage', 'intent', 'contact_type'), not_in: fc.array(fc.constantFrom('new', 'buyer', 'lead', 'lost', 'x', 'sql'), { maxLength: 3 }) }),
      fc.record({ kind: fc.constantFrom('source', 'owner'), not_in: ids }),
    );
    fc.assert(
      fc.property(fc.record({ v: fc.constant(1), all: fc.array(cl, { maxLength: 4 }) }), (raw) => {
        const v = validateDefinition(raw, 'team');
        if (!v.ok) return;
        const r = compileList(v.definition, fixtureViewer());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        walkPlan(r.plan.where, (n) => {
          expect(PREDICATE_KINDS).toContain(n.p);
          for (const [k, val] of Object.entries(n)) if (k !== 'p' && k !== 'of') for (const s of val as string[]) expect(s).toMatch(/^([0-9a-f-]{36}|[a-z_]+)$/);
        });
      }),
      { numRuns: 800 },
    );
  });
});

function validDef(c: unknown): SmartListDefinition {
  const v = validateDefinition({ v: 1, all: [c] }, 'team');
  if (!v.ok) throw new Error(JSON.stringify(v));
  return v.definition;
}
