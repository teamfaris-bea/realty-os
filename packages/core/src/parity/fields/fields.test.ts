import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyFieldDefPatch, BUILT_IN_PROTECTED_KEYS, type FieldDef, keyFromLabel, PROTECTED_FIELD_POINTER, uniqueKey, validateFieldValue, validateNewFieldDef } from './index.js';

const def = (o: Partial<FieldDef> & Pick<FieldDef, 'fieldType'>): FieldDef => ({ id: 'f1', key: 'k', label: 'K', options: [], annual: false, archived: false, ...o });
const select = def({ fieldType: 'single_select', options: [{ id: 'pre_approved', label: 'Pre-approved' }, { id: 'cash', label: 'Cash' }, { id: 'old', label: 'Old', archived: true }] });
const multi = def({ fieldType: 'multi_select', options: select.options });

describe('validateFieldValue (R-PAR-17, R-PAR-19)', () => {
  it('R-PAR-17: text is trimmed, at most 1,000 characters, no control characters (tabs and newlines allowed)', () => {
    const t = def({ fieldType: 'text' });
    expect(validateFieldValue(t, '  Lakeview  ')).toEqual({ ok: true, value: { type: 'text', text: 'Lakeview' } });
    expect(validateFieldValue(t, 'a\nb\tc')).toEqual({ ok: true, value: { type: 'text', text: 'a\nb\tc' } });
    expect(validateFieldValue(t, 'x'.repeat(1001))).toEqual({ ok: false, code: 'CUSTOM_VALUE_TOO_LONG' });
    expect(validateFieldValue(t, 'a\u0000b')).toEqual({ ok: false, code: 'CUSTOM_VALUE_TYPE' });
    expect(validateFieldValue(t, 5)).toEqual({ ok: false, code: 'CUSTOM_VALUE_TYPE' });
  });

  it('R-PAR-17: numbers accept numbers and numeric strings (commas ok), finite, |n| < 1e15', () => {
    const n = def({ fieldType: 'number' });
    expect(validateFieldValue(n, 450000)).toEqual({ ok: true, value: { type: 'number', number: 450000 } });
    expect(validateFieldValue(n, '1,250,000.50')).toEqual({ ok: true, value: { type: 'number', number: 1250000.5 } });
    expect(validateFieldValue(n, -0)).toEqual({ ok: true, value: { type: 'number', number: 0 } });
    for (const bad of ['12abc', 'NaN', 'Infinity', Number.NaN, Number.POSITIVE_INFINITY, '1e5', true, {}]) expect(validateFieldValue(n, bad).ok, String(bad)).toBe(false);
    expect(validateFieldValue(n, 1e15)).toEqual({ ok: false, code: 'CUSTOM_VALUE_RANGE' });
  });

  it('R-PAR-17: dates are real YYYY-MM-DD calendar days (29 Feb only in leap years)', () => {
    const d = def({ fieldType: 'date' });
    expect(validateFieldValue(d, '2024-02-29')).toEqual({ ok: true, value: { type: 'date', date: '2024-02-29' } });
    for (const bad of ['2023-02-29', '2024-13-01', '2024-04-31', '24-01-01', '2024-1-1', '1700-01-01', 20240101]) expect(validateFieldValue(d, bad).ok, String(bad)).toBe(false);
  });

  it('R-PAR-17: select values are live option ids; single = exactly one; multi = distinct, at most 50', () => {
    expect(validateFieldValue(select, 'cash')).toEqual({ ok: true, value: { type: 'options', optionIds: ['cash'] } });
    expect(validateFieldValue(select, ['cash'])).toEqual({ ok: true, value: { type: 'options', optionIds: ['cash'] } });
    expect(validateFieldValue(select, ['cash', 'pre_approved'])).toEqual({ ok: false, code: 'CUSTOM_VALUE_TYPE' });
    expect(validateFieldValue(select, 'old')).toEqual({ ok: false, code: 'CUSTOM_VALUE_OPTION' }); // archived option
    expect(validateFieldValue(select, 'Cash')).toEqual({ ok: false, code: 'CUSTOM_VALUE_OPTION' }); // labels are not ids
    expect(validateFieldValue(multi, ['cash', 'pre_approved'])).toEqual({ ok: true, value: { type: 'options', optionIds: ['cash', 'pre_approved'] } });
    expect(validateFieldValue(multi, ['cash', 'cash'])).toEqual({ ok: false, code: 'CUSTOM_VALUE_OPTION' });
    expect(validateFieldValue(multi, 'cash')).toEqual({ ok: false, code: 'CUSTOM_VALUE_TYPE' });
  });

  it('R-PAR-17: an archived field is read-only; empty input clears the value', () => {
    expect(validateFieldValue({ ...select, archived: true }, 'cash')).toEqual({ ok: false, code: 'CUSTOM_FIELD_ARCHIVED' });
    for (const empty of [null, undefined, '', '   ', []]) expect(validateFieldValue(select, empty)).toEqual({ ok: true, value: null });
  });

  it('R-PAR-17 property: an accepted value always has the field type (the DB guard would accept its shape)', () => {
    const defs = [def({ fieldType: 'text' }), def({ fieldType: 'number' }), def({ fieldType: 'date' }), select, multi];
    const expected = { text: 'text', number: 'number', date: 'date', single_select: 'options', multi_select: 'options' } as const;
    fc.assert(
      fc.property(fc.constantFrom(...defs), fc.oneof(fc.string(), fc.double(), fc.integer(), fc.array(fc.constantFrom('cash', 'pre_approved', 'old', 'x')), fc.constant(null)), (d, raw) => {
        const r = validateFieldValue(d, raw);
        if (!r.ok || r.value === null) return;
        expect(r.value.type).toBe(expected[d.fieldType]);
        if (r.value.type === 'options') {
          expect(new Set(r.value.optionIds).size).toBe(r.value.optionIds.length);
          if (d.fieldType === 'single_select') expect(r.value.optionIds).toHaveLength(1);
          for (const id of r.value.optionIds) expect(d.options.find((o) => o.id === id)?.archived).not.toBe(true);
        }
        if (r.value.type === 'number') expect(Number.isFinite(r.value.number) && Math.abs(r.value.number) < 1e15).toBe(true);
        if (r.value.type === 'text') expect([...r.value.text].length).toBeLessThanOrEqual(1000);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('field definitions (R-PAR-17, R-PAR-18)', () => {
  it('R-PAR-18 E175: a field labelled "Military status" is refused with CUSTOM_FIELD_PROTECTED and the pointer to the self-reported attributes', () => {
    const r = validateNewFieldDef({ label: 'Military status', fieldType: 'single_select', options: [{ label: 'Active' }] }, new Set());
    expect(r).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED', path: '/label' });
    expect(PROTECTED_FIELD_POINTER).toMatch(/self-reported/);
  });

  it('R-PAR-18: protected options, protected keys and the built-in R-AST-12 keys are refused too', () => {
    expect(validateNewFieldDef({ label: 'Loan type', fieldType: 'single_select', options: [{ label: 'Conventional' }, { label: 'VA' }] }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED', path: '/options/1/label' });
    for (const key of BUILT_IN_PROTECTED_KEYS) expect(validateNewFieldDef({ label: 'Notes', key, fieldType: 'text' }, new Set()), key).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED' });
    for (const label of ['Household size', 'Religion', 'Number of kids', 'Language spoken', 'Source of income', 'Disability']) expect(validateNewFieldDef({ label, fieldType: 'text' }, new Set()).ok, label).toBe(false);
    expect(applyFieldDefPatch(def({ fieldType: 'text', label: 'Notes' }), { label: 'Veteran?' })).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED' });
  });

  it('R-PAR-17: typed definitions; keys derived from labels and unique; annual only for dates; options only for selects', () => {
    expect(validateNewFieldDef({ label: 'Home anniversary', fieldType: 'date', annual: true }, new Set())).toEqual({ ok: true, def: { key: 'home_anniversary', label: 'Home anniversary', fieldType: 'date', options: [], annual: true } });
    expect(validateNewFieldDef({ label: 'Birthday', fieldType: 'date', annual: true }, new Set(['birthday']))).toMatchObject({ ok: true, def: { key: 'birthday_2' } });
    expect(validateNewFieldDef({ label: 'Budget', fieldType: 'number', annual: true }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_ANNUAL_INVALID' });
    expect(validateNewFieldDef({ label: 'Budget', fieldType: 'number', options: [{ label: 'x' }] }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID' });
    expect(validateNewFieldDef({ label: 'Timeline', fieldType: 'single_select' }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID' });
    expect(validateNewFieldDef({ label: 'Timeline', fieldType: 'json' }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_TYPE_INVALID' });
    expect(validateNewFieldDef({ label: '', fieldType: 'text' }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_LABEL_INVALID' });
    expect(validateNewFieldDef({ label: 'X', key: 'Bad Key', fieldType: 'text' }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_KEY_INVALID' });
    const opts = validateNewFieldDef({ label: 'Timeline', fieldType: 'single_select', options: [{ label: '0-3 months' }, { label: '3-6 months' }] }, new Set());
    expect(opts).toMatchObject({ ok: true, def: { options: [{ id: '0_3_months', label: '0-3 months' }, { id: '3_6_months', label: '3-6 months' }] } });
    expect(validateNewFieldDef({ label: 'T', fieldType: 'single_select', options: [{ label: 'A' }, { label: 'a' }] }, new Set())).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID' });
  });

  it('R-PAR-17 E174: renaming option "Pre-approved" to "Preapproved" keeps its id; options are archived, never removed; key and type never change', () => {
    const r = applyFieldDefPatch(select, { renameOptions: { pre_approved: 'Preapproved' }, archiveOptions: ['cash'], addOptions: [{ label: 'FHA' }] });
    expect(r).toEqual({ ok: true, label: 'K', options: [{ id: 'pre_approved', label: 'Preapproved' }, { id: 'cash', label: 'Cash', archived: true }, { id: 'old', label: 'Old', archived: true }, { id: 'fha', label: 'FHA' }] });
    expect(applyFieldDefPatch(select, { fieldType: 'text' })).toEqual({ ok: false, code: 'CUSTOM_FIELD_IMMUTABLE' });
    expect(applyFieldDefPatch(select, { key: 'other' })).toEqual({ ok: false, code: 'CUSTOM_FIELD_IMMUTABLE' });
    expect(applyFieldDefPatch(select, { renameOptions: { nope: 'x' } })).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID' });
    expect(applyFieldDefPatch(def({ fieldType: 'text' }), { addOptions: [{ label: 'x' }] })).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_OPTIONS_INVALID' });
    expect(applyFieldDefPatch(select, { unarchiveOptions: ['old'] })).toMatchObject({ ok: true, options: [{ id: 'pre_approved' }, { id: 'cash' }, { id: 'old', label: 'Old' }] });
  });

  it('R-PAR-17 property: generated keys always satisfy the DB key CHECK and avoid taken keys', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 70 }), fc.array(fc.stringMatching(/^[a-z][a-z0-9_]{1,10}$/), { maxLength: 5 }), (label, taken) => {
        const k = uniqueKey(keyFromLabel(label), new Set(taken));
        expect(k).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
        expect(taken).not.toContain(k);
      }),
      { numRuns: 500 },
    );
  });
});
