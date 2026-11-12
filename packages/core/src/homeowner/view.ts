// The panel view (R-HOME-8; honest UI). homeownerView turns what the read route loaded under the viewer's RLS into
// the panel's states: per home the county and mode, the check state, one row per value (a value with its source and
// date, or why it is missing and where to look), years owned, whether tax mail goes elsewhere, the loans link and the
// D9 slots. There is no score, confidence, percentage, estimate or owner-name field anywhere in this shape (a snapshot
// test and the route's strict schema prove it). Dates are YYYY-MM-DD in the team's time zone (the caller converts).
import { normalizeAddress } from '../predict/index.js';
import { COUNTIES, countyOf, canonicalRegion, type CountyKey, type CountyLink } from './counties.js';
import { HOMEOWNER_FIELDS, type FailureCode, type HomeownerFact, type HomeownerFacts, type HomeownerField, type MatchDetail, type PostalAddress, type ProfileStatus, type RecognitionReason } from './types.js';
import { yearsOwned, type YearsOwned } from './years.js';

export interface ViewProfile {
  status: ProfileStatus;
  matchDetail: MatchDetail | null;
  source: string | null;
  checkedOn: string | null;
  lastFailureOn: string | null;
  lastFailureCode: FailureCode | null;
  nextCheckOn: string;
  facts: HomeownerFacts;
}

export interface ViewHome {
  address: PostalAddress;
  kind: 'home' | 'mailing' | 'property' | 'interest';
  profile: ViewProfile | null;
  /**
   * E582: the closing date (team's date) of the team's purchase deal for this home (K2) that the VIEWER can see, or
   * null / absent. Years owned counts from it only when the county record gives no transfer date.
   */
  teamClosingOn?: string | null;
}

export interface ViewInput {
  today: string;
  configured: boolean;
  /** the provider is the deterministic fake (b11 api-ui/F5): its status text is shown on every home */
  test: boolean;
  statusText: string;
  /** viewer-visible reasons, with a date only where the viewer may see it (a past buyer's closing) */
  reasons: { reason: RecognitionReason; since: string | null }[];
  homes: ViewHome[];
  /**
   * true when records the viewer can see were merged into this one (b11 ownership-data/F6): a merge moves no
   * addresses, inquiries or intent (0027), so the profile is built from this record's own and the panel says so
   */
  mergedRecords: boolean;
  /** the date counsel clearance of platform:public_records_outreach was recorded on this deployment, or null */
  outreachClearanceOn: string | null;
}

export type RowKey = HomeownerField | 'mls_sale_history' | 'in_house_value';
export type RowWhy = 'not_in_record' | 'not_kept' | 'not_checked' | 'links_only' | 'pending_d9';

export type ViewRow =
  | { key: RowKey; state: 'value'; value: string | number | boolean; source: string; asOf: string | null; readOn: string | null }
  | { key: RowKey; state: 'not_available' | 'not_kept'; why: RowWhy; link: CountyLink | null }
  | { key: RowKey; state: 'pending_d9'; why: 'pending_d9' };

export type CheckState =
  | { state: 'checked'; checkedOn: string; nextCheckOn: string }
  | { state: 'not_checked' }
  | { state: 'not_configured'; text: string }
  | { state: 'failed'; failedOn: string; lastReadOn: string | null }
  | { state: 'links_only' }
  | { state: 'outside_area' };

export type HomeOutcome = 'matched' | 'not_matched' | 'not_available' | 'ambiguous' | 'failed' | 'pending' | 'links_only' | 'outside_area';

export interface HomeView {
  address: string;
  county: { key: CountyKey; name: string; mode: 'connector' | 'links' | 'shared' } | null;
  check: CheckState;
  outcome: HomeOutcome;
  matchDetail: MatchDetail | null;
  rows: ViewRow[];
  yearsOwned: YearsOwned | null;
  /** true / false, or null when the mailing address cannot be compared; worded "tax mail goes elsewhere" */
  mailingDiffers: boolean | null;
  /** county pages to look the owner up in (Jasper; or a shared ZIP Beaufort had no record for) */
  lookupLinks: CountyLink[];
  /** where recorded loans are searched (no automated source) */
  loansLink: CountyLink | null;
  /** the county's tax rates (millage) page where the tax values are listed (Beaufort; b11 reconciliation homeowner-11) */
  taxRatesLink: CountyLink | null;
  /** the platform status text when public records are not set up, or on every home while a test source answers */
  providerNote: string | null;
}

export interface HomeownerView {
  recognized: boolean;
  reasons: { reason: RecognitionReason; since: string | null }[];
  homes: HomeView[];
  /** records were merged into this one; their addresses, inquiries and intent stay on them (R-HOME-1, R-HOME-9; E569) */
  mergedRecords: boolean;
  outreach: { built: false; clearanceOn: string | null };
}

export const D9_ROWS = ['mls_sale_history', 'in_house_value'] as const;

const oneLine = (a: PostalAddress) => [a.line1, a.line2, a.city, `${a.region} ${a.postalCode}`].filter((x) => x && String(x).trim() !== '').join(', ');

