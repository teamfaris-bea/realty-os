// The pure decisions of the nightly pass (module 50). The pass (pass.ts) reads rows and writes the outcome; every
// choice it makes is one of these functions, so the property tests check them directly (decide.property.test.ts).
//
//   isNightHour          the pass acts once per tenant and local date, at night (R-OWN-27)
//   selectLookups        which home addresses are looked up, within the per-day budget (R-PRED-2, E122)
//   recordFromLookup     what a lookup becomes: attached facts, or a no-facts row (E122, not available)
//   assembleFeatures     the six features only, each passing parseFeatures (R-PRED-1, R-AST-12, E120)
//   desiredCard          the one card a prediction may become, for the contact's current owner (R-PRED-3/4/6, E121)
import { DAY_MS, type ContactId, type Instant } from '@realty/core/foundation';
import {
  type ApprovedModel,
  type FeatureEvidence,
  type FeatureName,
  type PostalAddress,
  type PredictionFeatures,
  type PropertyFacts,
  type Reason,
  attachPropertyRecord,
  backtestText,
  derivePropertyFeatures,
  listableForOutreach,
  normalizeAddress,
  parseFeatures,
  predictionFeedCard,
} from '@realty/core/predict';
import { likelyFeedKey } from '@realty/core/priority';
import type { PublicRecordFacts, PublicRecordLookup } from './provider.js';
import { BAND_CARD_SCORE, BAND_WORDS, type PredictSettings } from './settings.js';

export function isNightHour(localHour: number, s: Pick<PredictSettings, 'nightStartHour' | 'nightEndHour'>): boolean {
  return localHour >= s.nightStartHour && localHour < s.nightEndHour;
}

// ---- property-record refresh -----------------------------------------------------------------------------

export interface AddressCandidate {
  addressId: string;
  contactId: string;
  kind: string;
  contactLive: boolean;
  contactOwned: boolean;
  /** person-level do-not-contact: never listed for outreach, so a lookup has no purpose */
  doNotContact: boolean;
  address: PostalAddress;
  /** contact_addresses.updated_at */
  updatedAt: Instant;
  /** the address's record, if any */
  fetchedAt: Instant | null;
}

/** Due: no record yet, a record older than the refresh age, or the address changed after the record was fetched. */
export function addressDue(c: Pick<AddressCandidate, 'updatedAt' | 'fetchedAt'>, now: Instant, refreshAgeDays: number): boolean {
  if (c.fetchedAt === null) return true;
  return c.fetchedAt <= now - refreshAgeDays * DAY_MS || c.updatedAt > c.fetchedAt;
}

/**
 * The addresses to look up now, in the given order, at most `budgetLeft`: only while a scoring model names a
 * property feature (`purpose`), only home addresses of live, owned contacts that may be listed for outreach, only
 * addresses core can normalize, and only due ones.
 */
export function selectLookups(cands: readonly AddressCandidate[], o: { now: Instant; refreshAgeDays: number; budgetLeft: number; purpose: boolean }): AddressCandidate[] {
  if (!o.purpose || o.budgetLeft <= 0) return [];
  const out: AddressCandidate[] = [];
  for (const c of cands) {
    if (out.length >= o.budgetLeft) break;
    if (c.kind !== 'home' || !c.contactLive || !c.contactOwned || c.doNotContact) continue;
    if (normalizeAddress(c.address) === null) continue;
    if (!addressDue(c, o.now, o.refreshAgeDays)) continue;
    out.push(c);
  }
  return out;
}

/** Lookups still allowed today: the budget less the rows fetched on the tenant's local date and this pass's lookups. */
export function budgetLeft(budget: number, fetchedToday: number, madeThisPass: number): number {
  return Math.max(0, budget - fetchedToday - madeThisPass);
}

export type RecordOutcome = 'attached' | 'needs_review' | 'not_available';

/** The property_records columns a lookup writes (never a name: names are compared in memory only). */
export interface RecordWrite {
  outcome: RecordOutcome;
  detail: 'address_mismatch' | 'owner_name_mismatch' | 'missing_data' | null;
  ownerNameMatch: boolean;
  facts: PublicRecordFacts | null;
  providerRef: string | null;
}

/**
 * Attached only through core attachPropertyRecord (exact normalized address AND one of the contact's own recorded
 * names). Not attached (E122) or not available: owner_name_match false and no facts, so no feature derives from it.
 */
export function recordFromLookup(l: PublicRecordLookup, contact: { address: PostalAddress; names: readonly string[] }): RecordWrite {
  if (l.status === 'not_available') return { outcome: 'not_available', detail: null, ownerNameMatch: false, facts: null, providerRef: null };
  const d = attachPropertyRecord(l.candidate, contact);
  if (!d.attach) return { outcome: 'needs_review', detail: d.detail, ownerNameMatch: false, facts: null, providerRef: null };
  return { outcome: 'attached', detail: null, ownerNameMatch: true, facts: { ...l.candidate.facts }, providerRef: l.candidate.providerRef };
}

// ---- features ---------------------------------------------------------------------------------------------

/** What the feature loader read for one contact (pass.ts loadFeatureInputs); never contact_attributes. */
export interface FeatureInputs {
  contactId: string;
  /** the contact's current attached record (owner_name_match true, fetched after the address last changed) */
  record: (Omit<PropertyFacts, 'lastSaleAt'> & { lastSaleDate: string | null }) | null;
  /** listing_saved FACTS (never signals) in the named window; null when not counted */
  recentSaves: number | null;
  /** the latest closed deal the contact is on (primary contact, or buyer/seller/co_buyer/co_seller) */
  lastClosedDeal: { dealId: string; closedAt: Instant } | null;
}

