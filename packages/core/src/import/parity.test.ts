// core import parity (PARITY_PLAN module 65): property tests on the decision functions plus the rule cases
// (R-PAR-46, R-PAR-6, R-PAR-8, R-PAR-17, R-PAR-18, E190, E191).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { check, DEFAULT_FAIR_HOUSING_PACK, hasAnyMatch } from '../fairhousing/index.js';
import { validateFieldValue, validateNewFieldDef } from '../parity/fields/index.js';
import { classifyProtected as parityClassifyProtected, normalizeTagName as parityNormalizeTagName } from '../parity/tags/index.js';
import {
  DEFAULT_PARITY_OPTIONS,
  type FieldType,
  classifyProtected,
  contactTagNames,
  fieldKeyFrom,
  fieldKeyProtected,
  fieldLabelFromKey,
  fieldValueInput,
  mappedStage,
  normalizeTagName,
  optionsFromValues,
  parityCommittedReport,
  parityLines,
  parityReport,
  paritySummary,
  stageTagName,
  suggestFieldType,
  typedFieldValue,
} from './parity.js';
import type { NormalizedContact } from './types.js';

function contact(over: Partial<NormalizedContact> = {}): NormalizedContact {
  return {
    category: 'contacts', sourceRef: 'fub:people/1', externalId: '1', firstName: 'Ana', lastName: 'Lead', displayName: 'Ana Lead', contactType: 'lead', stage: 'new',
    intent: null, phones: [], emails: [], addresses: [], tags: [], importedFields: {}, leadSourceLabel: null, createdAt: null, ...over,
  };
}
const ctx = (o: Partial<Parameters<typeof paritySummary>[2]> = {}) => ({ catalogKeys: new Set<string>(), liveFields: 0, existingFields: new Map(), source: 'fub' as const, ...o });

