// Custom field value validation (R-PAR-17, R-PAR-19): one typed value per person per field, of the
// definition's type; select values are live option ids; an archived field is read-only. Mirrors the
// `contact_field_values_guard` trigger so the sheet can explain a refusal before the round trip; the
// database still decides. `null`, `''` and `[]` mean "clear the value". Pure.
import { FIELD_MULTI_MAX, FIELD_TEXT_MAX, type FieldDef, type TypedValue } from './types.js';

export type FieldValueIssueCode =
  | 'CUSTOM_FIELD_ARCHIVED'
  | 'CUSTOM_VALUE_TYPE'
  | 'CUSTOM_VALUE_TOO_LONG'
  | 'CUSTOM_VALUE_OPTION'
  | 'CUSTOM_VALUE_RANGE';

export type FieldValueResult = { ok: true; value: TypedValue | null } | { ok: false; code: FieldValueIssueCode };

// eslint-disable-next-line no-control-regex -- control characters are refused (tab and newline allowed)
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
}

/** A real calendar date `YYYY-MM-DD` between 1800 and 2200, or null. */
export function parseLocalDate(s: string): string | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1800 || y > 2200 || mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= dim ? s : null;
}

function liveOptionIds(def: FieldDef): Set<string> {
  return new Set(def.options.filter((o) => o.archived !== true).map((o) => o.id));
}

/** PARITY_PLAN §4.2: the typed value for `raw`, or why it does not fit the field. */
export function validateFieldValue(def: FieldDef, raw: unknown): FieldValueResult {
  if (def.archived) return { ok: false, code: 'CUSTOM_FIELD_ARCHIVED' };
  if (isEmpty(raw)) return { ok: true, value: null };
  switch (def.fieldType) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      const text = raw.trim();
      if (CONTROL_RE.test(text)) return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      if ([...text].length > FIELD_TEXT_MAX) return { ok: false, code: 'CUSTOM_VALUE_TOO_LONG' };
      return { ok: true, value: { type: 'text', text } };
    }
    case 'number': {
      let n: number;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string' && NUMBER_RE.test(raw.trim().replace(/,/g, ''))) n = Number(raw.trim().replace(/,/g, ''));
      else return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      if (!Number.isFinite(n)) return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      if (Math.abs(n) >= 1e15) return { ok: false, code: 'CUSTOM_VALUE_RANGE' };
      return { ok: true, value: { type: 'number', number: Object.is(n, -0) ? 0 : n } };
    }
    case 'date': {
      if (typeof raw !== 'string') return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      const date = parseLocalDate(raw.trim());
      return date === null ? { ok: false, code: 'CUSTOM_VALUE_TYPE' } : { ok: true, value: { type: 'date', date } };
    }
    case 'single_select': {
      const id = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
      if (typeof id !== 'string') return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      if (!liveOptionIds(def).has(id)) return { ok: false, code: 'CUSTOM_VALUE_OPTION' };
      return { ok: true, value: { type: 'options', optionIds: [id] } };
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return { ok: false, code: 'CUSTOM_VALUE_TYPE' };
      const ids = raw as string[];
      if (new Set(ids).size !== ids.length) return { ok: false, code: 'CUSTOM_VALUE_OPTION' };
      if (ids.length > FIELD_MULTI_MAX) return { ok: false, code: 'CUSTOM_VALUE_RANGE' };
      const live = liveOptionIds(def);
      if (ids.some((x) => !live.has(x))) return { ok: false, code: 'CUSTOM_VALUE_OPTION' };
      return { ok: true, value: { type: 'options', optionIds: [...ids] } };
    }
  }
}