/** The assembler's output: exactly the six features (a seventh key does not type-check, E120). */
export type AssembledFeatures = { features: PredictionFeatures; evidence: FeatureEvidence };

const yearsSince = (t: Instant, asOf: Instant) => Math.floor((asOf - t) / (365.25 * DAY_MS));

/**
 * The model's features for one contact. stated_timeline_days is always absent: no stored source exists, and a
 * self-reported timeline in contact_attributes (pcs_timeline, a protected proxy) never enters (E120).
 * Only the model's own features are kept, and the result passes core parseFeatures (anything else is dropped).
 */
export function assembleFeatures(i: FeatureInputs, asOf: Instant, modelFeatures: readonly FeatureName[], o: { recentSavesWindowDays: number }): AssembledFeatures {
  const features: PredictionFeatures = {};
  const evidence: FeatureEvidence = {};
  if (i.record !== null && i.record.ownerNameMatch) {
    const lastSaleAt = i.record.lastSaleDate === null ? null : Date.parse(`${i.record.lastSaleDate}T00:00:00Z`);
    const p = derivePropertyFeatures({ ...i.record, lastSaleAt: lastSaleAt === null || Number.isNaN(lastSaleAt) ? null : (lastSaleAt as Instant) }, asOf);
    Object.assign(features, p.features);
    Object.assign(evidence, p.evidence);
  }
  if (i.recentSaves !== null && Number.isSafeInteger(i.recentSaves) && i.recentSaves >= 0) {
    features.recentSaves = Math.min(i.recentSaves, 10_000);
    evidence.recent_saves = { sourceType: 'saved_search_activity', sourceId: i.contactId, field: `listing_saved_${o.recentSavesWindowDays}d` };
  }
  if (i.lastClosedDeal !== null && i.lastClosedDeal.closedAt <= asOf) {
    const y = yearsSince(i.lastClosedDeal.closedAt, asOf);
    if (y >= 0 && y <= 150) {
      features.pastClientYears = y;
      evidence.past_client_years = { sourceType: 'deal', sourceId: i.lastClosedDeal.dealId, field: 'closed_at' };
    }
  }
  // only the model's own features enter (R-PRED-1); everything passes the runtime guard
  const keep: Record<string, unknown> = {};
  const keepEvidence: FeatureEvidence = {};
  const KEY: Record<FeatureName, keyof PredictionFeatures> = { years_in_home: 'yearsInHome', equity_band: 'equityBand', recent_saves: 'recentSaves', stated_timeline_days: 'statedTimelineDays', past_client_years: 'pastClientYears', recent_permit: 'recentPermit' };
  for (const f of modelFeatures) {
    if (f === 'stated_timeline_days') continue;
    const v = features[KEY[f]];
    if (v !== undefined) {
      keep[KEY[f]] = v;
      if (evidence[f]) keepEvidence[f] = evidence[f];
    }
  }
  const parsed = parseFeatures(keep);
  return parsed.ok ? { features: parsed.features, evidence: keepEvidence } : { features: {}, evidence: {} };
}

// ---- cards ------------------------------------------------------------------------------------------------

export interface CardContact {
  contactId: string;
  live: boolean;
  ownershipState: string;
  ownerUserId: string | null;
  doNotContact: boolean;
  closedReason: string | null;
}

export interface DesiredCard {
  userId: string;
  dedupeKey: string;
  contactId: string;
  score: number;
  reasons: { code: string; label: string }[];
}

/** The card's lines: the band in words, each reason's text (no points), then the model's back-test (R-PRED-3). */
export function cardReasons(band: 'likely_90d' | 'watch', reasons: readonly Reason[], model: ApprovedModel): { code: string; label: string }[] {
  return [
    { code: band === 'likely_90d' ? 'LIKELY_BAND_90D' : 'LIKELY_BAND_WATCH', label: BAND_WORDS[band] },
    ...reasons.map((r) => ({ code: `LIKELY_${r.feature.toUpperCase()}`, label: r.text })),
    { code: 'LIKELY_BACKTEST', label: backtestText(model.backtest) },
  ];
}

/**
 * The one card a scored prediction becomes, or null. Exactly when the model can score (it is in `model`), the band
 * is likely_90d or watch with at least one reason (core predictionFeedCard), and the contact is live, owned and
 * listable for outreach (R-PRED-6). The card goes to the contact's CURRENT owner only.
 */
export function desiredCard(p: { band: string; reasons: Reason[] }, model: ApprovedModel, c: CardContact): DesiredCard | null {
  if (!c.live || c.ownershipState !== 'owned' || c.ownerUserId === null) return null;
  if (!listableForOutreach({ personDoNotContact: c.doNotContact, closedReason: c.closedReason })) return null;
  const card = predictionFeedCard({ contactId: c.contactId as ContactId, modelVersion: model.version, band: p.band as never, reasons: p.reasons }, model);
  if (card === null) return null;
  return {
    userId: c.ownerUserId,
    dedupeKey: likelyFeedKey(c.contactId as ContactId, model.version),
    contactId: c.contactId,
    score: BAND_CARD_SCORE[card.band],
    reasons: cardReasons(card.band, card.reasons, model),
  };
}
