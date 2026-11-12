// The model-output schema and decideAction (R-ISA-5, R-ISA-13, R-ISA-27; E495, E506, E508, E509, E510;
// docs/AI_ISA.md §4.3, §7.2, §7.4).
//
// The provider stays tool-less (R-AST-14). The model returns ONE strict JSON object: unknown keys, wrong types or
// extra handles fail the parse. The model PROPOSES and core DECIDES, like voice `decideToolCall`: each item is
// allowed or denied with a code. A denial is recorded as codes and handles only. The model can never choose a
// recipient, channel, purpose or time, name anything outside this turn's handles, pick which comps are shown,
// lift an escalation, write a note to the agent, or move the state except through allowed actions.
import { z } from 'zod';
import type { IanaZone, Instant } from '../foundation/index.js';
import { type IdentityFacts, MODEL_OUTPUT_MAX_CHARS, type SourceText, verifyQuote } from '../assistant/index.js';
import type { FairHousingPack } from '../fairhousing/index.js';
import { ISA_CADENCES, ISA_OUTPUT_LIMITS } from './constants.js';
import { isaGuard, type IsaGuardCode } from './guard.js';
import { isTeamText, qualValueQuoted } from './ownText.js';
import { type IntentSignal, readiness, type ReadinessResult, type ReadinessRule } from './readiness.js';
import { type IsaSlot } from './types.js';
import { matchSlotChoice } from './slots.js';
import { ESCALATION_CLASSES, type EscalationClass, type IsaCapability, type IsaChannel, type IsaSide, QUAL_FIELDS, type QualField, type UsableQualClaim } from './types.js';

const SourceHandle = z.string().regex(/^S[1-9]\d{0,3}$/);
const Quote = z.string().min(1).max(ISA_OUTPUT_LIMITS.quoteMax);
const QuoteRef = z.strictObject({ source: SourceHandle, quote: Quote });
const QualValueSchema = z.union([z.string().min(1).max(80), z.number().finite(), z.boolean(), z.array(z.string().min(1).max(80)).min(1).max(10)]);

const ActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('share_listings'), handles: z.array(z.string().regex(/^L[1-9]\d{0,2}$/)).min(1).max(ISA_OUTPUT_LIMITS.maxListingHandles) }),
  z.strictObject({ type: z.literal('propose_saved_search') }),
  z.strictObject({ type: z.literal('share_competition'), handles: z.array(z.string().regex(/^C[1-9]\d{0,2}$/)).min(1).max(ISA_OUTPUT_LIMITS.maxCompetitionHandles) }),
  z.strictObject({ type: z.literal('send_comps') }),
  z.strictObject({ type: z.literal('offer_slots'), kind: z.enum(['buyer_consult', 'listing_appointment', 'consult']) }),
  z.strictObject({ type: z.literal('book_slot'), offer: z.string().regex(/^O[1-9]\d{0,2}$/), slot: z.number().int().min(1).max(3), quote: Quote, source: SourceHandle }),
  z.strictObject({ type: z.literal('escalate'), class: z.enum(ESCALATION_CLASSES), quoteRef: QuoteRef.optional() }),
  z.strictObject({ type: z.literal('ready'), basis: z.enum(['B2', 'B3', 'S2', 'S3']) }),
  z.strictObject({ type: z.literal('follow_up'), after: z.enum(ISA_CADENCES) }),
  z.strictObject({ type: z.literal('end'), reason: z.enum(['not_interested', 'has_agent', 'not_a_lead']), quoteRef: QuoteRef }),
]);
export type IsaModelAction = z.infer<typeof ActionSchema>;

const QualSchema = z.strictObject({ field: z.enum(QUAL_FIELDS), value: QualValueSchema, quote: Quote, source: SourceHandle });

export const IsaModelOutputSchema = z.strictObject({
  reply: z.strictObject({ text: z.string().max(ISA_OUTPUT_LIMITS.replyMax.email) }).nullable(),
  qualification: z.array(QualSchema).max(ISA_OUTPUT_LIMITS.maxQualifications),
  actions: z.array(ActionSchema).max(ISA_OUTPUT_LIMITS.maxActions),
  summary: z.string().max(ISA_OUTPUT_LIMITS.summaryMax).nullable(),
});
export type IsaModelOutput = z.infer<typeof IsaModelOutputSchema>;

