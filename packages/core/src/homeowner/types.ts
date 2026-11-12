// Types of module 77 core/homeowner (owner decision D10; R-HOME-1..R-HOME-10).
//
// A homeowner profile is built from county public records for a RECOGNISED seller or homeowner, for agents only.
// The field list is closed: only the values below can be represented, each with its source and as-of date. No loan
// balance, equity, estimate, score or confidence is expressible (R-HOME-4; D10 defers the estimated loan balance and
// equity). The migration's CHECKs mirror HOMEOWNER_FIELDS, SOURCE_PATTERN and REF_PATTERN (a test compares them).
import type { PostalAddress, PropertyRecordCandidate } from '../predict/index.js';

export const HOMEOWNER_FIELDS = [
  'last_transfer_date',
  'last_transfer_price_cents',
  'county_market_value_cents',
  'assessed_value_cents',
  'annual_tax_cents',
  'tax_year',
  'exemption_legal_residence',
  'exemption_homestead',
  'owner_mailing_address',
] as const;
export type HomeownerField = (typeof HOMEOWNER_FIELDS)[number];

/** The value type of each field (the typed column it is stored in). */
export interface HomeownerFieldValues {
  last_transfer_date: string; // YYYY-MM-DD
  last_transfer_price_cents: number;
  county_market_value_cents: number;
  assessed_value_cents: number;
  annual_tax_cents: number;
  tax_year: number;
  exemption_legal_residence: boolean;
  exemption_homestead: boolean;
  owner_mailing_address: string;
}

/** One kept value: the value, the source label (a county office or layer, never a person) and its as-of date. */
export interface HomeownerFact<F extends HomeownerField = HomeownerField> {
  value: HomeownerFieldValues[F];
  source: string;
  /** YYYY-MM-DD, or null when the source states none (the view then says "read on <check date>") */
  asOf: string | null;
}
export type HomeownerFacts = { [F in HomeownerField]?: HomeownerFact<F> };

export const RECOGNITION_REASONS = ['seller_intent', 'seller_inquiry', 'homeowner_tag', 'past_buyer'] as const;
export type RecognitionReason = (typeof RECOGNITION_REASONS)[number];

/** A county record as a source returns it. Owner names are for the in-memory attach decision only (never stored). */
export type HomeownerRecord = PropertyRecordCandidate & {
  providerRef: string | null;
  /** the record's own as-of date, when the source states one */
  recordAsOf: string | null;
  /** the record's source label */
  source: string | null;
  facts: HomeownerFacts;
};

export type HomeownerLookup =
  | { status: 'found'; record: HomeownerRecord }
  | { status: 'not_available'; detail: 'no_record' | 'ambiguous' };

export type { PostalAddress };

/** Mirrors predict/provider.ts SOURCE_RE and the migration's source CHECK. */
export const SOURCE_PATTERN = '^[A-Za-z0-9 .,:()_-]{1,80}$';
/** Mirrors predict/provider.ts REF_RE and the migration's parcel_ref CHECK. */
export const REF_PATTERN = '^[A-Za-z0-9._:-]{1,120}$';
export const SOURCE_RE = new RegExp(SOURCE_PATTERN);
export const REF_RE = new RegExp(REF_PATTERN);

export type ProfileStatus = 'matched' | 'not_matched' | 'not_available' | 'ambiguous' | 'failed';
export type MatchDetail = 'address_mismatch' | 'owner_name_mismatch' | 'missing_data';
export type FailureCode = 'unavailable' | 'timeout' | 'rejected' | 'address_invalid';
