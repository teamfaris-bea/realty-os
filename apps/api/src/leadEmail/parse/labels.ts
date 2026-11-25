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
  'your name': 'name',
  'your email': 'email',
  'your phone': 'phone',
  'your message': 'message',
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
  'buyer name': 'name', // VERIFY: Premier Agent contact emails
  'client name': 'name', // VERIFY
  'client email': 'email', // VERIFY
  'property address': 'property', // VERIFY
  comments: 'message', // VERIFY
  question: 'message', // VERIFY
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
  'prospect name': 'name', // VERIFY: Market VIP
  'prospect email': 'email', // VERIFY
  'prospect phone': 'phone', // VERIFY
  'property of interest': 'property', // VERIFY
  'property address': 'property', // VERIFY
  notes: 'message', // VERIFY
});

// VERIFY: Homes.com / Homesnap lead-parsing emails. No real sample; labels are a plausible guess.
export const HOMES_LABELS: LabelTable = table({
  name: 'name',
  'lead name': 'name',
  'full name': 'name',
  email: 'email',
  'lead email': 'email',
  'email address': 'email',
  phone: 'phone',
  'lead phone': 'phone',
  'phone number': 'phone',
  message: 'message',
  comments: 'message',
  property: 'property',
  address: 'property',
  'property address': 'property',
  'listing id': 'listingId',
  'mls #': 'listingId',
  'mls#': 'listingId',
  mls: 'listingId',
  'mls number': 'listingId',
  'lead type': 'leadType',
  'interested in': 'leadType',
});

// VERIFY: Opcity referral emails, including a Lofty/eXp relay whose body says "Source: Opcity".
export const OPCITY_LABELS: LabelTable = table({
  name: 'name',
  'client name': 'name',
  'contact name': 'name',
  'prospect name': 'name',
  email: 'email',
  'client email': 'email',
  'email address': 'email',
  phone: 'phone',
  'client phone': 'phone',
  'phone number': 'phone',
  message: 'message',
  notes: 'message',
  comments: 'message',
  property: 'property',
  address: 'property',
  'property address': 'property',
  'property of interest': 'property',
  'mls #': 'listingId',
  'mls number': 'listingId',
  'lead type': 'leadType',
  'interested in': 'leadType',
});

// VERIFY: Veterans United AgentDash new-referral emails (From agentupdates@vu.com). No real sample.
export const AGENTDASH_LABELS: LabelTable = table({
  name: 'name',
  'borrower name': 'name',
  'client name': 'name',
  'contact name': 'name',
  email: 'email',
  'borrower email': 'email',
  'client email': 'email',
  'email address': 'email',
  phone: 'phone',
  'borrower phone': 'phone',
  'client phone': 'phone',
  'phone number': 'phone',
  message: 'message',
  notes: 'message',
  comments: 'message',
  property: 'property',
  address: 'property',
  'property address': 'property',
  'lead type': 'leadType',
  'interested in': 'leadType',
});

export interface VendorFormat {
  format: Exclude<LeadFormat, 'generic' | 'leadmetadata' | 'fallback'>;
  /** the trusted sender's domain is one of these or a subdomain */
  senderDomains: readonly string[];
  /** the body carries this marker */
  marker: RegExp;
  labels: LabelTable;
}

export const VENDORS: readonly VendorFormat[] = [
  // VERIFY: AgentDash notifications are seen from agentupdates@vu.com
  { format: 'agentdash', senderDomains: ['vu.com'] /* VERIFY */, marker: /agentdash|veterans united/i /* VERIFY */, labels: AGENTDASH_LABELS },
  { format: 'opcity', senderDomains: ['opcity.com'] /* VERIFY */, marker: /opcity/i /* VERIFY */, labels: OPCITY_LABELS },
  // VERIFY: an eXp Lofty relay names the source in the body; the sender is not opcity.com
  { format: 'opcity', senderDomains: ['lofty.com', 'exprealty.com'] /* VERIFY */, marker: /source\s*:?\s*opcity/i /* VERIFY */, labels: OPCITY_LABELS },
  { format: 'homes', senderDomains: ['homes.com', 'homesnap.com'] /* VERIFY */, marker: /homes\.com|homesnap/i /* VERIFY */, labels: HOMES_LABELS },
  { format: 'zillow', senderDomains: ['zillow.com'] /* VERIFY */, marker: /zillow/i /* VERIFY */, labels: ZILLOW_LABELS },
  { format: 'realtor', senderDomains: ['realtor.com', 'move.com'] /* VERIFY */, marker: /realtor\.com|market vip/i /* VERIFY */, labels: REALTOR_LABELS },
];

/** What the timeline and the inquiry call this email's source. The inbox's lead source is unchanged. */
export const SOURCE_LABEL: Record<LeadFormat, string> = {
  zillow: 'Zillow',
  realtor: 'Realtor.com',
  opcity: 'Opcity',
  homes: 'Homes.com',
  agentdash: 'Veterans United',
  generic: 'Website',
  leadmetadata: 'Lead email',
  fallback: 'Unparsed email',
};

/** IDX website mail uses the generic labels; the timeline says IDX when the email says so. */
export function detectedSource(format: LeadFormat, subject: string, text: string): string {
  if (format === 'generic' && /\bidx\b/i.test(`${subject}\n${text}`.slice(0, 2000))) return 'IDX';
  return SOURCE_LABEL[format];
}

const REFERRAL_WORD = /\b(?:referral|market vip|opcity)\b/i;

function senderUnder(sender: string | null, base: string): boolean {
  const d = (sender ?? '').trim().toLowerCase().replace(/\.+$/, '');
  return d === base || d.endsWith(`.${base}`);
}

/**
 * Whether this trusted email is an Opcity or realtor.com referral that needs a logged update.
 * Decided from the sender plus the subject and body, not from which template matched: a generic or
 * fallback read of the same mail still arms the day-5 reminder. Their rule is 7 days; the reminder
 * fires at 5. A plain realtor.com contact email (no referral, Market VIP, or Opcity) is not one.
 * A Lofty or eXp relay counts only when the subject or body names Opcity.
 */
export function wantsReferralReminder(senderDomain: string | null, subject: string, text: string): boolean {
  const blob = `${subject}\n${text}`.slice(0, 8_000);
  if (senderUnder(senderDomain, 'opcity.com')) return true;
  if ((senderUnder(senderDomain, 'lofty.com') || senderUnder(senderDomain, 'exprealty.com')) && /\bopcity\b/i.test(blob)) return true;
  if ((senderUnder(senderDomain, 'realtor.com') || senderUnder(senderDomain, 'move.com')) && REFERRAL_WORD.test(blob)) return true;
  return false;
}

/**
 * Portal domains (and their subdomains): an address there is the portal's own (no-reply, lead routing,
 * footer), never a lead's contact point. VERIFY the list (other brands of the same groups may send too).
 */
export const PORTAL_DOMAINS: readonly string[] = [
  'zillow.com', 'realtor.com', 'move.com', // VERIFY
  'redfin.com', 'homes.com', 'homesnap.com', 'trulia.com', 'opcity.com', // VERIFY
  'vu.com', // VERIFY: Veterans United AgentDash
  'lofty.com', 'exprealty.com', // VERIFY: eXp Lofty relays Opcity; those addresses are the relay's, never the lead's
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