export type ParseFailure = 'OVERSIZED' | 'NOT_JSON' | 'SCHEMA';

/**
 * Strict parse of the raw model text (§7.4). A failure carries only a code and, for the repair retry, the schema
 * paths (never the model's text). Leading or trailing whitespace is allowed; anything else around the object is not.
 */
export function parseIsaModelOutput(raw: string): { ok: true; output: IsaModelOutput } | { ok: false; code: ParseFailure; paths: string[] } {
  if (typeof raw !== 'string' || raw.length > MODEL_OUTPUT_MAX_CHARS) return { ok: false, code: 'OVERSIZED', paths: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return { ok: false, code: 'NOT_JSON', paths: [] };
  }
  const r = IsaModelOutputSchema.safeParse(json);
  if (!r.success) return { ok: false, code: 'SCHEMA', paths: [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 10) };
  return { ok: true, output: r.data };
}

/** The server note of a repair retry: the failing paths only, never model text. */
export function repairNote(paths: readonly string[]): string {
  return `Your last reply did not match the required JSON shape at: ${paths.map((p) => p.replace(/[^\w.]/g, '')).join(', ') || '(root)'}. Reply with the JSON object only.`;
}

// ---- decideAction ---------------------------------------------------------------------------------------------

/** A prompt source as decideAction sees it: who wrote it, and the own text it was taken from. */
export interface TurnSource {
  handle: string;
  messageId: string;
  /** client_own: an inbound turn from a bound point (its own text); team: anything the team or the AI sent. */
  author: 'client_own' | 'team';
  channel: IsaChannel;
  text: string;
  at: Instant;
  ownTextReliable: boolean;
}

export interface TurnOffer {
  handle: string;
  status: 'pending_delivery' | 'offered' | 'accepting';
  slots: readonly IsaSlot[];
  deliveredAt: Instant | null;
  /** The offer's display zones (what the client saw). */
  zones: readonly IanaZone[];
}

export interface DecideContext {
  side: IsaSide;
  capabilities: ReadonlySet<IsaCapability>;
  /** The server's channel for a reply in this turn. */
  replyChannel: IsaChannel;
  sources: readonly TurnSource[];
  /** Every team text of the thread (outbounds, the offer rendering, the AI's own questions). */
  teamTexts: readonly string[];
  /** This turn's handles from the server's own bundles. */
  listingHandles: ReadonlySet<string>;
  competitionHandles: ReadonlySet<string>;
  /** The complete comp set passed every gate (§6.3), and the email channel passes. */
  compsAvailable: boolean;
  /** Hold topics the AI must stay off (pricing suspends comps, §4.4). */
  heldClasses: ReadonlySet<EscalationClass>;
  calendarLive: boolean;
  offer: TurnOffer | null;
  /** A deterministic meet / tour / talk request (or agreement) in this turn's verified own text. */
  meetRequested: boolean;
  /** The confirmation of `slot` can go out now or at the next window start ahead of its notice (§4.6 item 3). */
  confirmationInTime: (slot: IsaSlot) => boolean;
  /** No open saved-search proposal, and the initiated tier passes on the alert channel (§6.2). */
  savedSearchAllowed: boolean;
  /** Readiness inputs other than the claims and the offer. */
  intents: readonly IntentSignal[];
  priorClaims: readonly UsableQualClaim[];
  appointmentBooked: { appointmentId: string; kind: 'buyer_consult' | 'listing_appointment' | 'consult' } | null;
  mlsListedElsewhere: boolean;
  subjectConfirmed: boolean;
  zone: IanaZone;
  now: Instant;
  identity: IdentityFacts;
  promptSources: readonly SourceText[];
  fairHousing?: FairHousingPack;
  /** Ids for accepted claims (injected; core stays pure). */
  claimId: (index: number) => string;
}

