// The client report of a CMA (module 71, D9 V2-A; R-CMA-9, R-CMA-4, R-AVM-1, R-MLS-2; E604, E605, E614, E615, E617,
// E619). Pure: the share (email) and the PDF build the same blocks from the stored CMA and the live client renderings.
//
// It carries exactly (rule 4): the range and the estimate sentence; the provider line; every statement, attribution and
// disclaimer of the connection set readiness checked, once per text; "MLS data as of …" from the stored date; each comp
// the engine used, as it renders for clients now (labelled "Sold": sold price and date, beds, baths and size as
// rendered, distance or "distance not known", tier words, brokerage, the adjusted price with its adjustment lines);
// the inspection line, the SoP items (purpose 'other' only) and the notes.
//
// It never carries a confidence, score or accuracy word, a point value (owner question d: the range only), weights,
// the back-test, market rates, adjustment sentences or rates, subject values, remarks, photos, list or asking prices,
// not-used sales, context listings, the subject's own sale history, or the street of a comp whose address is hidden
// for clients (the locality is shown instead). VERIFY WITH COUNSEL: every client sentence here.
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type DisplayListing, money, miles } from './deps.js';
import { type Prominence, canonicalText, emailStatementOk, printable, statementProminence } from './statement.js';

export type BlockRole = 'title' | 'range' | 'estimate' | 'provider' | 'statement' | 'comp' | 'as_of' | 'inspection' | 'sop' | 'notes' | 'attribution' | 'disclaimer';

export interface ReportBlock {
  role: BlockRole;
  text: string;
  prominence: Prominence;
}

/** One used comp: its live client rendering (gates.ts clientSale) and what the engine stored for it. */
export interface ReportComp {
  rendering: DisplayListing;
  distanceM: number | null;
  tier: string | null;
  adjustedPriceCents: number;
  adjustments: readonly { feature: string; amountCents: number }[];
}

export interface ReportStatement {
  text: string;
  minPointSize: number;
}

export interface ReportInput {
  /** the subject's street line and city (the contact's address or the entered anchor) */
  subjectAddress: string;
  lowCents: number;
  highCents: number;
  estimateSentence: string;
  agentName: string;
  brokerageName: string;
  /** the connection set's statements for the subject's state, attributions and disclaimers (deduplicated here) */
  statements: readonly ReportStatement[];
  attributions: readonly string[];
  disclaimers: readonly string[];
  /** "MLS data as of …" of the stored date */
  asOfSentence: string;
  comps: readonly ReportComp[];
  purpose: 'listing_price' | 'buyer_offer' | 'other';
  inspection: 'none' | 'exterior' | 'interior_and_exterior';
  inspectedOn: string | null;
  disclosure: { intendedUsers: string | null; agentInterest: string | null; conflicts: string | null; valueDefinition: string | null; limitingConditions: string | null };
  notes: string | null;
}

export type StatementPart = 'statement' | 'attribution' | 'disclaimer';
export interface Refusal {
  part: StatementPart;
  reason: 'SUBSTITUTED' | 'NO_PROMINENCE' | 'EMAIL_TYPE_SIZE';
  codePoints?: string[];
}
export type ReportWarning = { code: 'WONT_PRINT'; role: BlockRole; codePoints: string[] } | { code: 'CHECK_WORDING'; role: 'notes' | 'sop' };

export interface Report {
  subject: string;
  blocks: ReportBlock[];
  warnings: ReportWarning[];
  /** the statement minimums, for the email and PDF refusals */
  statementMins: number[];
  /** the statement, attribution and disclaimer texts that would be substituted (rule 5), first per part */
  substituted: Refusal[];
}

/** The email body's cap: room for the signature, footer and unsubscribe line under messages' 20,000 (0001; VERIFY 4). */
export const REPORT_MAX_EMAIL_CHARS = 16_000;