describe('R-PAR-46 stages', () => {
  it('R-PAR-46: a stage label is never silently `new`: unmapped and unrecognised is null (blocks approval); no label is New', () => {
    const o = { ...DEFAULT_PARITY_OPTIONS, stageMap: { 'Waiting On Lender': 'nurture' as const } };
    expect(mappedStage('Waiting On Lender', o)).toBe('nurture');
    expect(mappedStage('Hot Prospect', o)).toBe('active');
    expect(mappedStage('Something Else', o)).toBeNull();
    expect(mappedStage(null, o)).toBe('new');
    expect(mappedStage(undefined, o)).toBe('new');
  });

  it('R-PAR-46 property: mappedStage is the Admin choice whenever there is one, and null only for a label nobody (map or vocabulary) can place', () => {
    const stages = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.option(fc.constantFrom(...stages), { nil: undefined }), (label, chosen) => {
        const o = { ...DEFAULT_PARITY_OPTIONS, stageMap: chosen ? { [label]: chosen } : {} };
        const m = mappedStage(label, o);
        if (chosen) expect(m).toBe(chosen);
        else if (m !== null) expect(stages).toContain(m);
      }),
    );
  });

  it('R-PAR-46 E191: summary lists distinct labels with counts, blocks while one is unmapped, and the stage tag keeps two labels that map to one stage distinct', () => {
    const cs = [contact({ stageLabel: 'Warm A' }), contact({ stageLabel: 'Warm B' }), contact({ stageLabel: 'Warm B' }), contact()];
    const s1 = paritySummary(cs, DEFAULT_PARITY_OPTIONS, ctx());
    expect(s1.stages.map((r) => [r.label, r.people, r.mapped])).toEqual([['Warm B', 2, null], ['Warm A', 1, null]]);
    expect(s1.blockers).toEqual(['STAGE_MAP_INCOMPLETE']);
    const o = { ...DEFAULT_PARITY_OPTIONS, stageMap: { 'Warm A': 'nurture' as const, 'Warm B': 'nurture' as const } };
    const s2 = paritySummary(cs, o, ctx());
    expect(s2.blockers).toEqual([]);
    expect(contactTagNames(cs[0]!, o, 'fub').map((t) => t.name)).toEqual(['FUB stage: Warm A']);
    expect(contactTagNames(cs[1]!, o, 'fub').map((t) => t.name)).toEqual(['FUB stage: Warm B']);
    expect(contactTagNames(cs[1]!, { ...o, keepStageAsTag: false }, 'fub')).toEqual([]);
    expect(stageTagName('x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe('R-PAR-6 R-PAR-8 tags', () => {
  it('R-PAR-6 property: normalizeTagName is idempotent, trimmed, ≤ 64, control-free, and its key ignores case and width', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (raw) => {
        const n = normalizeTagName(raw);
        if (n === null) return;
        expect(n.name.length).toBeGreaterThan(0);
        expect(n.name.length).toBeLessThanOrEqual(64);
        expect(n.name).toBe(n.name.trim());
        expect([...n.name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f)).toBe(false);
        expect(normalizeTagName(n.name)).toEqual(n);
        expect(normalizeTagName(n.name.toUpperCase())?.key).toBe(normalizeTagName(n.name.toLowerCase())?.key);
      }),
    );
    expect(normalizeTagName('Ｂｕｙｅｒ')?.key).toBe(normalizeTagName('buyer')?.key);
  });

  it('R-PAR-6 E165: first spelling wins, an existing catalog tag is reused, and person duplicates collapse', () => {
    const s = paritySummary([contact({ tags: ['Buyer', 'buyer', 'VIP'] }), contact({ tags: ['BUYER'] })], { ...DEFAULT_PARITY_OPTIONS, keepStageAsTag: false }, ctx({ catalogKeys: new Set(['vip']) }));
    expect(s.tags).toMatchObject({ distinct: 2, existing: 1, toCreate: 1, sourceLinks: 3, links: 3 });
  });

  it('R-PAR-46 E190: tags that do not fit the 1,000-tag catalog are TAG_LIMIT and counted as rejected links', () => {
    const catalog = new Set(Array.from({ length: 998 }, (_, i) => `c${i}`));
    const s = paritySummary([contact({ tags: ['a', 'b', 'c', 'd'] })], { ...DEFAULT_PARITY_OPTIONS, keepStageAsTag: false }, ctx({ catalogKeys: catalog }));
    expect(s.tags).toMatchObject({ toCreate: 2, overLimit: 2, sourceLinks: 4, links: 2, overLimitNames: ['c', 'd'] });
    expect(s.blockers).toContain('TAG_LIMIT');
    expect(parityReport(s).find((r) => r.category === 'tags')).toEqual({ category: 'tags', source: 4, imported: 2, needs_review: 0, rejected: 2, duplicate: 0 });
  });

  it('R-PAR-8 C-PAR-3: tags and field names that read like a protected attribute are classified (VERIFY WITH COUNSEL: the lexicon)', () => {
    // module 59's lexicon also reads "school" as a protected proxy (core module 20's attribute vocabulary)
    for (const n of ['VA buyer', 'Military status', 'Has kids', 'Section 8', 'Spanish speaker', 'Christian', 'Disabled', 'School district', 'Active duty', 'Sexual']) expect(classifyProtected(n)).toBe(true);
    for (const n of ['Buyer', 'Hot', 'Lead score', 'Budget', 'Pre-approved', 'DNC']) expect(classifyProtected(n)).toBe(false);
    // a source field key is read as the words of its label too
    for (const k of ['customMilitaryStatus', 'customHasKids', 'customReligion', 'customVaLoan']) expect(fieldKeyProtected(k), k).toBe(true);
    for (const k of ['customLeadScore', 'customTimeline', 'customClosingDate']) expect(fieldKeyProtected(k), k).toBe(false);
  });

  it('R-PAR-8 property: the import classifies tag names exactly as module 59 (the tag writer) does, so "created protected" counts are true', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (n) => {
        expect(classifyProtected(n)).toBe(parityClassifyProtected(n));
      }),
    );
    for (const n of ['VA buyer', 'Seniors', 'Buyer', 'Section 8', 'FUB stage: Hot Prospect']) expect(classifyProtected(n)).toBe(parityClassifyProtected(n));
  });

  // The import's interim rule at 8294de5, deleted when module 59's lexicon replaced it, kept as the oracle:
  // the one shared rule must flag every spelling of its terms that the deleted rule flagged (plural,
  // camelCase, acronym, joined, a FUB field key), so replacing it dropped no protection. VERIFY WITH COUNSEL (C-PAR-3).
  const DELETED_PROTECTED_WORDS = /\b(military|veteran|va|va\s*loan|pcs|active\s*duty|source\s*of\s*income|section\s*8|voucher|familial|children|kids|pregnan|single\s*(mom|dad|parent)|disabilit|disabled|handicap|wheelchair|religio|church|christian|catholic|jewish|muslim|mosque|synagogue|national\s*origin|ethnic|race|racial|nationality|immigra|citizenship|hispanic|latin[oax]|asian|spanish\s*speak|sexual|gender|marital|senior|age\b)/i;
  const deletedRule = (name: string) => DELETED_PROTECTED_WORDS.test(name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')) || hasAnyMatch(check(name, DEFAULT_FAIR_HOUSING_PACK));
  const TERMS = ['military', 'military status', 'veteran', 'va', 'va loan', 'pcs', 'pcs move', 'pcs orders', 'active duty', 'source of income', 'section 8', 'voucher',
    'familial status', 'children', 'kids', 'pregnant', 'pregnancy', 'single mom', 'single dad', 'single parent', 'disability', 'disabled', 'handicap', 'handicapped',
    'wheelchair', 'religion', 'religious', 'church', 'christian', 'catholic', 'jewish', 'muslim', 'mosque', 'synagogue', 'national origin', 'ethnic', 'ethnicity',
    'race', 'racial', 'nationality', 'immigrant', 'immigration', 'citizenship', 'hispanic', 'latino', 'latina', 'latinx', 'asian', 'spanish speaking',
    'spanish speaker', 'sexual', 'sexual orientation', 'gender', 'gender identity', 'marital status', 'senior', 'age'];
  const ACRONYMS = new Set(['va', 'pcs']);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const plural = (w: string) => (/(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
  /** A term as people and FUB write it: as is, capitalised, upper case, snake/kebab, camelCase, acronyms, joined, in a compound, a field key; and plural. */
  const spellings = (term: string): string[] => {
    const words = term.split(' ');
    const out = new Set<string>();
    for (const ws of [words, [...words.slice(0, -1), plural(words.at(-1)!)]]) {
      const camel = ws.map(cap).join('');
      const acro = ws.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : cap(w))).join('');
      const acroLow = ws.map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? cap(w) : w)).join('');
      const joined = ws.join('');
      for (const s of [ws.join(' '), cap(ws.join(' ')), ws.map(cap).join(' '), ws.join(' ').toUpperCase(), ws.join('_'), ws.join('-'), camel, acro, acroLow, joined, cap(joined), joined.toUpperCase(), `Has${camel}`, `${camel}Buyer`, `${acro}Buyer`, `${camel}Status`, `custom${camel}`, `custom${acro}`]) out.add(s);
    }
    return [...out];
  };
  const CORPUS = [...new Set(TERMS.flatMap(spellings))];

  it('R-PAR-8 C-PAR-3: every spelling of the deleted import rule\'s terms that it flagged is still protected (no protection dropped)', () => {
    const oracleProtected = CORPUS.filter(deletedRule);
    expect(oracleProtected.length).toBeGreaterThan(900); // the corpus is the deleted rule's own ground
    expect(oracleProtected.filter((n) => !classifyProtected(n))).toEqual([]);
    // a FUB custom field key: the deleted rule refused it on its key or its label's words
    const keys = CORPUS.filter((k) => k.startsWith('custom') && (deletedRule(k) || deletedRule(fieldLabelFromKey(k))));
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k) => !fieldKeyProtected(k))).toEqual([]);
  });

  it('R-PAR-8 R-PAR-18: the plural, camelCase and joined names the deleted rule protected are protected tags, and refused custom fields', () => {
    const NAMES = ['Hispanics', 'Asians', 'Latinos', 'Latinas', 'Catholics', 'Christians', 'Muslims', 'Single moms', 'Single dads', 'Single parents', 'Races',
      'SingleMom', 'Singleparent', 'HasKids', 'MaritalStatus', 'SourceOfIncome', 'SpanishSpeaking', 'Spanishspeaking', 'VALoan', 'ActiveDuty', 'Activeduty', 'PCSmove', 'PCSing'];
    for (const n of NAMES) {
      expect(deletedRule(n), n).toBe(true);
      expect(classifyProtected(n), n).toBe(true);
    }
    for (const k of ['customSingleParents', 'customSingleMoms', 'customVALoan']) {
      expect(fieldKeyProtected(k), k).toBe(true);
      expect(validateNewFieldDef({ label: fieldLabelFromKey(k), fieldType: 'text' }, new Set()), k).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED' });
    }
    // whole words only: the deleted rule's prefix matches were not protection ("va" in "Vacation", "race" in "Racecar")
    for (const n of ['Vacation home', 'Racecar', 'Church St listing', 'Single family', 'Family room']) expect(classifyProtected(n), n).toBe(false);
  });

  it('R-PAR-6 property: an import tag name is module 59\'s normalized name (same key as tags.name_key), cut to the tag length', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (raw) => {
        const n = normalizeTagName(raw);
        if (n === null) return;
        expect(parityNormalizeTagName(n.name)).toEqual({ ok: true, name: n.name, key: n.key });
      }),
    );
    expect(normalizeTagName('  Ｂｕｙｅｒ  ')).toEqual({ name: 'Ｂｕｙｅｒ', key: 'buyer' });
    expect(normalizeTagName(`VIP${'​'}`)).toEqual({ name: 'VIP', key: 'vip' });
    expect(normalizeTagName('x'.repeat(100))?.name).toBe('x'.repeat(64)); // shortened, not dropped
  });

  it('R-PAR-7 R-CONSENT-3: a DNC-looking tag is counted as an opt-out for the report (the consent rules make it real), and it stays a tag', () => {
    const s = paritySummary([contact({ tags: ['DNC'] }), contact({ tags: ['Opted out'] }), contact({ tags: ['Buyer'] })], DEFAULT_PARITY_OPTIONS, ctx());
    expect(s.tags.optOutTagged).toBe(2);
    expect(parityLines(s, 'Follow Up Boss').join(' ')).toContain('That is recorded as a real opt-out, not just a tag.');
  });
});