export type DenyCode =
  | 'CAPABILITY_NOT_AVAILABLE'
  | 'SIDE_MISMATCH'
  | 'HANDLE_UNKNOWN'
  | 'QUOTE_NOT_CLIENT'
  | 'QUOTE_NOT_VERIFIED'
  | 'QUOTE_IS_TEAM_TEXT'
  | 'VALUE_NOT_QUOTED'
  | 'OWN_TEXT_UNRELIABLE'
  | 'REPLY_WITH_FACTS'
  | 'GUARD_BLOCKED'
  | 'OFFER_LIVE'
  | 'CALENDAR_NOT_LIVE'
  | 'NO_MEET_REQUEST'
  | 'SLOT_NOT_OFFERED'
  | 'OFFER_NOT_DELIVERED'
  | 'QUOTE_BEFORE_OFFER'
  | 'SLOT_MISMATCH'
  | 'SLOT_AMBIGUOUS'
  | 'CONFIRMATION_TOO_LATE'
  | 'READINESS_NOT_MET'
  | 'COMPS_UNAVAILABLE'
  | 'TOPIC_HELD'
  | 'DUPLICATE_ACTION'
  | 'SAVED_SEARCH_NOT_ALLOWED'
  | 'SUMMARY_BLOCKED';

export interface Denial {
  /** What was denied: an action type, `reply`, `qualification:<field>` or `summary`. Codes and handles only. */
  item: string;
  code: DenyCode;
  handles?: string[];
}

export interface Decision {
  reply: { text: string } | null;
  /** The guard codes when the reply was blocked (the turn sends the fallback line or nothing). */
  replyBlocked: { codes: IsaGuardCode[]; fallback: 'pricing' | 'fair_housing' | 'holding' } | null;
  claims: UsableQualClaim[];
  /** Claims that failed a check: stored needs_review and unusable (R-ISA-27). */
  unusableClaims: { field: QualField; source: string; code: DenyCode }[];
  shareListings: string[] | null;
  shareCompetition: string[] | null;
  sendComps: boolean;
  proposeSavedSearch: boolean;
  offerSlots: { kind: 'buyer_consult' | 'listing_appointment' | 'consult' } | null;
  bookSlot: { offer: string; slotIndex: number; messageId: string; quote: string } | null;
  /** A slot answer that matched nothing uniquely: one clarification, then uncertain (the machine counts). */
  slotAmbiguous: boolean;
  escalations: EscalationClass[];
  ready: { rule: ReadinessRule; claimIds: string[] } | null;
  followUp: (typeof ISA_CADENCES)[number] | null;
  endProposal: { reason: 'not_interested' | 'has_agent' | 'not_a_lead'; messageId: string } | null;
  summary: string | null;
  denied: Denial[];
}

function sourceOf(ctx: DecideContext, handle: string): TurnSource | null {
  return ctx.sources.find((s) => s.handle === handle) ?? null;
}

/** A verified client own-text quote, or the denial code. */
function checkClientQuote(ctx: DecideContext, handle: string, quote: string): { ok: true; src: TurnSource } | { ok: false; code: DenyCode } {
  const src = sourceOf(ctx, handle);
  if (src === null) return { ok: false, code: 'HANDLE_UNKNOWN' };
  if (src.author !== 'client_own') return { ok: false, code: 'QUOTE_NOT_CLIENT' };
  const v = verifyQuote(
    { kind: 'text', sourceType: src.channel === 'email' ? 'email' : 'message', sourceId: src.messageId, text: src.text, at: src.at, author: 'client' },
    { sourceType: src.channel === 'email' ? 'email' : 'message', sourceId: src.messageId, locator: { kind: 'message' }, snippet: quote },
  );
  if (!v.verified) return { ok: false, code: 'QUOTE_NOT_VERIFIED' };
  if (isTeamText(quote, ctx.teamTexts)) return { ok: false, code: 'QUOTE_IS_TEAM_TEXT' };
  return { ok: true, src };
}

/**
 * R-ISA-5: core's decision on every item of one strict model output. Pure. Denials never change state; the machine
 * applies only what is allowed.
 */