/** Owner question (j): wording that reads as an appraisal or a promise gets a "Check this" (never a block). */
export const CHECK_WORDING = /apprais|guarant|promis/i;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "Mar 3, 2026" of YYYY-MM-DD (no zone: a calendar date). */
export function dayText(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/** The engine's tier names in client words (core/valuation's own words are not exported; restated, tested). */
const TIER_WORDS: Readonly<Record<string, string>> = {
  subdivision: 'same subdivision',
  within_1mi: 'within 1 mile',
  postal_code: 'same ZIP code',
  within_3mi: 'within 3 miles',
  city: 'same city',
};

/** The adjustment features in client words (core/valuation featureName, restated, tested). */
export const FEATURE_WORDS: Readonly<Record<string, string>> = {
  time: 'Market change',
  size: 'Size',
  beds: 'Bedrooms',
  baths: 'Bathrooms',
  garage: 'Garage spaces',
  pool: 'Private pool',
  year_built: 'Year built',
  lot: 'Lot size',
  stories: 'Stories',
  concessions: 'Seller concessions',
};

const signed = (cents: number) => {
  const m = money(cents);
  return m === '$0' || m.startsWith('-') ? m : `+${m}`;
};
const tenths = (x10: number) => (x10 % 10 === 0 ? String(x10 / 10) : `${Math.floor(x10 / 10)}.${x10 % 10}`);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** One comp, client fields only: never its list price, remarks, photos or a status other than sold. */
function compText(c: ReportComp): string {
  const r = c.rendering;
  const where = r.address !== undefined && !r.addressHidden ? [r.address.line1, r.address.line2].filter(Boolean).join(' ') + (r.locality ? `, ${r.locality.city}` : '') : r.locality ? `${r.locality.city}, ${r.locality.region} ${r.locality.postalCode}` : 'Address not shown';
  const lines = [`Sold: ${where}`];
  if (r.closePriceCents != null && r.closeDate != null) lines.push(`Sold for ${money(r.closePriceCents)} on ${dayText(r.closeDate)}`);
  const facts = [r.beds != null ? `${r.beds} ${r.beds === 1 ? 'bed' : 'beds'}` : null, r.bathsX10 != null ? `${tenths(r.bathsX10)} ${r.bathsX10 === 10 ? 'bath' : 'baths'}` : null, r.sqft != null ? `${r.sqft.toLocaleString('en-US')} sq ft` : null].filter((x) => x !== null);
  if (facts.length > 0) lines.push(facts.join(', '));
  const place = [c.distanceM === null ? 'distance not known' : miles(c.distanceM), c.tier !== null ? TIER_WORDS[c.tier] : undefined, r.listingBrokerageName ? `listed by ${r.listingBrokerageName}` : undefined].filter((x) => x !== undefined);
  lines.push(place.join('; '));
  lines.push(`Adjusted price: ${money(c.adjustedPriceCents)}`);
  for (const a of c.adjustments) lines.push(`  ${FEATURE_WORDS[a.feature] ?? a.feature}: ${signed(a.amountCents)}`);
  return lines.join('\n');
}

function inspectionLine(i: ReportInput): string {
  if (i.inspection === 'none') return 'The home was not inspected for this estimate.';
  const on = i.inspectedOn === null ? '' : ` on ${dayText(i.inspectedOn)}`;
  return i.inspection === 'exterior' ? `Exterior inspection${on}.` : `Interior and exterior inspection${on}.`;
}

/** The SoP 11-1 labels in client words (purpose 'other' only). VERIFY WITH COUNSEL. */
export const SOP_LABELS = {
  intendedUsers: 'Intended users',
  agentInterest: 'Agent’s interest',
  conflicts: 'Conflicts of interest',
  valueDefinition: 'Value estimated',
  limitingConditions: 'Limiting conditions',
} as const;

const uniq = (xs: readonly string[]) => [...new Set(xs.map((x) => canonicalText(x).trim()).filter((x) => x !== ''))];

/** The report's blocks in their fixed order (rule 4). */
export function buildReport(i: ReportInput): Report {
  const blocks: ReportBlock[] = [];
  const push = (role: BlockRole, text: string, prominence: Prominence = 'body') => blocks.push({ role, text, prominence });
  push('title', oneLine(i.subjectAddress), 'heading');
  push('range', `Estimated value range: ${money(i.lowCents)} to ${money(i.highCents)}`, 'heading');
  push('estimate', i.estimateSentence);
  push('provider', `Prepared by ${oneLine(i.agentName)}, ${oneLine(i.brokerageName)}, from MLS sales`);
  // one statement per text (the strictest minimum of those that share it)
  const statements = new Map<string, number>();
  for (const s of i.statements) {
    const t = canonicalText(s.text).trim();
    if (t === '') continue;
    statements.set(t, Math.max(statements.get(t) ?? -Infinity, s.minPointSize));
  }
  for (const [text, min] of statements) push('statement', text, statementProminence(min) ?? 'display');
  for (const c of i.comps) push('comp', compText(c));
  push('as_of', i.asOfSentence);
  push('inspection', inspectionLine(i));
  if (i.purpose === 'other') {
    for (const k of Object.keys(SOP_LABELS) as (keyof typeof SOP_LABELS)[]) {
      const v = i.disclosure[k];
      if (v !== null && v.trim() !== '') push('sop', `${SOP_LABELS[k]}: ${v.trim()}`);
    }
  }
  if (i.notes !== null && i.notes.trim() !== '') push('notes', `Notes: ${i.notes.trim()}`);
  for (const a of uniq(i.attributions)) push('attribution', a);
  for (const d of uniq(i.disclaimers)) push('disclaimer', d);

  const substituted: Refusal[] = [];
  const warnings: ReportWarning[] = [];
  for (const b of blocks) {
    const p = printable(b.text);
    if (b.role === 'statement' || b.role === 'attribution' || b.role === 'disclaimer') {
      if (!p.ok && !substituted.some((x) => x.part === b.role)) substituted.push({ part: b.role, reason: 'SUBSTITUTED', codePoints: p.codePoints });
    } else if (!p.ok) warnings.push({ code: 'WONT_PRINT', role: b.role, codePoints: p.codePoints });
  }
  if (i.notes !== null && CHECK_WORDING.test(i.notes)) warnings.push({ code: 'CHECK_WORDING', role: 'notes' });
  if (i.purpose === 'other' && Object.values(i.disclosure).some((v) => v !== null && CHECK_WORDING.test(v))) warnings.push({ code: 'CHECK_WORDING', role: 'sop' });
  const subject = oneLine(`Home value estimate for ${oneLine(i.subjectAddress)}`).slice(0, 300);
  return { subject, blocks, warnings, statementMins: [...statements.values()], substituted };
}

/** The refusal of a report for the email or the PDF (rule 5), or null. Statements first, then attribution, disclaimer. */
export function refusalFor(r: Report, target: 'email' | 'pdf'): Refusal | null {
  const sub = r.substituted.find((x) => x.part === 'statement') ?? r.substituted[0];
  if (sub && sub.part === 'statement') return sub;
  if (target === 'email' && r.statementMins.some((m) => !emailStatementOk(m))) return { part: 'statement', reason: 'EMAIL_TYPE_SIZE' };
  if (target === 'pdf' && r.statementMins.some((m) => statementProminence(m) === null)) return { part: 'statement', reason: 'NO_PROMINENCE' };
  return sub ?? null;
}

/** The plain-text email body of the report (before comms adds the signature, footer and any unsubscribe line). */
export function emailText(blocks: readonly ReportBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/** The roles whose text is longest, for CMA_REPORT_TOO_LONG (counts only, never the text). */
export function longestParts(blocks: readonly ReportBlock[]): { role: BlockRole; chars: number }[] {
  const by = new Map<BlockRole, number>();
  for (const b of blocks) by.set(b.role, (by.get(b.role) ?? 0) + b.text.length);
  return [...by].map(([role, chars]) => ({ role, chars })).sort((a, b) => b.chars - a.chars || a.role.localeCompare(b.role));
}

/** The renderer's fields: `NNN:role:prominence` (padded to 3 digits: pdf.ts sorts the keys as strings). */
export function pdfFields(blocks: readonly ReportBlock[]): Record<string, string> {
  return Object.fromEntries(blocks.map((b, n) => [`${String(n).padStart(3, '0')}:${b.role}:${b.prominence}`, b.text]));
}

/** What the preview showed and the share must equal (E602b REPORT_CHANGED). */
export function reportSha256(r: Pick<Report, 'subject' | 'blocks'>): string {
  return sha256Hex(canonicalJson({ subject: r.subject, blocks: r.blocks.map((b) => ({ role: b.role, text: b.text, prominence: b.prominence })) }));
}

// ---- the share's email, in words (the CMA view; R-CMA-9, E603, E612) --------------------------------------------

/** Why the sweep canceled a share's email (status_reason 'CMA_' + the first blocker), in words without an address. */
export const CANCEL_WORDS: Readonly<Record<string, string>> = {
  PLATFORM_NOT_CLEARED: 'counsel review of the client CMA wording is not recorded',
  FEED_DISCONNECTED: 'an MLS feed this CMA was built from is no longer connected',
  VALUATION_USE_WITHDRAWN: 'your MLS licence pack no longer allows valuation use',
  MLS_CLIENT_DISPLAY_OFF: 'your MLS licence pack does not allow showing MLS data to clients',
  FEED_STALE: 'the MLS feed went out of date',
  CLIENT_USE_NOT_ALLOWED: 'your MLS licence pack no longer allows CMAs for clients',
  VALUATION_NOT_REVIEWED: 'the valuation part of your MLS licence pack is not reviewed by counsel',
  NO_VALUATION_STATEMENT: 'no valuation statement is recorded for the home’s state',
  COMPS_HIDDEN: 'a sale in it can no longer be shown to clients',
  SUBJECT_ADDRESS_UNKNOWN: 'the home’s full address is not known',
  SELLER_WITHHELD: 'the seller’s MLS listing of this home asks that automated valuations not be shown',
  POSSIBLE_LIVE_LISTING: 'a live MLS listing may be this home',
  NO_VALUE: 'there is no value',
};

export const HELD_SENTENCE = 'They replied since; open the thread to send it.';

/** One sentence for the share's email as it stands (the view; VERIFY WITH COUNSEL: the canceled and blocked words). */
export function shareMessageSentence(m: { status: string; status_reason: string | null; explanation: string | null }): string {
  switch (m.status) {
    case 'queued':
    case 'scheduled':
      return m.status_reason === 'CLIENT_REPLIED_SINCE_SCHEDULED' ? HELD_SENTENCE : 'Sending.';
    case 'dispatching':
    case 'dispatch_unknown':
      return 'Sending.';
    case 'sent':
    case 'delivered':
      return 'Sent.';
    case 'blocked':
      return `The email was not sent: ${m.explanation ?? 'the send-time check blocked it.'}`;
    case 'canceled': {
      const code = m.status_reason?.startsWith('CMA_') ? m.status_reason.slice(4) : null;
      const why = code === null ? undefined : CANCEL_WORDS[code];
      return why === undefined ? 'The email was canceled before sending.' : `The email was canceled before sending: ${why}. Prepare a new CMA to share again.`;
    }
    default:
      return 'The email could not be delivered.';
  }
}