describe('R-PAR-17 R-PAR-18 custom fields', () => {
  const TYPES: FieldType[] = ['text', 'number', 'date', 'single_select', 'multi_select'];

  it('R-PAR-17 property: typedFieldValue never throws, and an accepted value always has exactly the shape of its type', () => {
    const opts = optionsFromValues(['Red', 'Blue', 'Green'], false);
    fc.assert(
      fc.property(fc.constantFrom(...TYPES), fc.string({ maxLength: 1200 }), (t, raw) => {
        const r = typedFieldValue(t, opts, raw);
        if (!r.ok) {
          expect(r.code).toBe('CUSTOM_VALUE_INVALID');
          return;
        }
        const keys = Object.keys(r.value);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toBe(t === 'text' ? 'text' : t === 'number' ? 'number' : t === 'date' ? 'date' : 'options');
        if ('number' in r.value) expect(Number.isFinite(r.value.number)).toBe(true);
        if ('date' in r.value) expect(r.value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if ('options' in r.value) for (const id of r.value.options) expect(opts.map((o) => o.id)).toContain(id);
        if ('text' in r.value) expect(r.value.text.length).toBeLessThanOrEqual(1000);
      }),
      { numRuns: 500 },
    );
  });

  it('R-PAR-17: each type reads its values; misfits are refused (they stay as text in imported_fields)', () => {
    const o = optionsFromValues(['0-3 months', '3-6 months'], false);
    expect(typedFieldValue('number', [], '$1,250.50')).toEqual({ ok: true, value: { number: 1250.5 } });
    expect(typedFieldValue('number', [], 'high').ok).toBe(false);
    expect(typedFieldValue('date', [], '2/29/2024')).toEqual({ ok: true, value: { date: '2024-02-29' } });
    expect(typedFieldValue('date', [], '2/29/2023').ok).toBe(false);
    expect(typedFieldValue('single_select', o, '3-6 MONTHS')).toEqual({ ok: true, value: { options: ['3_6_months'] } });
    expect(typedFieldValue('single_select', o, 'never').ok).toBe(false);
    const m = optionsFromValues(['Pool, Garage', 'Garage'], true);
    expect(typedFieldValue('multi_select', m, 'Garage; pool')).toEqual({ ok: true, value: { options: ['garage', 'pool'] } });
    expect(typedFieldValue('text', [], 'x'.repeat(1001)).ok).toBe(false);
    // an archived choice is never written (module 59 accepts live option ids only)
    expect(typedFieldValue('single_select', [{ id: 'later', label: 'Later', archived: true }], 'Later').ok).toBe(false);
    // an empty source value is never a value (it would clear one)
    expect(typedFieldValue('text', [], '   ').ok).toBe(false);
  });

  it('R-PAR-17 R-PAR-19 property: every value the import accepts is accepted by module 59\'s validateFieldValue for that definition, as the same typed value', () => {
    const opts = optionsFromValues(['Red', 'Blue', 'Green'], false);
    const TYPES: FieldType[] = ['text', 'number', 'date', 'single_select', 'multi_select'];
    const sample = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('$1,200', '12/31/2026', '2026-02-29', '2024-02-29', 'red', 'Blue; green', '1e3', '-0', '.5'));
    fc.assert(
      fc.property(fc.constantFrom(...TYPES), sample, (t, raw) => {
        const r = typedFieldValue(t, opts, raw);
        if (!r.ok) return;
        const def = { id: 'f', key: 'k', label: 'K', fieldType: t, options: opts, annual: false, archived: false };
        const v = validateFieldValue(def, fieldValueInput(r.value));
        expect(v.ok).toBe(true);
        if (v.ok && v.value) expect(v.value.type === 'options' ? { options: v.value.optionIds } : v.value.type === 'text' ? { text: v.value.text } : v.value.type === 'number' ? { number: v.value.number } : { date: v.value.date }).toEqual(r.value);
      }),
      { numRuns: 500 },
    );
  });

  it('R-PAR-17: option ids are unique, valid and stable for repeated labels; at most 100', () => {
    const o = optionsFromValues(['A b', 'a-b', 'A B', ...Array.from({ length: 200 }, (_, i) => `v${i}`)], false);
    expect(o.length).toBe(100);
    expect(new Set(o.map((x) => x.id)).size).toBe(o.length);
    for (const x of o) expect(x.id).toMatch(/^[a-z0-9_]{1,40}$/);
  });

  it('R-PAR-18 E175: a source field that reads like a protected attribute is protected (never created); keys never hit the built-in protected list', () => {
    const s = paritySummary(
      [contact({ customFields: { customMilitaryStatus: 'Active duty', customLeadScore: '5' } })],
      { ...DEFAULT_PARITY_OPTIONS, fields: { customMilitaryStatus: { action: 'create', type: 'text', label: 'Status' }, customLeadScore: { action: 'create', type: 'number', label: 'Lead score' } } },
      ctx(),
    );
    expect(s.fields.find((f) => f.sourceKey === 'customMilitaryStatus')).toMatchObject({ protected: true, action: { action: 'skip' }, fit: 0 });
    expect(s.fields.find((f) => f.sourceKey === 'customLeadScore')).toMatchObject({ protected: false, fit: 1, misfit: 0 });
    expect(fieldKeyFrom('customLeadScore')).toBe('fub_lead_score');
    expect(fieldLabelFromKey('customLeadScore')).toBe('Lead Score');
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (k) => {
      const key = fieldKeyFrom(k);
      if (key !== null) expect(key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
    }));
  });

  it('R-PAR-17: more than 50 live fields is CUSTOM_FIELD_LIMIT', () => {
    const s = paritySummary([contact({ customFields: { customA: '1', customB: '2' } })], { ...DEFAULT_PARITY_OPTIONS, fields: { customA: { action: 'create', type: 'number', label: 'A' }, customB: { action: 'create', type: 'number', label: 'B' } } }, ctx({ liveFields: 49 }));
    expect(s.blockers).toContain('CUSTOM_FIELD_LIMIT');
  });

  it('suggestFieldType reads numbers, dates and small choice sets; text otherwise', () => {
    expect(suggestFieldType(['1', '2.5', '$3'])).toBe('number');
    expect(suggestFieldType(['2026-01-01', '1/2/2026'])).toBe('date');
    expect(suggestFieldType(['a', 'b', 'a', 'b'])).toBe('single_select');
    expect(suggestFieldType(['a, b', 'b', 'a', 'b', 'a, b', 'a'])).toBe('multi_select');
    expect(suggestFieldType(['one long note', 'another'])).toBe('text');
  });
});

