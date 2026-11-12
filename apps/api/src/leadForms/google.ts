// Google Ads lead form webhook payloads (module 22 scope 7; DATA_MODEL R-GADS-2, R-GADS-3). Pure: no I/O.
//
// Google posts one JSON object per lead to the webhook URL the advertiser pasted into the lead form asset, with the
// "key" they pasted in the body (google_key). The fields, as documented in "Use a webhook to receive leads from lead
// form assets" (support.google.com/google-ads/answer/9423234) and its developer page
// (developers.google.com/google-ads/webhook/docs/implementation):
//
//   lead_id           string   the lead's id (Google's test leads carry a fixed "TeSter-…" id)
//   api_version       string   "1.0"
//   form_id           int64    the lead form asset
//   campaign_id       int64
//   adgroup_id        int64
//   creative_id       int64
//   gcl_id            string   the click id
//   google_key        string   the key the advertiser entered (our routing secret; read only by leadForms/auth.ts)
//   is_test           boolean  true for "Send test data"
//   user_column_data  array of { column_id: "FULL_NAME" | "EMAIL" | …, string_value: string, column_name: string }
//                     column_name is deprecated (localized label) and never read; custom questions carry their own ids
//   lead_submit_time  string   VERIFY: seen only on one localized copy of the page (format there: "2024-01-31 12:34:56"
//                              with an optional offset); used only when Date.parse accepts it, intake clamps it anyway
//   lead_source       string   VERIFY: "LEAD_FORM" | "CONVERSATIONAL_AGENT" (lead form vs. a conversational asset);
//                              kept as source detail only, never trusted for anything
// VERIFY (all of the above was written from memory and must be checked against the live page before launch): field
// names, that the ids arrive as JSON numbers (int64: above 2^53 JSON.parse would round them, so an unsafe number is
// DROPPED, never rounded; a digit string is kept as is), and the column ids below.
//
// Parsing is lenient: unknown fields are ignored, strings are capped, at most 100 columns are read, only a string
// string_value is read. Nothing here can throw on any JSON value.
//
// Convention for module 52 (ads reporting): ad_campaigns.campaign_ref and lead_inquiries.campaign_ref use
// `gads:<campaign_id>`; lead_inquiries.ad_ref uses `gads:<creative_id>` (else `gads:<adgroup_id>`). A Google Ads
// account's campaigns join their leads on that string.
import { normalizeEmail, normalizePhone } from '@realty/core/foundation';

export const MAX_COLUMNS = 100;
/** cap for any string value read from the body (the intake limits below are lower still) */
const MAX_STRING = 4000;
const MAX_ID = 200;

/** IntakeBody's limits (leads/schemas.ts), so IntakeBody.parse cannot fail on what toInquiry builds. */
export const INTAKE_LIMITS = { name: 120, phoneMin: 3, phoneMax: 40, emailMin: 3, emailMax: 254, list: 5, propertyText: 500, ref: 200, externalId: 200, detailValue: 200 } as const;

export type InquiryType = 'buy' | 'sell' | 'rent' | 'value' | 'general';

export interface GoogleColumn {
  id: string;
  value: string;
}

export interface GoogleLead {
  /** null: absent, not a string, or not a plausible id */
  leadId: string | null;
  apiVersion: string | null;
  formId: string | null;
  campaignId: string | null;
  adgroupId: string | null;
  creativeId: string | null;
  gclId: string | null;
  isTest: boolean;
  columns: GoogleColumn[];
  submitTime: Date | null;
  leadSource: string | null;
}

// C0/C1 controls (tab/newline become spaces first), bidi embeddings/overrides/isolates and marks, zero-width chars,
// BOM, line/paragraph separators
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A value cleaned of controls and bidi characters, whitespace collapsed and trimmed. */
export function cleanText(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
}

/** At most `max` UTF-16 units, never cutting a surrogate pair in half. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function str(v: unknown, max = MAX_STRING): string | null {
  if (typeof v !== 'string') return null;
  const c = capText(cleanText(capText(v, max * 2)), max);
  return c === '' ? null : c;
}

/** An int64 id: a digit string as is; a JSON number only when it is a safe integer (never rounded). */
export function idOf(v: unknown): string | null {
  if (typeof v === 'string') return /^[0-9]{1,20}$/.test(v) ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return null;
}

const LEAD_ID_RE = /^[\x21-\x7e]{1,150}$/;

export function parseGoogleLead(body: unknown): GoogleLead {
  const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const rawLeadId = own(b, 'lead_id');
  const leadId = typeof rawLeadId === 'string' && LEAD_ID_RE.test(rawLeadId) ? rawLeadId : typeof rawLeadId === 'number' ? idOf(rawLeadId) : null;
  const columns: GoogleColumn[] = [];
  const data = own(b, 'user_column_data');
  if (Array.isArray(data)) {
    for (const entry of data.slice(0, MAX_COLUMNS)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const id = own(e, 'column_id');
      const value = own(e, 'string_value');
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(id) || typeof value !== 'string') continue;
      const v = str(value);
      if (v !== null) columns.push({ id: id.toUpperCase(), value: v });
    }
  }
  const t = own(b, 'lead_submit_time');
  let submitTime: Date | null = null;
  if (typeof t === 'string' && t.length <= 64) {
    const ms = Date.parse(t.includes('T') ? t : t.replace(' ', 'T'));
    if (Number.isFinite(ms)) submitTime = new Date(ms);
  }
  const isTest = own(b, 'is_test');
  return {
    leadId,
    apiVersion: str(own(b, 'api_version'), 20),
    formId: idOf(own(b, 'form_id')),
    campaignId: idOf(own(b, 'campaign_id')),
    adgroupId: idOf(own(b, 'adgroup_id')),
    creativeId: idOf(own(b, 'creative_id')),
    gclId: str(own(b, 'gcl_id'), MAX_ID),
    isTest: isTest === true || isTest === 'true',
    columns,
    submitTime,
    leadSource: str(own(b, 'lead_source'), 40),
  };
}

