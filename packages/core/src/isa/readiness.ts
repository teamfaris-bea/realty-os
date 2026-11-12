// Objective readiness (R-ISA-12; E502, E504, E507; docs/AI_ISA.md §4.5).
//
// Computed by core ONLY from usable claims (verified, not needs_review, client own text on a bound point, value in
// the quote: R-ISA-27) and from deterministic intent signals of verified own text. Recorded with the rule id, the
// rule version and the claim ids. Readiness WAITS while an offer is live, until the offer is resolved.
//   B1 / S1  an appointment was booked (the booking result says so)
//   B2       a verified request to tour a specific home, make an offer, or talk to the agent now
//   B3       timeline ≤ 90 days AND financing as stated ∈ {preapproved, cash, talking_to_lender} AND areas, budget, beds_min
//   S2       a verified request to list, or to meet, PLUS a verified intent to sell
//   S3       seller timeline ≤ 90 days AND owns (stated) AND not listed elsewhere (stated AND the MLS check) AND a
//            confirmed subject
// The model's `ready` action is only a hint: core recomputes it. VERIFY: the 90-day threshold (Q-ISA-12).
import type { IanaZone, Instant } from '../foundation/index.js';
import { ISA_READINESS_DEFAULTS } from './constants.js';
import { firstUnnegated, timelineDays } from './ownText.js';
import type { IsaSide, UsableQualClaim } from './types.js';

export const READINESS_RULE_VERSION = 'isa-readiness/1';

export type ReadinessRule = 'B1' | 'B2' | 'B3' | 'S1' | 'S2' | 'S3';

/** Deterministic intents read from verified client own text (never from the model). */
export type IntentKind = 'tour' | 'make_offer' | 'talk_now' | 'list' | 'meet' | 'intent_to_sell';

export interface IntentSignal {
  kind: IntentKind;
  messageId: string;
  /** The own-text span that matched. */
  quote: string;
}

/** Intent lexicons, on folded lower-case own text, negation-aware. VERIFY. */
export const INTENT_LEXICON: Readonly<Record<IntentKind, readonly RegExp[]>> = Object.freeze({
  tour: [
    /\b(?:see|tour|view|visit|look\s+at|walk\s+through|check\s+out)\s+(?:it|the\s+(?:house|home|place|property|condo|townhouse|one)|this\s+(?:one|house|home|place)|that\s+(?:one|house|home|place)|(?:the\s+)?(?:one|house|home)\s+on\b|\d+\s+\w+)/u,
    /\b(?:schedule|book|set\s+up)\s+(?:a\s+)?(?:showing|tour|viewing)\b/u,
    /\bcan\s+(?:we|i)\s+see\s+(?:it|the|this|that)\b/u,
  ],
  make_offer: [/\b(?:want|ready|like|plan(?:ning)?|going|decided)\s+to\s+(?:make|put\s+in|submit|write)\s+an?\s+offer\b/u, /\b(?:we'?d|i'?d)\s+like\s+to\s+(?:make|put\s+in)\s+an?\s+offer\b/u],
  talk_now: [/\b(?:talk|speak|meet)\s+(?:to|with)\s+(?:the\s+agent|you|\w+)\s+(?:now|today|asap|right\s+away)\b/u],
  list: [/\b(?:want|ready|like|plan(?:ning)?|going|decided|looking)\s+to\s+list\b/u, /\b(?:list|put)\s+(?:it|the\s+house|the\s+home|our\s+(?:house|home)|my\s+(?:house|home))\s+(?:on\s+the\s+market|for\s+sale|with\s+you)\b/u],
  meet: [/\b(?:meet|sit\s+down|come\s+(?:by|over|out))\s+(?:with\s+)?(?:you|the\s+agent|us|me)?\s*(?:to|and|about)?\s*(?:talk|discuss|go\s+over|look)\b/u, /\b(?:set\s+up|schedule|book)\s+(?:a\s+)?(?:meeting|consult\w*|appointment|walk[\s-]?through)\b/u],
  intent_to_sell: [/\b(?:want|ready|like|plan(?:ning)?|going|decided|looking|need|hoping|thinking\s+about|thinking\s+of)\s+(?:to\s+)?sell(?:ing)?\b/u, /\b(?:we'?re|we\s+are|i'?m|i\s+am)\s+selling\b/u],
});

/** Every intent in one message's own text (negated matches excluded: "we're not ready to list"). */
export function intentSignals(ownText: string, messageId: string): IntentSignal[] {
  const out: IntentSignal[] = [];
  for (const kind of Object.keys(INTENT_LEXICON) as IntentKind[]) {
    for (const re of INTENT_LEXICON[kind]) {
      const m = firstUnnegated(ownText, re);
      if (m !== null) {
        out.push({ kind, messageId, quote: m[0] });
        break;
      }
    }
  }
  return out;
}

export interface ReadinessInput {
  side: IsaSide;
  now: Instant;
  zone: IanaZone;
  claims: readonly UsableQualClaim[];
  intents: readonly IntentSignal[];
  /** A slot offer is pending delivery, offered or being accepted. */
  offerLive: boolean;
  /** B1/S1: an appointment of this assignment was booked. */
  appointmentBooked: { appointmentId: string; kind: 'buyer_consult' | 'listing_appointment' | 'consult' } | null;
  /** Seller: the MLS check found a live listing of another brokerage at the subject (R-ISA-26). */
  mlsListedElsewhere: boolean;
  /** Seller: the owner confirmed the subject home (§6.3). */
  subjectConfirmed: boolean;
  timelineDaysMax?: number;
}

