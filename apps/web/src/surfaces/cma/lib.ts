// The CMA surface's model (module 72, web/cma; D9 V2-A, R-CMA-9): the response types of apps/api/src/cma/schemas.ts
// (CmaViewSchema, CmaListResponse, SharePreviewResponse, ShareResponse) copied field by field, the fetchers and query
// keys, and the money, date and distance words. Restated, not imported: apps/web takes @realty/api as types only and
// @realty/core's runtime stays out of the phone bundle (as integrations/mls/pack.ts does). lib.test.ts checks the
// property types against core/valuation.
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, type ApiClient, messageFor, useApi } from '../../shell/index.js';
import { CMA_ERROR_MESSAGES } from './words.js';

/** The roles with cma.prepare (DATA_MODEL §8: Owner, Admin, Team Lead, Agent; ISA and TC none). */
export const CMA_ROLES = ['owner', 'admin', 'team_lead', 'agent'] as const;

// ---- types (apps/api/src/cma/schemas.ts) ---------------------------------------------------------------

/** packages/core/src/valuation/types.ts CMA_PROPERTY_TYPES, in its order */
export const CMA_PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'manufactured', 'other'] as const;
export type CmaPropertyType = (typeof CMA_PROPERTY_TYPES)[number];
export const CMA_PURPOSES = ['listing_price', 'buyer_offer', 'other'] as const;
export type CmaPurpose = (typeof CMA_PURPOSES)[number];
export const CMA_INSPECTIONS = ['none', 'exterior', 'interior_and_exterior'] as const;
export type CmaInspection = (typeof CMA_INSPECTIONS)[number];
export const DISCLOSURE_FIELDS = ['intendedUsers', 'agentInterest', 'conflicts', 'valueDefinition', 'limitingConditions'] as const;
export type DisclosureField = (typeof DISCLOSURE_FIELDS)[number];
export type FactSource = 'mls' | 'team' | 'agent' | null;

export interface Fact<T> {
  value: T | null;
  source: FactSource;
}

export interface SubjectAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
}

export interface ListingAddress {
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
}

export interface Support {
  kind: 'with_without' | 'above_below' | 'sales_months' | 'none';
  first: number;
  second: number;
  pairs: number;
}

export interface Blocker {
  code: string;
  sentence: string;
  count?: number;
  listingIds?: string[];
}

export interface SubjectFactsView {
  propertyType: Fact<CmaPropertyType>;
  sqft: Fact<number>;
  agentEnteredSqft: number | null;
  beds: Fact<number>;
  bathsX10: Fact<number>;
  yearBuilt: Fact<number>;
  lotSqft: Fact<number>;
  garageSpacesX10: Fact<number>;
  storiesX10: Fact<number>;
  poolPrivate: Fact<boolean>;
  subdivision: Fact<string>;
  mapLocation: { known: boolean; source: FactSource };
}

export interface CompView {
  listingId: string;
  saleListingId: string;
  sourceLabel: 'MLS' | 'Team';
  mlsNumber: string | null;
  listingBrokerageName: string | null;
  address: ListingAddress;
  closePriceCents: number | null;
  closeDate: string | null;
  contractDate: string | null;
  distanceM: number | null;
  tier: string | null;
  facts: { propertyType: string | null; sqft: number | null; sizeSource: string | null; beds: number | null; bathsX10: number | null; yearBuilt: number | null; lotSqft: number | null; daysOnMarket: number | null; concessionsCents: number | null };
  adjustments: { feature: string; subjectValue: number | null; compValue: number | null; rate: number | null; amountCents: number; support: Support; sentence: string }[];
  adjustedPriceCents: number;
  grossAdjustmentBps: number;
  weightBasisBps: number;
  weightBps: number;
  why: string[];
  labels: string[];
  saleConditions: string[];
  includedByAgent: boolean;
}

export interface NotUsedView {
  listingId: string;
  mlsNumber: string | null;
  address: string;
  reason: string;
  conditions: string[];
  distanceM: number | null;
  sentence: string;
  includable: boolean;
}

