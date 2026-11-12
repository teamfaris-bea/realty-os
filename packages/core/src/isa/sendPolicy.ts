// The AI ISA send policy (R-ISA-8, R-ISA-9, R-ISA-10, R-ISA-11; E511, E515, E519, E520; docs/AI_ISA.md §5).
//
//   messageKind     reply or initiated, computed by core and re-derived by the guard, never taken from the app: a
//                   reply needs the person's own inbound on the same channel from the bound point, inside the reply
//                   window, after the last AI outbound on that channel, and content with no fact.
//   capsCheck       3 AI messages per 24 h; the AI yields while the person's automated + bulk total is at 3;
//                   initiated 1 per 24 h and 3 per 7 days; the 120 s gap.
//   planSend        consent per channel, the SMS-to-email fallback (ONLY after ISA_CONSENT_EVIDENCE_MISSING), the
//                   window over the zone set, the gap; a plan with `notBefore`, or why nothing can be sent.
//   ISA_REASON_CLASS the dispatch reason classes: deferrable, replan, terminal, end_care.
// D1 opt-outs are checked first and unchanged by the gate (checks 5, 6, 9); this module never relaxes them.
// VERIFY WITH COUNSEL (C-ISA-1…4) every default.
import type { ReasonCode } from '../compliance/index.js';
import { type IanaZone, type Instant, HOUR_MS, instant, maxInstant } from '../foundation/index.js';
import { ISA_CONSENT_DEFAULTS, ISA_DEFAULT_CAPS } from './constants.js';
import { type ConsentBasis, type ConsentBasisInput, type InboundEvidence, aiIsaConsentBasis } from './consent.js';
import type { IsaChannel, IsaMessageKind } from './types.js';
import { aiIsaSendWindow } from './zones.js';

export type MessageTier = 'reply' | 'initiated';

/** What a queued message holds: conversation, holding lines, an offer, a confirmation or the bot line are no fact. */
export interface MessageContent {
  kind: IsaMessageKind | 'bot_line';
  /** Any listing, competition, comp or count fact. */
  hasFact: boolean;
}

/**
 * R-ISA-9: the tier of an AI ISA message. `inbound` is the person's latest own inbound turn on THIS channel from
 * the bound point (null if none).
 */
export function messageKind(i: { now: Instant; channel: IsaChannel; boundHmac: string; content: MessageContent; inbound: InboundEvidence | null; lastAiOutboundAt: Instant | null; replyWindowHours?: number }): MessageTier {
  const r = i.inbound;
  if (i.content.hasFact || i.content.kind === 'facts') return 'initiated';
  if (r === null || r.channel !== i.channel || r.fromHmac !== i.boundHmac) return 'initiated';
  if (i.channel === 'email' && r.dkimAligned !== true) return 'initiated';
  const window = (i.replyWindowHours ?? ISA_CONSENT_DEFAULTS.replyWindowHours) * HOUR_MS;
  if (r.at > i.now || i.now - r.at > window) return 'initiated';
  if (i.lastAiOutboundAt !== null && i.lastAiOutboundAt >= r.at) return 'initiated';
  return 'reply';
}

export interface CapCounts {
  /** AI ISA messages to the person, rolling 24 h, across all their addresses (counted statuses, §5.3). */
  ai24h: number;
  /** ALL automated, bulk and marketing outbound to the person, rolling 24 h (AI ones included). */
  automated24h: number;
  initiated24h: number;
  initiated7d: number;
  lastAiOutboundAt: Instant | null;
}

export type CapCaps = typeof ISA_DEFAULT_CAPS;

/** The statuses counted toward the caps (apps/api enrollments IN_FLIGHT plus the delivered ones, §5.3). */
export const COUNTED_STATUSES = ['dispatching', 'dispatch_unknown', 'sent', 'delivered', 'failed', 'undelivered'] as const;

/** R-ISA-11: the cap codes for one send now (empty = within caps). */
export function capsCheck(c: CapCounts, tier: MessageTier, now: Instant, caps: CapCaps = ISA_DEFAULT_CAPS): ('ISA_CAP_REACHED' | 'ISA_MIN_GAP')[] {
  const out: ('ISA_CAP_REACHED' | 'ISA_MIN_GAP')[] = [];
  if (c.ai24h >= caps.ai24h || c.automated24h >= caps.automated24h || (tier === 'initiated' && (c.initiated24h >= caps.initiated24h || c.initiated7d >= caps.initiated7d))) out.push('ISA_CAP_REACHED');
  if (c.lastAiOutboundAt !== null && now - c.lastAiOutboundAt < caps.minGapSeconds * 1000) out.push('ISA_MIN_GAP');
  return out;
}