export type ReadinessResult =
  | { ready: true; rule: ReadinessRule; ruleVersion: string; claimIds: string[]; messageIds: string[] }
  | { ready: false; waitingForOffer: boolean; missing: string[] };

function latest(claims: readonly UsableQualClaim[], field: UsableQualClaim['field']): UsableQualClaim | null {
  let best: UsableQualClaim | null = null;
  for (const c of claims) if (c.field === field && (best === null || c.saidAt >= best.saidAt)) best = c;
  return best;
}

const FINANCING_READY = new Set(['preapproved', 'cash', 'talking_to_lender']);

function timelineWithin(c: UsableQualClaim | null, max: number, zone: IanaZone): boolean {
  if (c === null || typeof c.value !== 'string') return false;
  const d = timelineDays(c.value, c.saidAt, zone);
  return d !== null && d <= max;
}

function nonEmpty(c: UsableQualClaim | null): boolean {
  if (c === null) return false;
  const v = c.value;
  return Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v > 0 : typeof v === 'string' ? v.trim() !== '' : v === true;
}

/** R-ISA-12: the first rule that holds (B1 before B2 before B3; S likewise), or what is missing. */
export function readiness(i: ReadinessInput): ReadinessResult {
  if (i.offerLive) return { ready: false, waitingForOffer: true, missing: ['offer_live'] };
  const max = i.timelineDaysMax ?? ISA_READINESS_DEFAULTS.timelineDays;
  const buyer = i.side === 'buyer' || i.side === 'both';
  const seller = i.side === 'seller' || i.side === 'both';
  const ok = (rule: ReadinessRule, claims: (UsableQualClaim | null)[], intents: IntentSignal[] = []): ReadinessResult => {
    const cs = claims.filter((c): c is UsableQualClaim => c !== null);
    return { ready: true, rule, ruleVersion: READINESS_RULE_VERSION, claimIds: cs.map((c) => c.claimId), messageIds: [...new Set([...cs.map((c) => c.messageId), ...intents.map((x) => x.messageId)])] };
  };
  const missing: string[] = [];
  if (i.appointmentBooked !== null) {
    const k = i.appointmentBooked.kind;
    if (buyer && (k === 'buyer_consult' || k === 'consult')) return ok('B1', []);
    if (seller && (k === 'listing_appointment' || k === 'consult')) return ok('S1', []);
  }
  if (buyer) {
    const b2 = i.intents.filter((x) => x.kind === 'tour' || x.kind === 'make_offer' || x.kind === 'talk_now');
    const contact = latest(i.claims, 'wants_agent_contact');
    if (b2.length > 0) return ok('B2', [], b2);
    if (contact !== null && contact.value === true) return ok('B2', [contact]);
    const tl = latest(i.claims, 'timeline');
    const fin = latest(i.claims, 'financing_status_stated');
    const areas = latest(i.claims, 'areas');
    const budget = latest(i.claims, 'budget');
    const beds = latest(i.claims, 'beds_min');
    const b3: [string, boolean][] = [
      ['timeline', timelineWithin(tl, max, i.zone)],
      ['financing_status_stated', fin !== null && typeof fin.value === 'string' && FINANCING_READY.has(fin.value)],
      ['areas', nonEmpty(areas)],
      ['budget', nonEmpty(budget)],
      ['beds_min', nonEmpty(beds)],
    ];
    if (b3.every(([, v]) => v)) return ok('B3', [tl, fin, areas, budget, beds]);
    missing.push(...b3.filter(([, v]) => !v).map(([k]) => `buyer:${k}`));
  }
  if (seller) {
    const ask = i.intents.filter((x) => x.kind === 'list' || x.kind === 'meet');
    const sell = i.intents.filter((x) => x.kind === 'intent_to_sell' || x.kind === 'list');
    if (ask.length > 0 && sell.length > 0) return ok('S2', [], [...ask, ...sell]);
    const tl = latest(i.claims, 'seller_timeline');
    const owns = latest(i.claims, 'seller_owns_stated');
    const listed = latest(i.claims, 'seller_listed_elsewhere_stated');
    const s3: [string, boolean][] = [
      ['seller_timeline', timelineWithin(tl, max, i.zone)],
      ['seller_owns_stated', owns !== null && owns.value === true],
      ['seller_listed_elsewhere_stated', listed !== null && listed.value === false],
      ['mls_not_listed', !i.mlsListedElsewhere],
      ['subject_confirmed', i.subjectConfirmed],
    ];
    if (s3.every(([, v]) => v)) return ok('S3', [tl, owns, listed]);
    missing.push(...s3.filter(([, v]) => !v).map(([k]) => `seller:${k}`));
  }
  return { ready: false, waitingForOffer: false, missing };
}

/** The end reason a readiness rule hands off with. */
export function readinessEndReason(rule: ReadinessRule): 'ready_buyer' | 'ready_seller' | 'appointment_booked' {
  if (rule === 'B1' || rule === 'S1') return 'appointment_booked';
  return rule.startsWith('B') ? 'ready_buyer' : 'ready_seller';
}
