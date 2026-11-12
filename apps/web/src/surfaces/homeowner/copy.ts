// Every sentence of the homeowner panel (module 79; honest UI). Each value names its source and date; each gap says
// why and where to look; nothing is estimated. Owner decision D10: internal to agents, never shown to the client, and
// not for outreach.
import type { CheckState, HomeView, ViewRow } from './api.js';

export const HEADER = 'Homeowner profile';
export const INTERNAL = 'Internal: agents only, never shown to the client';
export const FOOTER = 'Loan balance and equity are not estimated';
export const LOANS = 'No automated source for recorded loans: search the Register of Deeds';
export const JASPER = 'Jasper County records are not read automatically. Look up the owner here:';
export const NOT_CHECKED = 'Not checked yet: county checks run overnight';
export const AMBIGUOUS = 'More than one county record matches this address; nothing was kept.';
export const ADDRESS_MISMATCH = 'The county record found has a different address; nothing was kept.';
export const NOT_AVAILABLE = 'The county has no record for this address.';
export const OUTSIDE = 'County records for this area are not read automatically.';
export const TAX_MAIL_ELSEWHERE = 'Tax mail goes elsewhere';
export const TAX_MAIL_HERE = 'Tax mail comes to this address';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 12, 2026" from YYYY-MM-DD (no time zone shift: the API already gives the team's date). */
export function day(d: string): string {
  const [y, m, dd] = d.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(dd)}, ${y}`;
}

export const REASON_WORDS: Record<string, string> = {
  seller_intent: 'marked as a seller',
  seller_inquiry: 'asked about selling or a home value',
  homeowner_tag: 'tagged as a homeowner',
  past_buyer: 'bought a home with the team',
};

/** The reasons sentence: a past buyer's closing date and the latest seller inquiry's date where the API gives one. */
export function reasonsText(reasons: { reason: string; since: string | null }[]): string {
  const parts = reasons.map((r) => {
    const words = REASON_WORDS[r.reason] ?? r.reason;
    if (r.reason === 'past_buyer' && r.since) return `${words} (closed ${day(r.since)})`;
    if (r.reason === 'seller_inquiry' && r.since) return `${words} (last on ${day(r.since)})`;
    return words;
  });
  return `Shown because this person is ${parts.join(', ')}.`;
}

export const FIELD_LABELS: Record<string, string> = {
  last_transfer_date: 'Last transfer',
  last_transfer_price_cents: 'Last transfer price',
  county_market_value_cents: 'County market value',
  assessed_value_cents: 'Assessed value',
  annual_tax_cents: 'Annual tax',
  tax_year: 'Tax year',
  exemption_legal_residence: 'Legal residence exemption',
  exemption_homestead: 'Homestead exemption',
  owner_mailing_address: 'Owner mailing address (tax bills)',
  mls_sale_history: 'MLS sale history',
  in_house_value: 'In-house value',
};

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function valueText(row: Extract<ViewRow, { state: 'value' }>): string {
  if (typeof row.value === 'boolean') return row.value ? 'Yes' : 'No';
  if (row.key.endsWith('_cents') && typeof row.value === 'number') return dollars(row.value);
  if (row.key === 'last_transfer_date' && typeof row.value === 'string') return day(row.value);
  return String(row.value);
}

/** "Source: … · as of …" or "Source: … · read on …". */
export function sourceLine(row: Extract<ViewRow, { state: 'value' }>): string {
  if (row.asOf) return `Source: ${row.source} · as of ${day(row.asOf)}`;
  if (row.readOn) return `Source: ${row.source} · read on ${day(row.readOn)}`;
  return `Source: ${row.source}`;
}

export function whyText(row: Exclude<ViewRow, { state: 'value' }>): string {
  if (row.state === 'pending_d9') return row.key === 'mls_sale_history' ? "Shown here once the team's MLS sale data is built" : 'Shown here once the in-house valuation is built';
  switch (row.why) {
    case 'not_in_record':
      return 'Not available: the county record read does not include it';
    case 'not_kept':
      return 'Not available: nothing from that record is kept';
    case 'not_checked':
      return 'Not available: not checked yet';
    case 'links_only':
      return 'Not available: not read automatically for this county';
    default:
      return 'Not available';
  }
}

export function checkText(c: CheckState): string | null {
  switch (c.state) {
    case 'checked':
      return `Checked ${day(c.checkedOn)} · next check due ${day(c.nextCheckOn)}`;
    case 'not_checked':
      return NOT_CHECKED;
    case 'not_configured':
      return c.text;
    case 'failed':
      return c.lastReadOn ? `Couldn't reach the county records on ${day(c.failedOn)}; showing what was read on ${day(c.lastReadOn)}` : `Couldn't reach the county records on ${day(c.failedOn)}; nothing has been read yet`;
    default:
      return null;
  }
}

/** The outcome sentence of a home that keeps nothing (null when the rows speak for themselves). */
export function outcomeText(home: HomeView, firstName: string | null): string | null {
  const on = home.check.state === 'checked' ? ` (checked ${day(home.check.checkedOn)})` : '';
  if (home.outcome === 'not_matched') {
    if (home.matchDetail === 'owner_name_mismatch') return `The county record for this address does not name ${firstName ?? 'this person'} as the owner${on}. Nothing else from that record is kept.`;
    if (home.matchDetail === 'missing_data') return `The county record does not name a person as owner${on}. Nothing was kept.`;
    return ADDRESS_MISMATCH;
  }
  if (home.outcome === 'ambiguous') return AMBIGUOUS;
  if (home.outcome === 'not_available') return NOT_AVAILABLE;
  if (home.outcome === 'outside_area') return OUTSIDE;
  return null;
}

/** R-HOME-4: years owned names what it counts from: the county's transfer, or the team's closing (E582). */
export function yearsText(y: NonNullable<HomeView['yearsOwned']>): string {
  const from = y.basis === 'team_closing' ? `the team's closing on ${day(y.since)}` : `the transfer on ${day(y.since)}`;
  return `Owned ${y.years} ${y.years === 1 ? 'year' : 'years'}: since ${from} (source: ${y.source})`;
}

export function outreachText(clearanceOn: string | null): string {
  return `Not for outreach: these records never address or trigger messages. Outreach use: not built; counsel clearance ${clearanceOn ? `recorded on ${day(clearanceOn)}` : 'not recorded'} for this deployment.`;
}