export interface CmaView {
  id: string;
  contactId: string | null;
  status: 'draft' | 'shared' | 'superseded';
  purpose: CmaPurpose;
  inspection: CmaInspection;
  inspectedOn: string | null;
  disclosure: Record<DisclosureField, string | null>;
  notes: string | null;
  createdByUserId: string;
  mine: boolean;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  sharedAt: string | null;
  valuationDate: string;
  mlsDataAsOf: string | null;
  mlsDataAsOfSentence: string;
  methodVersion: string;
  subject: {
    kind: 'listing' | 'contact_address' | 'entered';
    listingId: string | null;
    contactAddressId: string | null;
    address: SubjectAddress;
    state: string | null;
    sizeSentence: string;
    factSentences: string[];
    facts: SubjectFactsView;
    saleHistory: { listingId: string; mlsNumber: string | null; status: string; closeDate: string | null; closePriceCents: number | null; listingBrokerageName: string | null }[];
    include: string[];
    exclude: string[];
    nearMatchDismissed: string[];
  };
  result: {
    available: boolean;
    reason: 'NO_SALES' | 'INSUFFICIENT_COMPS' | 'SUBJECT_INCOMPLETE' | 'SUBJECT_TYPE_NOT_SUPPORTED' | null;
    sentence: string;
    sentences: string[];
    valueCents: number | null;
    lowCents: number | null;
    highCents: number | null;
    closeDateSpan: { earliest: string; latest: string } | null;
    distanceSpanM: { min: number; max: number } | null;
  };
  comps: CompView[];
  notUsed: NotUsedView[];
  notUsedTotal: number;
  subjectSales: { listingId: string; closeDate: string | null; closePriceCents: number | null; status: string }[];
  context: { listingId: string; sourceLabel: 'MLS' | 'Team'; mlsNumber: string | null; listingBrokerageName: string | null; status: string; listPriceCents: number | null; beds: number | null; bathsX10: number | null; sqft: number | null; address: string; why: string[] }[];
  contextSentence: string;
  area: { tier: string | null; lookbackMonths: number; tiersSkipped: string[]; reads: { tier: string; ran: boolean; rows: number; limitReached: boolean }[]; recordsLeftOut: number; sentences: string[] };
  market: { poolTier: string | null; poolMonths: number; poolSales: number; rates: { feature: string; applied: boolean; rate: number | null; support: Support; sentence: string }[]; sentences: string[] };
  backtest: { salesTested: number; notValued: number; medianMissBps: number | null; within10PctBps: number | null; windowStart: string; sentence: string };
  nearMatches: { listingId: string; mlsNumber: string | null; address: string; status: string; listingBrokerageName: string | null; avmDisplayAllowed: boolean | null; dismissed: boolean }[];
  contentSha256: string;
  disclosureMissing: (DisclosureField | 'inspectedOn')[];
  share: { sharedByUserId: string; message: { id: string; status: string; statusReason: string | null; sentence: string } | null } | null;
  pdfAvailable: boolean;
  /** V1 readiness: only `blockers` is read here (sharing state is the share preview's) */
  clientShare: { ready: boolean; sharingAvailable: false; sentence: string; estimateSentence: string; blockers: Blocker[] };
}

export interface CmaSummary {
  id: string;
  contactId: string | null;
  status: string;
  purpose: string;
  valuationDate: string;
  mlsDataAsOf: string | null;
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  address: string | null;
  createdByUserId: string;
  mine: boolean;
  fromMergedRecord: boolean;
  canEdit: boolean;
  createdAt: string;
}

export type PreviewWhere = DisclosureField | 'notes' | 'inspectedOn';
export type ReportRole = 'title' | 'range' | 'estimate' | 'provider' | 'statement' | 'comp' | 'as_of' | 'inspection' | 'sop' | 'notes' | 'attribution' | 'disclaimer';

export interface SharePreview {
  cmaId: string;
  contentSha256: string;
  reportSha256: string | null;
  subject: string | null;
  reportText: string | null;
  body: string | null;
  recipients: { contactId: string; name: string; firstName: string; relationship: 'self' | 'co_seller' | 'spouse_partner'; emails: { id: string; address: string; status: string }[] }[];
  recipientContactId: string | null;
  toPointId: string | null;
  decision: { id: string | null; outcome: string; reasons: string[]; explanation: string; phase: 'preview' | 'send' } | null;
  warnings: { code: 'WONT_PRINT' | 'CHECK_WORDING'; role: ReportRole; codePoints?: string[] }[];
  statement: { ok: boolean; part: string | null; reason: string | null; codePoints: string[] };
  tooLong: { parts: { role: ReportRole; chars: number }[] } | null;
  disclosureMissing: PreviewWhere[];
  fairHousing: { hard: { termId: string; label: string; where: PreviewWhere }[]; soft: { termId: string; label: string; where: PreviewWhere }[] };
  blockers: Blocker[];
  stale: 'DATA_OLD' | 'SALE_CHANGED' | null;
  canShare: boolean;
  sentence: string | null;
}

export interface ShareResult {
  cma: CmaView;
  message: { id: string; status: string; result: string };
}

export interface SubjectFactsBody {
  propertyType?: CmaPropertyType;
  sqft?: number;
  beds?: number | null;
  bathsX10?: number | null;
  yearBuilt?: number | null;
  lotSqft?: number | null;
  garageSpacesX10?: number | null;
  storiesX10?: number | null;
  poolPrivate?: boolean | null;
  subdivision?: string | null;
}

export interface PatchBody {
  include?: string[];
  exclude?: string[];
  subjectFacts?: SubjectFactsBody;
  purpose?: CmaPurpose;
  inspection?: CmaInspection;
  inspectedOn?: string | null;
  notes?: string | null;
  disclosure?: Partial<Record<DisclosureField, string | null>>;
  nearMatchDismissed?: string[];
}

// ---- keys and fetchers -------------------------------------------------------------------------------

