// Custom field shapes shared by validation, definitions and the list compiler (R-PAR-17..20).

export const FIELD_TYPES = ['text', 'number', 'date', 'single_select', 'multi_select'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const CUSTOM_FIELD_LIMIT = 50;
export const FIELD_OPTION_LIMIT = 100;
export const FIELD_LABEL_MAX = 60;
export const FIELD_TEXT_MAX = 1_000;
export const FIELD_MULTI_MAX = 50;

export interface FieldOption {
  id: string;
  label: string;
  archived?: boolean;
}

/** A definition as core needs it (the `custom_field_defs` row, camel-cased). */
export interface FieldDef {
  id: string;
  key: string;
  label: string;
  fieldType: FieldType;
  options: readonly FieldOption[];
  annual: boolean;
  archived: boolean;
}

/** One typed value, exactly one of the `contact_field_values` value columns. */
export type TypedValue =
  | { type: 'text'; text: string }
  | { type: 'number'; number: number }
  | { type: 'date'; date: string }
  | { type: 'options'; optionIds: string[] };

/**
 * The built-in protected attribute keys (R-AST-12 list, mirrored by the `custom_field_defs` key CHECK).
 * Those facts live only in `contact_attributes` (self-reported, "the client told me").
 */
export const BUILT_IN_PROTECTED_KEYS = [
  'military_status',
  'va_loan_interest',
  'pcs_orders',
  'pcs_timeline',
  'source_of_income',
  'familial_status',
  'disability',
  'religion',
  'national_origin',
] as const;