const MAILING_RE = /^(.+?),\s*(?:(.+?),\s*|(.+?)\s+)([A-Za-z]{2}|South Carolina)\s+(\d{5})(?:-\d{4})?$/i;
/** The owner's tax-mail address compared with the subject address: true / false, or null when it cannot be parsed. */
export function mailingDiffers(mailing: string, subject: PostalAddress): boolean | null {
  const m = MAILING_RE.exec(mailing.trim());
  if (!m) return null;
  const parsed = canonicalRegion({ line1: m[1]!, city: (m[2] ?? m[3])!, region: m[4]!, postalCode: m[5]! });
  const a = normalizeAddress(parsed);
  const b = normalizeAddress(canonicalRegion({ ...subject, line2: null }));
  if (a === null || b === null) return null;
  return a !== b;
}

export function homeownerView(input: ViewInput): HomeownerView {
  if (input.reasons.length === 0) return { recognized: false, reasons: [], homes: [], mergedRecords: input.mergedRecords, outreach: { built: false, clearanceOn: input.outreachClearanceOn } };
  return {
    recognized: true,
    reasons: input.reasons,
    homes: input.homes.map((h) => homeView(h, input)),
    mergedRecords: input.mergedRecords,
    outreach: { built: false, clearanceOn: input.outreachClearanceOn },
  };
}

function homeView(h: ViewHome, input: ViewInput): HomeView {
  const route = countyOf(h.address);
  // b11 api-ui/F5: a configured TEST source (the dev and staging-demo fake) says so on every home: no county was asked
  const providerNote = input.configured && !input.test ? null : input.statusText;
  const base = { address: oneLine(h.address), matchDetail: null, yearsOwned: null, mailingDiffers: null, providerNote };
  const d9: ViewRow[] = D9_ROWS.map((key) => ({ key, state: 'pending_d9', why: 'pending_d9' }));

  // E582: with no county transfer date, the team's closing the viewer sees (never when the county names someone else)
  const closingYears = yearsOwned(null, input.today, h.teamClosingOn ?? null);
  if (route === null) {
    return { ...base, yearsOwned: closingYears, county: null, check: { state: 'outside_area' }, outcome: 'outside_area', rows: [...absent('not_available', 'links_only', null), ...d9], lookupLinks: [], loansLink: null, taxRatesLink: null };
  }
  if (route.mode === 'links') {
    const c = COUNTIES[route.key];
    return { ...base, yearsOwned: closingYears, county: { key: c.key, name: c.name, mode: 'links' }, check: { state: 'links_only' }, outcome: 'links_only', rows: [...absent('not_available', 'links_only', c.records), ...d9], lookupLinks: [c.records], loansLink: c.deeds, taxRatesLink: c.taxRates };
  }
  const key = route.mode === 'shared' ? route.try : route.key;
  const c = COUNTIES[key];
  const county = { key: c.key, name: c.name, mode: route.mode };
  const also = route.mode === 'shared' ? COUNTIES[route.also] : null;
  const p = h.profile;
  if (p === null) {
    const check: CheckState = input.configured ? { state: 'not_checked' } : { state: 'not_configured', text: input.statusText };
    return { ...base, yearsOwned: closingYears, county, check, outcome: 'pending', rows: [...absent('not_available', 'not_checked', c.records), ...d9], lookupLinks: also ? [also.records] : [], loansLink: c.deeds, taxRatesLink: c.taxRates };
  }

  const failedLater = p.lastFailureOn !== null && (p.checkedOn === null || p.lastFailureOn >= p.checkedOn);
  const check: CheckState = failedLater
    ? { state: 'failed', failedOn: p.lastFailureOn!, lastReadOn: p.checkedOn }
    : p.checkedOn !== null
      ? { state: 'checked', checkedOn: p.checkedOn, nextCheckOn: p.nextCheckOn }
      : { state: 'not_checked' };
  const outcome: HomeOutcome = p.status === 'failed' ? 'failed' : p.status;
  let rows: ViewRow[];
  if (p.status === 'matched') {
    rows = HOMEOWNER_FIELDS.map((f) => factRow(f, p.facts[f], p.checkedOn, c.records));
  } else if (p.status === 'not_matched' || p.status === 'ambiguous') {
    rows = absent('not_kept', 'not_kept', c.records);
  } else if (p.status === 'not_available') {
    rows = absent('not_available', 'not_in_record', also ? also.records : c.records);
  } else {
    rows = absent('not_available', 'not_checked', c.records);
  }
  const mailing = p.status === 'matched' ? p.facts.owner_mailing_address : undefined;
  const transfer = p.status === 'matched' ? p.facts.last_transfer_date : undefined;
  return {
    ...base,
    county,
    check,
    outcome,
    matchDetail: p.matchDetail,
    rows: [...rows, ...d9],
    yearsOwned: p.status === 'not_matched' && p.matchDetail === 'owner_name_mismatch' ? null : yearsOwned(transfer, input.today, h.teamClosingOn ?? null),
    mailingDiffers: mailing ? mailingDiffers(mailing.value, h.address) : null,
    lookupLinks: also && (p.status === 'not_available' || p.status === 'failed') ? [also.records] : [],
    loansLink: c.deeds,
    taxRatesLink: c.taxRates,
  };
}

function factRow(f: HomeownerField, fact: HomeownerFact | undefined, checkedOn: string | null, link: CountyLink): ViewRow {
  if (!fact) return { key: f, state: 'not_available', why: 'not_in_record', link };
  return { key: f, state: 'value', value: fact.value, source: fact.source, asOf: fact.asOf, readOn: fact.asOf === null ? checkedOn : null };
}

function absent(state: 'not_available' | 'not_kept', why: RowWhy, link: CountyLink | null): ViewRow[] {
  return HOMEOWNER_FIELDS.map((key) => ({ key, state, why, link }));
}