export const cmaKey = (id: string) => ['cma', id] as const;
export const previewKey = (id: string, recipientContactId: string | null, toPointId: string | null) => ['cma', id, 'share-preview', recipientContactId, toPointId] as const;
export const contactCmasKey = (contactId: string) => ['contact-cmas', contactId] as const;

export const fetchCma = (api: ApiClient, id: string, signal?: AbortSignal) => api.get<{ cma: CmaView }>(`/cma/${id}`, signal ? { signal } : {});
export const fetchContactCmas = (api: ApiClient, contactId: string, signal?: AbortSignal) => api.get<{ cmas: CmaSummary[] }>(`/contacts/${contactId}/cmas`, signal ? { signal } : {});
export function previewPath(id: string, recipientContactId: string | null, toPointId: string | null): string {
  const q = new URLSearchParams();
  if (recipientContactId) q.set('recipientContactId', recipientContactId);
  if (toPointId) q.set('toPointId', toPointId);
  const s = q.toString();
  return `/cma/${id}/share-preview${s ? `?${s}` : ''}`;
}
export const pdfHref = (id: string) => `/api/cma/${id}/report.pdf`;

/** The sentence for a failure: the server's own `details.sentence` when it sent one, else this surface's words. */
export function cmaMessage(e: unknown): string {
  const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
  const s = err.details?.sentence;
  return typeof s === 'string' && s.trim() ? s : messageFor(err, CMA_ERROR_MESSAGES);
}

export type CallResult<R> = { ok: true; data: R } | { ok: false; error: ApiError; message: string };

/**
 * One tap = one request: a second tap while one is in flight gets the same promise. Failures come back in words.
 * The listed queries are refetched when it settles.
 */
export function useCall<B, R>(method: 'POST' | 'PATCH', o: { invalidate?: QueryKey[] } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ error: ApiError; message: string } | null>(null);
  const inFlight = useRef<Promise<CallResult<R>> | null>(null);
  const invalidate = useRef(o.invalidate ?? []);
  invalidate.current = o.invalidate ?? [];
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    (path: string, body?: B): Promise<CallResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const p = (async (): Promise<CallResult<R>> => {
        setPending(true);
        setError(null);
        try {
          return { ok: true, data: await api.request<R>(method, path, body ?? {}) };
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
          const failure = { error: err, message: cmaMessage(err) };
          if (mounted.current) setError(failure);
          return { ok: false as const, ...failure };
        } finally {
          inFlight.current = null;
          if (mounted.current) setPending(false);
          for (const key of invalidate.current) void qc.invalidateQueries({ queryKey: key });
        }
      })();
      inFlight.current = p;
      return p;
    },
    [api, method, qc],
  );
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}

/** True at >= 1024 px (the two-column layout). False where matchMedia is missing (jsdom: the phone layout). */
export function useWide(): boolean {
  const q = '(min-width: 1024px)';
  const subscribe = useCallback((fn: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
    const m = window.matchMedia(q);
    m.addEventListener?.('change', fn);
    return () => m.removeEventListener?.('change', fn);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false),
    () => false,
  );
}

// ---- words for numbers ---------------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "$512,000"; "not known" for null. */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 'not known';
  return USD.format(Math.round(cents / 100));
}

/** "+$12,500" / "−$4,000" for an adjustment. */
export function signedMoney(cents: number): string {
  if (cents === 0) return '$0';
  return `${cents > 0 ? '+' : '−'}${USD.format(Math.round(Math.abs(cents) / 100))}`;
}

export function integer(n: number): string {
  return INT.format(n);
}

/** "0.4 mi" from meters; "distance not known" for null. */
export function miles(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return 'distance not known';
  const mi = m / 1609.344;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** "Oct 2, 2026" for "2026-10-02" (no time zone shift) or an ISO instant (the viewer's zone). */
export function day(s: string | null | undefined): string {
  if (!s) return 'date not known';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(m ? { timeZone: 'UTC' } : {}) }).format(d);
}

/** A part of 10,000 as "24%" or "16.66%" (a comp's weight, to the server's precision). */
export function share(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, '')}%`;
}

/** Tenths ("bathsX10": 25) as "2.5". */
export function tenths(x10: number | null): string | null {
  return x10 === null ? null : String(x10 / 10);
}

export function streetLine(a: { line1: string | null; line2: string | null }): string {
  return [a.line1, a.line2].filter((x) => x && x.trim()).join(' ');
}

export function fullAddress(a: SubjectAddress | ListingAddress): string {
  const street = streetLine(a);
  const place = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter((x) => x && x.trim()).join(', ');
  return [street, place].filter(Boolean).join(', ');
}

/** The share panel applies: the creator's draft of a contact whose subject is not a listing (owner questions g, k). */
export function sharePanelApplies(v: Pick<CmaView, 'mine' | 'status' | 'contactId' | 'subject'>): boolean {
  return v.mine && v.status === 'draft' && v.contactId !== null && v.subject.kind !== 'listing';
}

/** A research CMA or one of a listing is never shared from here. */
export function neverShared(v: Pick<CmaView, 'contactId' | 'subject'>): boolean {
  return v.contactId === null || v.subject.kind === 'listing';
}
