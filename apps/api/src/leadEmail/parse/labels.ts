// Vendor formats of lead notification emails. WE HAVE NO REAL VENDOR SAMPLES: every vendor label,
// marker and domain below is a plausible guess, marked VERIFY, to be checked against real emails before
// launch. A wrong guess only means fields stay empty and the email goes to review (E78), never a wrong lead.
import type { LeadFormat, LeadType } from './types.js';

export type FieldKey = 'name' | 'email' | 'phone' | 'message' | 'property' | 'listingId' | 'leadType';
export type LabelTable = ReadonlyMap<string, FieldKey>;

/** Labels are matched lowercased, whitespace-collapsed, without the trailing ':'. */
const table = (entries: Record<string, FieldKey>): LabelTable => new Map(Object.entries(entries));

/** Our own generic labelled format (website forms, forwarding rules): not a vendor guess. */
export const GENERIC_LABELS: LabelTable = table({
  name: 'name',
  'full name': 'name',
  email: 'email',
  'e-mail': 'email',
  'email address': 'email',
  phone: 'phone',
  'phone number': 'phone',
  telephone: 'phone',
  tel: 'phone',
  mobile: 'phone',
  cell: 'phone',
  message: 'message',
  comments: 'message',
  comment: 'message',
  property: 'property',
  listing: 'property',
  address: 'property',
  'property address': 'property',
  'listing id': 'listingId',
  'mls #': 'listingId',
  'mls#': 'listingId',
  mls: 'listingId',
  'mls number': 'listingId',
  type: 'leadType',
  'lead type': 'leadType',
  'interested in': 'leadType',
});

// VERIFY: every Zillow label (names, variants, which one carries the lead's name).
export const ZILLOW_LABELS: LabelTable = table({
  name: 'name', // VERIFY
  contact: 'name', // VERIFY
  'contact name': 'name', // VERIFY
  email: 'email', // VERIFY
  'email address': 'email', // VERIFY
  phone: 'phone', // VERIFY
  'phone number': 'phone', // VERIFY
  message: 'message', // VERIFY
  property: 'property', // VERIFY
  listing: 'property', // VERIFY
  address: 'property', // VERIFY
  'listing id': 'listingId', // VERIFY
  'mls #': 'listingId', // VERIFY
  'mls#': 'listingId', // VERIFY
  zpid: 'listingId', // VERIFY
  'lead type': 'leadType', // VERIFY
  'interested in': 'leadType', // VERIFY
});

// VERIFY: every Realtor.com label.
export const REALTOR_LABELS: LabelTable = table({
  name: 'name', // VERIFY
  contact: 'name', // VERIFY
  'contact name': 'name', // VERIFY
  email: 'email', // VERIFY
  'email address': 'email', // VERIFY
  phone: 'phone', // VERIFY
  'phone number': 'phone', // VERIFY
  message: 'message', // VERIFY
  comments: 'message', // VERIFY
  property: 'property', // VERIFY
  listing: 'property', // VERIFY
  address: 'property', // VERIFY
  'listing id': 'listingId', // VERIFY
  'mls #': 'listingId', // VERIFY
  'mls#': 'listingId', // VERIFY
  'mls id': 'listingId', // VERIFY
  'lead type': 'leadType', // VERIFY
  'interested in': 'leadType', // VERIFY
});

export interface VendorFormat {
  format: Exclude<LeadFormat, 'generic' | 'leadmetadata'>;
  /** the trusted sender's domain is one of these or a subdomain */
  senderDomains: readonly string[];
  /** the body carries this marker */
  marker: RegExp;
  labels: LabelTable;
}

export const VENDORS: readonly VendorFormat[] = [
  { format: 'zillow', senderDomains: ['zillow.com'] /* VERIFY */, marker: /zillow/i /* VERIFY */, labels: ZILLOW_LABELS },
  { format: 'realtor', senderDomains: ['realtor.com', 'move.com'] /* VERIFY */, marker: /realtor\.com/i /* VERIFY */, labels: REALTOR_LABELS },
];

/**
 * Portal domains (and their subdomains): an address there is the portal's own (no-reply, lead routing,
 * footer), never a lead's contact point. VERIFY the list (other brands of the same groups may send too).
 */
export const PORTAL_DOMAINS: readonly string[] = [
  'zillow.com', 'realtor.com', 'move.com', // VERIFY
  // the catalog portals without a vendor parser (trust.ts PORTAL_CATALOG): VERIFY each
  'redfin.com', 'homes.com', 'homesnap.com', 'trulia.com', 'opcity.com',
];

/**
 * Vendor subjects that name the property, e.g. "New lead for 123 Main St" (VERIFY). Used only when no
 * property label was found, and only when that text also appears in the body (a field always cites a
 * span of the body).
 */
export const SUBJECT_PROPERTY_RE = /^(?:New )?(?:lead|inquiry|message).*?(?:\bfor|\babout)\s+(.+)$/i; // VERIFY

/** Body/subject keywords of vendor emails, by lead type (VERIFY: vendor wording). Earliest match wins. */
export const VENDOR_TYPE_KEYWORDS: ReadonlyArray<readonly [Exclude<LeadType, 'general'>, RegExp]> = [
  ['value', /\b(?:home value|zestimate)\b/i], // VERIFY
  ['sell', /\b(?:sellers?|sell my home|selling my home)\b/i], // VERIFY
  ['rent', /\b(?:rent|rentals?|renters?|renting)\b/i], // VERIFY
  ['buy', /\b(?:buyers?|interested in buying|tours?)\b/i], // VERIFY
];

/** Values of an explicit type label ("Type: Buying", "Interested in: renting"). Earliest match wins. */
export const LABEL_TYPE_KEYWORDS: ReadonlyArray<readonly [Exclude<LeadType, 'general'>, RegExp]> = [
  ['value', /\b(?:value|valuation|home value|zestimate|appraisal|cma|worth)\b/i],
  ['sell', /\b(?:sell|sellers?|selling)\b/i],
  ['rent', /\b(?:rent|rentals?|renters?|renting|lease|leasing)\b/i],
  ['buy', /\b(?:buy|buyers?|buying|purchase|purchasing|tours?|showing)\b/i],
];