/** The hook settings an inquiry is built with. */
export interface HookSettings {
  leadSourceId: string;
  inquiryType: InquiryType;
}

/** What intake receives (IntakeBody's shape plus the source). */
export interface GoogleInquiry {
  leadSourceId: string;
  externalId: string;
  inquiryType: InquiryType;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  postalCode?: string;
  propertyText?: string;
  campaignRef?: string;
  adRef?: string;
  receivedAt?: string;
  sourceDetail: Record<string, string | number>;
}

const NAME_COLUMNS = new Set(['FULL_NAME', 'FIRST_NAME', 'LAST_NAME']);
const EMAIL_COLUMNS = new Set(['EMAIL', 'WORK_EMAIL']);
const PHONE_COLUMNS = new Set(['PHONE_NUMBER', 'WORK_PHONE']);

const name = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const n = capText(v, INTAKE_LIMITS.name).trim();
  return n === '' ? undefined : n;
};

/**
 * The inquiry for intake. Column mapping (R-GADS-2): names FULL_NAME, else FIRST_NAME / LAST_NAME; emails EMAIL,
 * WORK_EMAIL; phones PHONE_NUMBER, WORK_PHONE; postalCode POSTAL_CODE (US 5-digit or ZIP+4 only); propertyText
 * STREET_ADDRESS only for a sell or value form; everything else (COMPANY_NAME, JOB_TITLE, CITY, custom questions, …)
 * is not read and only counted (sourceDetail.unread_columns). Every value fits IntakeBody's limits.
 * Requires a lead id (the caller checks `leadId` first).
 */
export function toInquiry(lead: GoogleLead, hook: HookSettings): GoogleInquiry {
  const first = (id: string) => lead.columns.find((c) => c.id === id)?.value;
  let unread = 0;
  const phones: string[] = [];
  const emails: string[] = [];
  let postalCode: string | undefined;
  let propertyText: string | undefined;
  for (const c of lead.columns) {
    if (NAME_COLUMNS.has(c.id)) continue;
    if (EMAIL_COLUMNS.has(c.id)) {
      const v = c.value.replace(/\s/g, '');
      if (v.length >= INTAKE_LIMITS.emailMin && v.length <= INTAKE_LIMITS.emailMax && emails.length < INTAKE_LIMITS.list && !emails.includes(v)) emails.push(v);
      continue;
    }
    if (PHONE_COLUMNS.has(c.id)) {
      // a phone is never truncated (a cut number is someone else's); an over-long one is dropped
      if (c.value.length >= INTAKE_LIMITS.phoneMin && c.value.length <= INTAKE_LIMITS.phoneMax && phones.length < INTAKE_LIMITS.list && !phones.includes(c.value)) phones.push(c.value);
      continue;
    }
    if (c.id === 'POSTAL_CODE' && postalCode === undefined && /^[0-9]{5}(-[0-9]{4})?$/.test(c.value)) {
      postalCode = c.value;
      continue;
    }
    if (c.id === 'STREET_ADDRESS' && propertyText === undefined && (hook.inquiryType === 'sell' || hook.inquiryType === 'value')) {
      propertyText = capText(c.value, INTAKE_LIMITS.propertyText);
      continue;
    }
    unread++;
  }
  const full = name(first('FULL_NAME'));
  const firstName = full ? undefined : name(first('FIRST_NAME'));
  const lastName = full ? undefined : name(first('LAST_NAME'));
  const adId = lead.creativeId ?? lead.adgroupId;
  const detail: Record<string, string | number> = { channel: 'google_lead_form', unread_columns: unread };
  if (lead.formId) detail.form_id = lead.formId;
  if (lead.leadSource) detail.google_lead_source = capText(lead.leadSource, INTAKE_LIMITS.detailValue);
  if (lead.gclId) detail.gclid = capText(lead.gclId, INTAKE_LIMITS.detailValue);
  return {
    leadSourceId: hook.leadSourceId,
    externalId: capText(`gads:${lead.leadId ?? ''}`, INTAKE_LIMITS.externalId),
    inquiryType: hook.inquiryType,
    ...(full ? { fullName: full } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    phones,
    emails,
    ...(postalCode ? { postalCode } : {}),
    ...(propertyText ? { propertyText } : {}),
    ...(lead.campaignId ? { campaignRef: `gads:${lead.campaignId}` } : {}),
    ...(adId ? { adRef: `gads:${adId}` } : {}),
    ...(lead.submitTime ? { receivedAt: lead.submitTime.toISOString() } : {}),
    sourceDetail: detail,
  };
}

/**
 * Whether intake could make a contact of it: a name, or a phone or email that normalizes (intake's own INQUIRY_EMPTY
 * rule, checked before ingesting so an unreadable lead writes nothing).
 */
export function isReadable(i: GoogleInquiry): boolean {
  if (i.fullName || i.firstName || i.lastName) return true;
  if (i.phones.some((p) => normalizePhone(p, 'US').ok)) return true;
  return i.emails.some((e) => normalizeEmail(e).ok);
}
