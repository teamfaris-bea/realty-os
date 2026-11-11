// @realty/core/parity/fields: PARITY_PLAN module 59 (custom fields). Value validation and
// definition rules (R-PAR-17, R-PAR-18, R-PAR-19). Pure.
export * from './types.js';
export { validateFieldValue, parseLocalDate, type FieldValueIssueCode, type FieldValueResult } from './validate.js';
export {
  validateNewFieldDef,
  applyFieldDefPatch,
  cleanLabel,
  keyFromLabel,
  uniqueKey,
  PROTECTED_FIELD_POINTER,
  type FieldDefIssue,
  type FieldDefIssueCode,
  type FieldDefPatch,
  type NewFieldDefInput,
  type ValidFieldDef,
} from './define.js';