export function decideAction(out: IsaModelOutput, ctx: DecideContext): Decision {
  const d: Decision = {
    reply: null,
    replyBlocked: null,
    claims: [],
    unusableClaims: [],
    shareListings: null,
    shareCompetition: null,
    sendComps: false,
    proposeSavedSearch: false,
    offerSlots: null,
    bookSlot: null,
    slotAmbiguous: false,
    escalations: [],
    ready: null,
    followUp: null,
    endProposal: null,
    summary: null,
    denied: [],
  };
  const deny = (item: string, code: DenyCode, handles?: string[]): void => {
    d.denied.push(handles === undefined ? { item, code } : { item, code, handles });
  };
  const buyer = ctx.side === 'buyer' || ctx.side === 'both';
  const seller = ctx.side === 'seller' || ctx.side === 'both';
  const offerLive = ctx.offer !== null;

  // qualification first: readiness reads it
  out.qualification.forEach((q, k) => {
    const c = checkClientQuote(ctx, q.source, q.quote);
    if (!c.ok) return d.unusableClaims.push({ field: q.field, source: q.source, code: c.code });
    if (c.src.channel === 'email' && !c.src.ownTextReliable) return d.unusableClaims.push({ field: q.field, source: q.source, code: 'OWN_TEXT_UNRELIABLE' });
    if (!qualValueQuoted(q.field, q.value, q.quote, { ownText: c.src.text, saidAt: c.src.at, zone: ctx.zone })) return d.unusableClaims.push({ field: q.field, source: q.source, code: 'VALUE_NOT_QUOTED' });
    d.claims.push({ claimId: ctx.claimId(k), field: q.field, value: q.value, quote: q.quote, messageId: c.src.messageId, saidAt: c.src.at });
  });

  const seen = new Set<string>();
  for (const a of out.actions) {
    if (seen.has(a.type) && a.type !== 'escalate') {
      deny(a.type, 'DUPLICATE_ACTION');
      continue;
    }
    seen.add(a.type);
    switch (a.type) {
      case 'share_listings': {
        if (!buyer) deny(a.type, 'SIDE_MISMATCH');
        else if (!ctx.capabilities.has('share_listings')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (a.handles.some((h) => !ctx.listingHandles.has(h))) deny(a.type, 'HANDLE_UNKNOWN', a.handles.filter((h) => !ctx.listingHandles.has(h)));
        else d.shareListings = [...new Set(a.handles)];
        break;
      }
      case 'share_competition': {
        if (!seller) deny(a.type, 'SIDE_MISMATCH');
        else if (!ctx.capabilities.has('seller_competition')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (a.handles.some((h) => !ctx.competitionHandles.has(h))) deny(a.type, 'HANDLE_UNKNOWN', a.handles.filter((h) => !ctx.competitionHandles.has(h)));
        else d.shareCompetition = [...new Set(a.handles)];
        break;
      }
      case 'send_comps': {
        if (!seller) deny(a.type, 'SIDE_MISMATCH');
        else if (!ctx.capabilities.has('seller_sold_comps')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (ctx.heldClasses.has('pricing_negotiation')) deny(a.type, 'TOPIC_HELD');
        else if (!ctx.compsAvailable) deny(a.type, 'COMPS_UNAVAILABLE');
        else d.sendComps = true;
        break;
      }
      case 'propose_saved_search': {
        if (!buyer) deny(a.type, 'SIDE_MISMATCH');
        else if (!ctx.capabilities.has('propose_saved_search')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (!ctx.savedSearchAllowed) deny(a.type, 'SAVED_SEARCH_NOT_ALLOWED');
        else d.proposeSavedSearch = true;
        break;
      }
      case 'offer_slots': {
        const kindOk = (buyer && (a.kind === 'buyer_consult' || a.kind === 'consult')) || (seller && (a.kind === 'listing_appointment' || a.kind === 'consult'));
        if (!ctx.capabilities.has('book_appointments')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (!kindOk) deny(a.type, 'SIDE_MISMATCH');
        else if (ctx.heldClasses.has('booking_unavailable')) deny(a.type, 'TOPIC_HELD');
        else if (!ctx.calendarLive) deny(a.type, 'CALENDAR_NOT_LIVE');
        else if (offerLive) deny(a.type, 'OFFER_LIVE');
        else if (!ctx.meetRequested) deny(a.type, 'NO_MEET_REQUEST');
        else d.offerSlots = { kind: a.kind };
        break;
      }
      case 'book_slot': {
        const o = ctx.offer;
        if (!ctx.capabilities.has('book_appointments')) deny(a.type, 'CAPABILITY_NOT_AVAILABLE');
        else if (o === null || o.handle !== a.offer) deny(a.type, 'SLOT_NOT_OFFERED', [a.offer]);
        else if (o.status !== 'offered' || o.deliveredAt === null) deny(a.type, 'OFFER_NOT_DELIVERED');
        else if (a.slot > o.slots.length) deny(a.type, 'SLOT_NOT_OFFERED');
        else {
          const c = checkClientQuote(ctx, a.source, a.quote);
          if (!c.ok) deny(a.type, c.code);
          else if (c.src.at <= o.deliveredAt) deny(a.type, 'QUOTE_BEFORE_OFFER');
          else if (c.src.channel === 'email' && !c.src.ownTextReliable) deny(a.type, 'OWN_TEXT_UNRELIABLE');
          else {
            const m = matchSlotChoice(a.quote, o.slots, o.zones);
            if (m.kind !== 'unique') {
              deny(a.type, 'SLOT_AMBIGUOUS');
              d.slotAmbiguous = true;
            } else if (m.index !== a.slot - 1) deny(a.type, 'SLOT_MISMATCH');
            else if (!ctx.confirmationInTime(o.slots[m.index] as IsaSlot)) deny(a.type, 'CONFIRMATION_TOO_LATE');
            else d.bookSlot = { offer: a.offer, slotIndex: m.index, messageId: c.src.messageId, quote: a.quote };
          }
        }
        break;
      }
      case 'escalate': {
        // always allowed: it can only add. A quote ref that does not verify is dropped, never the class.
        if (!d.escalations.includes(a.class)) d.escalations.push(a.class);
        break;
      }
      case 'ready':
        break; // recomputed below from usable claims
      case 'follow_up':
        d.followUp = a.after;
        break;
      case 'end': {
        const c = checkClientQuote(ctx, a.quoteRef.source, a.quoteRef.quote);
        if (!c.ok) deny(a.type, c.code);
        else d.endProposal = { reason: a.reason, messageId: c.src.messageId };
        break;
      }
    }
  }

  // ready: core recomputes it; the model's basis is only a hint
  const asked = out.actions.find((a) => a.type === 'ready');
  if (asked !== undefined) {
    const r: ReadinessResult = readiness({
      side: ctx.side,
      now: ctx.now,
      zone: ctx.zone,
      claims: [...ctx.priorClaims, ...d.claims],
      intents: ctx.intents,
      offerLive,
      appointmentBooked: ctx.appointmentBooked,
      mlsListedElsewhere: ctx.mlsListedElsewhere,
      subjectConfirmed: ctx.subjectConfirmed,
    });
    if (r.ready) d.ready = { rule: r.rule, claimIds: r.claimIds };
    else deny('ready', offerLive ? 'OFFER_LIVE' : 'READINESS_NOT_MET');
  }

  // the reply: conversation only, never in a turn that shares facts or offers slots
  const factsTurn = d.shareListings !== null || d.shareCompetition !== null || d.sendComps || d.offerSlots !== null || d.bookSlot !== null;
  if (out.reply !== null) {
    if (factsTurn) deny('reply', 'REPLY_WITH_FACTS');
    else {
      const g = isaGuard(out.reply.text, { channel: ctx.replyChannel, identity: ctx.identity, sources: ctx.promptSources, ...(ctx.fairHousing ? { fairHousing: ctx.fairHousing } : {}) });
      if (g.pass) d.reply = { text: out.reply.text.trim() };
      else {
        deny('reply', 'GUARD_BLOCKED');
        d.replyBlocked = { codes: g.codes, fallback: g.fallback };
      }
    }
  }
  // the summary: screened, handoff card only, as "check this"
  if (out.summary !== null && out.summary.trim() !== '') {
    const g = isaGuard(out.summary, { channel: 'email', identity: ctx.identity, sources: ctx.promptSources, maxLength: ISA_OUTPUT_LIMITS.summaryMax, ...(ctx.fairHousing ? { fairHousing: ctx.fairHousing } : {}) });
    if (g.pass) d.summary = out.summary.trim();
    else deny('summary', 'SUMMARY_BLOCKED');
  }
  return d;
}