describe('R-PAR-46 report', () => {
  it('R-PAR-46 property: every dry-run and committed report row reconciles: source = imported + needs review + rejected + duplicate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ stage: fc.option(fc.constantFrom('Hot', 'Cold', 'Lead', 'Weird'), { nil: null }), tags: fc.array(fc.constantFrom('a', 'B', 'b', 'c', 'DNC'), { maxLength: 4 }), score: fc.option(fc.constantFrom('1', 'x', '2'), { nil: null }) }), { maxLength: 20 }),
        fc.record({ stagesSet: fc.nat(50), stagesKept: fc.nat(50), tagLinks: fc.nat(50), tagLinksExisting: fc.nat(50), tagsSkipped: fc.nat(50), values: fc.nat(50), valuesKept: fc.nat(50), valuesMisfit: fc.nat(50) }),
        (people, committed) => {
          const cs = people.map((p) => contact({ stageLabel: p.stage, tags: p.tags, ...(p.score ? { customFields: { customScore: p.score } } : {}) }));
          const s = paritySummary(cs, { ...DEFAULT_PARITY_OPTIONS, fields: { customScore: { action: 'create', type: 'number', label: 'Score' } } }, ctx());
          for (const rows of [parityReport(s), parityCommittedReport(committed)]) {
            for (const r of rows) expect(r.source).toBe(r.imported + r.needs_review + r.rejected + r.duplicate);
          }
        },
      ),
    );
  });
});