/** The earliest instant the minimum gap allows. */
export function gapReadyAt(c: Pick<CapCounts, 'lastAiOutboundAt'>, now: Instant, caps: CapCaps = ISA_DEFAULT_CAPS): Instant {
  return c.lastAiOutboundAt === null ? now : maxInstant(now, instant(c.lastAiOutboundAt + caps.minGapSeconds * 1000));
}

export interface ChannelFacts {
  channel: IsaChannel;
  boundHmac: string;
  /** Everything `aiIsaConsentBasis` needs except the tier, channel and bound point (filled in per channel). */
  consent: Omit<ConsentBasisInput, 'now' | 'channel' | 'tier' | 'boundHmac'>;
  inbound: InboundEvidence | null;
  lastAiOutboundAt: Instant | null;
}

export interface PlanInput {
  now: Instant;
  /** The channel the turn prefers (the inbound's channel for a reply; the content's first channel otherwise). */
  preferred: IsaChannel;
  /** The channels the content, the opt-in and the assignment allow, with a bound point. */
  channels: readonly ChannelFacts[];
  content: MessageContent;
  /** Sold-derived facts go by email only (§6.3). */
  emailOnly: boolean;
  zones: readonly IanaZone[];
  window: { startSec: number; endSec: number };
  initiatedDays: readonly number[];
  noInitiatedOnHolidays: boolean;
  counts: CapCounts;
  caps?: CapCaps;
  replyWindowHours?: number;
}

export type SendPlan =
  | {
      ok: true;
      channel: IsaChannel;
      tier: MessageTier;
      basis: Extract<ConsentBasis, { ok: true }>['basis'];
      /** When the message may go out: now, or the next window start / gap (status `scheduled`). */
      notBefore: Instant;
      /** Whether the email fallback was taken after SMS failed only on evidence. */
      fellBackToEmail: boolean;
      /** The deferral codes that set `notBefore` (empty when it goes now). */
      deferredBy: ('ISA_QUIET_HOURS' | 'ISA_MIN_GAP')[];
    }
  | { ok: false; codes: ReasonCode[]; consent: Partial<Record<IsaChannel, ConsentBasis>>; zoneWindowsDoNotOverlap: boolean };

function basisFor(i: PlanInput, ch: ChannelFacts): { tier: MessageTier; basis: ConsentBasis } {
  const tier = messageKind({ now: i.now, channel: ch.channel, boundHmac: ch.boundHmac, content: i.content, inbound: ch.inbound, lastAiOutboundAt: ch.lastAiOutboundAt, ...(i.replyWindowHours !== undefined ? { replyWindowHours: i.replyWindowHours } : {}) });
  const basis = aiIsaConsentBasis({ ...ch.consent, now: i.now, channel: ch.channel, tier, boundHmac: ch.boundHmac, lastInbound: ch.inbound, lastAiOutboundAt: ch.lastAiOutboundAt });
  return { tier, basis };
}

function codesOf(b: ConsentBasis): ReasonCode[] {
  if (b.ok) return [];
  const out: ReasonCode[] = [];
  if (b.missing.includes('evidence')) out.push('ISA_CONSENT_EVIDENCE_MISSING');
  if (b.missing.includes('reply_window')) out.push('ISA_REPLY_WINDOW_CLOSED');
  if (b.missing.includes('dnc')) out.push('ISA_DNC_UNVERIFIED');
  return out;
}

/**
 * The send plan of one AI ISA message (§5). The SMS-to-email fallback applies ONLY when SMS failed solely on
 * ISA_CONSENT_EVIDENCE_MISSING (never after an opt-out, suppression or stop signal: those are the gate's and end
 * care first). A plan that cannot send now is `scheduled` at `notBefore`; caps that are reached are a refusal the
 * machine defers.
 */
