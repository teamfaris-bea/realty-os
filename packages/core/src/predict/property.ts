// Public-record attachment and property-fact derivation (R-PRED-2, E122). A property record carries
// property facts only (0018 property_records has no person-level column). Attaching one to a contact needs
// an exact normalized address match AND an owner-name match; anything less is not attached and goes to
// review. Features derive from property facts only: years in home, an equity band, a recent permit.
import { DAY_MS, type Instant } from '../foundation/index.js';
import type { EquityBand, FeatureEvidence, PredictionFeatures } from './types.js';

export type PostalAddress = { line1: string; line2?: string | null; city: string; region: string; postalCode: string };

/** The public-record candidate as the vendor returns it (property facts + the owner names on title). */
export type PropertyRecordCandidate = {
  address: PostalAddress;
  ownerNames: readonly string[];
};

export type AttachContact = {
  /** The contact address the record is fetched for. */
  address: PostalAddress;
  /** The contact's full name(s) as recorded (primary name and any recorded co-owner on the contact). */
  names: readonly string[];
};

export type AttachDecision =
  | { attach: true; ownerNameMatch: true }
  | { attach: false; reason: 'needs_review'; detail: 'address_mismatch' | 'owner_name_mismatch' | 'missing_data' };

const STREET_WORDS: Readonly<Record<string, string>> = {
  street: 'st', str: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl',
  terrace: 'ter', circle: 'cir', parkway: 'pkwy', highway: 'hwy', square: 'sq', trail: 'trl', way: 'way', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit', unit: 'unit', number: 'unit',
};

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function addressTokens(s: string): string[] {
  return fold(s)
    .replace(/#/g, ' unit ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => STREET_WORDS[w] ?? w);
}

/** Canonical address string, or null when a required part is missing. Street-type/directional/unit words are abbreviated. */
export function normalizeAddress(a: PostalAddress): string | null {
  const line1 = addressTokens(a.line1);
  const city = addressTokens(a.city);
  const region = addressTokens(a.region);
  const zip = (a.postalCode.match(/\d/g) ?? []).join('').slice(0, 5);
  if (line1.length === 0 || city.length === 0 || region.length === 0 || zip.length !== 5) return null;
  const line2 = addressTokens(a.line2 ?? '');
  // "unit 4" and "4" in line2 are the same unit
  const unit = line2.filter((w) => w !== 'unit');
  return [line1.join(' '), unit.length > 0 ? `unit ${unit.join(' ')}` : '', city.join(' '), region.join(' '), zip].join('|');
}

/** Name tokens, order-independent ("SMITH, JOHN" = "John Smith"); nothing is dropped (no initials or suffix guessing). */
export function normalizeOwnerName(n: string): string | null {
  const words = fold(n)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  return words.length === 0 ? null : [...words].sort().join(' ');
}

/** Pure attach decision: exact normalized address AND an owner-name match, else needs_review (E122). */
export function attachPropertyRecord(record: PropertyRecordCandidate, contact: AttachContact): AttachDecision {
  const ra = normalizeAddress(record.address);
  const ca = normalizeAddress(contact.address);
  if (ra === null || ca === null) return { attach: false, reason: 'needs_review', detail: 'missing_data' };
  if (ra !== ca) return { attach: false, reason: 'needs_review', detail: 'address_mismatch' };
  const owners = new Set(record.ownerNames.flatMap((n) => n.split('&')).map(normalizeOwnerName).filter((n): n is string => n !== null));
  const names = contact.names.map(normalizeOwnerName).filter((n): n is string => n !== null);
  if (owners.size === 0 || names.length === 0) return { attach: false, reason: 'needs_review', detail: 'missing_data' };
  if (!names.some((n) => owners.has(n))) return { attach: false, reason: 'needs_review', detail: 'owner_name_mismatch' };
  return { attach: true, ownerNameMatch: true };
}

/** The property facts of an attached property_records row (no person-level fields exist). */
export type PropertyFacts = {
  id: string;
  ownerNameMatch: boolean;
  lastSaleAt: Instant | null;
  lastSalePriceCents: number | null;
  assessedValueCents: number | null;
  recentPermit: boolean | null;
};

/**
 * VERIFY WITH COUNSEL (and with the data vendor): the equity band is a placeholder stand-in — assessed
 * value relative to the last sale price — until a counsel-reviewed model defines it.
 */
export const EQUITY_RATIO_BANDS = { mid: 1.15, high: 1.5 } as const;

/**
 * yearsInHome / equityBand / recentPermit from property facts only, with their evidence. A record without
 * an owner-name match yields nothing (R-PRED-2).
 */
export function derivePropertyFeatures(r: PropertyFacts, asOf: Instant): { features: PredictionFeatures; evidence: FeatureEvidence } {
  const features: PredictionFeatures = {};
  const evidence: FeatureEvidence = {};
  if (!r.ownerNameMatch) return { features, evidence };
  if (r.lastSaleAt !== null && Number.isSafeInteger(r.lastSaleAt) && r.lastSaleAt <= asOf) {
    const years = Math.floor((asOf - r.lastSaleAt) / (365.25 * DAY_MS));
    if (years >= 0 && years <= 150) {
      features.yearsInHome = years;
      evidence.years_in_home = { sourceType: 'property_record', sourceId: r.id, field: 'last_sale_date' };
    }
  }
  const sale = r.lastSalePriceCents;
  const assessed = r.assessedValueCents;
  if (sale !== null && assessed !== null && Number.isSafeInteger(sale) && Number.isSafeInteger(assessed) && sale > 0 && assessed >= 0) {
    const ratio = assessed / sale;
    const band: EquityBand = ratio >= EQUITY_RATIO_BANDS.high ? 'high' : ratio >= EQUITY_RATIO_BANDS.mid ? 'mid' : 'low';
    features.equityBand = band;
    evidence.equity_band = { sourceType: 'property_record', sourceId: r.id, field: 'assessed_value_cents' };
  }
  if (typeof r.recentPermit === 'boolean') {
    features.recentPermit = r.recentPermit;
    evidence.recent_permit = { sourceType: 'property_record', sourceId: r.id, field: 'recent_permit' };
  }
  return { features, evidence };
}