export function planSend(i: PlanInput): SendPlan {
  const caps = i.caps ?? ISA_DEFAULT_CAPS;
  const consent: Partial<Record<IsaChannel, ConsentBasis>> = {};
  const byChannel = new Map(i.channels.map((c) => [c.channel, c] as const));
  const order: IsaChannel[] = i.emailOnly ? ['email'] : i.preferred === 'sms' ? ['sms', 'email'] : ['email'];
  let chosen: { ch: ChannelFacts; tier: MessageTier; basis: Extract<ConsentBasis, { ok: true }> } | null = null;
  let fellBack = false;
  const codes: ReasonCode[] = [];
  for (const name of order) {
    const ch = byChannel.get(name);
    if (ch === undefined) {
      if (name === order[0]) codes.push('ISA_CHANNEL_NOT_ALLOWED');
      continue;
    }
    const { tier, basis } = basisFor(i, ch);
    consent[name] = basis;
    if (basis.ok) {
      chosen = { ch, tier, basis };
      fellBack = name === 'email' && order[0] === 'sms';
      break;
    }
    codes.push(...codesOf(basis));
    // fallback to email only after an evidence-only SMS failure
    const evidenceOnly = !basis.ok && basis.missing.length === 1 && basis.missing[0] === 'evidence' && !basis.codes.includes('CHANNEL_REVOKED');
    if (name === 'sms' && !evidenceOnly) break;
  }
  if (chosen === null) return { ok: false, codes: [...new Set(codes)], consent, zoneWindowsDoNotOverlap: false };
  const capCodes = capsCheck(i.counts, chosen.tier, i.now, caps).filter((c) => c === 'ISA_CAP_REACHED');
  if (capCodes.length > 0) return { ok: false, codes: capCodes, consent, zoneWindowsDoNotOverlap: false };
  const gapAt = gapReadyAt(i.counts, i.now, caps);
  const at = aiIsaSendWindow({ at: gapAt, zones: i.zones, startSec: i.window.startSec, endSec: i.window.endSec, initiated: chosen.tier === 'initiated', initiatedDays: i.initiatedDays, noInitiatedOnHolidays: i.noInitiatedOnHolidays });
  if (at === null) return { ok: false, codes: ['ISA_QUIET_HOURS'], consent, zoneWindowsDoNotOverlap: true };
  const deferredBy: ('ISA_QUIET_HOURS' | 'ISA_MIN_GAP')[] = [];
  if (gapAt > i.now) deferredBy.push('ISA_MIN_GAP');
  if (at > gapAt) deferredBy.push('ISA_QUIET_HOURS');
  // a reply that has to wait past its reply window becomes initiated at send time: the guard re-derives it, and
  // the turn replans then (ISA_REPLY_WINDOW_CLOSED is a replan class)
  return { ok: true, channel: chosen.ch.channel, tier: chosen.tier, basis: chosen.basis.basis, notBefore: at, fellBackToEmail: fellBack, deferredBy };
}

// ---- the dispatch reason classes (§5.4) -------------------------------------------------------------------------

export type IsaReasonClass = 'deferrable' | 'replan' | 'terminal' | 'end_care';

/** The guard's and the gate's ISA codes and what dispatch does with each. Unmapped codes are terminal. */
export const ISA_REASON_CLASS: Readonly<Record<string, IsaReasonClass>> = Object.freeze({
  ISA_QUIET_HOURS: 'deferrable',
  ISA_CAP_REACHED: 'deferrable',
  ISA_MIN_GAP: 'deferrable',
  ISA_ZONE_UNRESOLVED: 'deferrable',
  ISA_OFFSET_MISMATCH: 'deferrable',
  ISA_STALE_REPLY: 'replan',
  ISA_REPLY_WINDOW_CLOSED: 'replan',
  FACT_CHANGED: 'replan',
  // D1 opt-outs in GUARD_DENY_REASONS and the gate end care (R-ISA-31): never paused, never re-planned
  CONSENT_REVOKED: 'end_care',
  SUPPRESSED: 'end_care',
  PERSON_DO_NOT_CONTACT: 'end_care',
  WRONG_NUMBER: 'end_care',
  RECIPIENT_OPTED_OUT: 'end_care',
  RECIPIENT_SUPPRESSED: 'end_care',
  ISA_STOPPED: 'end_care',
});

export function isaReasonClass(code: string): IsaReasonClass {
  return ISA_REASON_CLASS[code] ?? 'terminal';
}

/** The class of a refusal with several codes: end_care wins, then terminal, then replan, then deferrable. */
export function refusalClass(codes: readonly string[]): IsaReasonClass {
  const rank: Record<IsaReasonClass, number> = { end_care: 0, terminal: 1, replan: 2, deferrable: 3 };
  let best: IsaReasonClass = 'deferrable';
  for (const c of codes) {
    const k = isaReasonClass(c);
    if (rank[k] < rank[best]) best = k;
  }
  return codes.length === 0 ? 'deferrable' : best;
}
