// The AI ISA's recommended defaults (docs/AI_ISA.md Appendix B), each in ONE constant so a change is small.
//
// Every value here is an engineering default, not legal advice. Values marked VERIFY are placeholders the owner,
// counsel or the MLS may change; values marked VERIFY WITH COUNSEL feed a send decision (C-ISA-1…12). Team content
// (`AiIsaContent`) may only narrow them, never widen past the pack ceiling (`ISA_PACK_CEILING`).
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../foundation/index.js';

/** Stored on every turn (`ai_isa_turns.rules_version`). Bump on any change to a decision rule of core/isa. */
export const AI_ISA_RULES_VERSION = 'core-isa/1.0.0';
/** Stored on every turn (`ai_isa_turns.prompt_version`). */
export const AI_ISA_PROMPT_VERSION = 'ai_isa.turn/1';

const H = 3600;

/** Q-ISA-2: the send window, in seconds after local midnight, in EVERY possible recipient zone. VERIFY WITH COUNSEL (C-ISA-3). */
export const ISA_DEFAULT_WINDOW = Object.freeze({ startSec: 9 * H, endSec: 20 * H });
/** Q-ISA-2: initiated messages Mon–Sat (ISO weekdays), none on US federal holidays. VERIFY WITH COUNSEL (C-ISA-3). */
export const ISA_DEFAULT_INITIATED_DAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);

/** Q-ISA-3: caps (docs/AI_ISA.md §5.3). VERIFY WITH COUNSEL (C-ISA-3). */
export const ISA_DEFAULT_CAPS = Object.freeze({
  /** AI ISA messages per person, rolling 24 h, across all the person's addresses. */
  ai24h: 3,
  /** All automated, bulk and marketing outbound per person, rolling 24 h: the AI sends only while the total is below it. */
  automated24h: 3,
  initiated24h: 1,
  initiated7d: 3,
  minGapSeconds: 120,
});

/** Q-ISA-3: attempt limits. VERIFY. */
export const ISA_DEFAULT_LIMITS = Object.freeze({
  maxMessagesPerAssignment: 40,
  maxDays: 180,
  /** Unanswered initiated messages in a row before the cadence slows to `slowCadenceDays`. */
  slowAfterUnanswered: 3,
  slowCadenceDays: 14,
  /** Unanswered initiated messages in a row before care ends `dormant`. */
  dormantAfterUnanswered: 6,
  /** Undelivered messages in a row before care ends `delivery_problem`. */
  undeliveredInARow: 2,
});

/**
 * The `platform:ai_isa` pack ceilings content is validated against at approval and again at send (§3.2). VERIFY
 * WITH COUNSEL. The window ceiling is 08:00–20:00; the caps ceiling equals the defaults.
 */
export const ISA_PACK_CEILING = Object.freeze({
  window: Object.freeze({ startSec: 8 * H, endSec: 20 * H }),
  caps: ISA_DEFAULT_CAPS,
  maxMessagesPerAssignment: 40,
  maxDays: 180,
  readinessTimelineDays: 90,
  booking: Object.freeze({ minNoticeHoursFloor: 4, horizonDaysMax: 14, bufferMinutesFloor: 15, durationMinutesMax: 120 }),
});

/** Q-ISA-4: the consent rules of `platform:ai_isa` (§5.2). VERIFY WITH COUNSEL (C-ISA-1, -2, -4). */
export const ISA_CONSENT_DEFAULTS = Object.freeze({
  /** A reply is reply-tier only within this many hours of the person's own inbound. */
  replyWindowHours: 24,
  /** Initiated SMS needs a "not listed" national DNC result no older than this. */
  dncFreshnessDays: 31,
  /**
   * The D12 effective instant: a grant recorded before it never counts for the initiated tier. Null until the owner
   * confirms D12 and the pack records the date: no grant counts while it is null (strict default).
   */
  d12EffectiveAt: null as number | null,
});

/** Q-ISA-12: readiness (§4.5). VERIFY. */
export const ISA_READINESS_DEFAULTS = Object.freeze({ timelineDays: 90 });

/** Q-ISA-5: booking (§4.6). VERIFY. */
export const ISA_BOOKING_DEFAULTS = Object.freeze({
  durationMinutes: 30,
  minNoticeHours: 4,
  horizonDays: 14,
  bufferMinutes: 15,
  maxSlots: 3,
  /** An offer expires after this, or at the first slot's notice time if sooner. */
  offerTtlHours: 24,
  /** Offered slots lie inside this window in every client zone (08:00–20:00). VERIFY WITH COUNSEL. */
  clientWindow: Object.freeze({ startSec: 8 * H, endSec: 20 * H }),
});

/** §4.2 and §7.5: model and turn limits. VERIFY. */
export const ISA_TURN_LIMITS = Object.freeze({
  modelCallsPerPersonPerDay: 12,
  modelCallsPerTenantPerDay: 1_000,
  floodInbounds: 10,
  floodWindowMs: 10 * MINUTE_MS,
  /** One repair retry on a schema failure; the next failure escalates `uncertain`. */
  schemaFailuresBeforeUncertain: 2,
  /** Two guard blocks in a row escalate `uncertain`. */
  guardBlocksBeforeUncertain: 2,
  /** One clarification of an ambiguous slot answer; the next ambiguity escalates `uncertain`. */
  slotClarifications: 1,
  /** SLOT_TAKEN or SLOT_SOURCE_CHANGED twice ⇒ booking_unavailable. */
  bookingRetries: 2,
  debounceQuietMs: 20_000,
  debounceMaxDeferMs: 2 * MINUTE_MS,
  pauseExpiryMs: 72 * HOUR_MS,
  undoMs: 10_000,
  backstopMs: 10 * MINUTE_MS,
});

/** §4.3 and §7.4: model-output bounds. */
export const ISA_OUTPUT_LIMITS = Object.freeze({
  replyMax: Object.freeze({ sms: 240, email: 1_200 }),
  quoteMax: 200,
  summaryMax: 300,
  maxQualifications: 10,
  maxActions: 4,
  maxListingHandles: 3,
  maxCompetitionHandles: 3,
  /** Inbound bodies longer than this are truncated and flagged before they reach any lexicon or the prompt. */
  inboundMaxChars: 1_600,
  /** The prompt carries at most this many messages, to and from bound points only. */
  promptMessages: 20,
});

/** §6: grounding defaults. VERIFY (WITH MLS where marked in docs/AI_ISA.md). */
export const ISA_GROUNDING_DEFAULTS = Object.freeze({
  /** SMS carries listing and competition facts only when they fit this many segments (attribution included). */
  smsFactSegments: 3,
  /** A listing already sent to the person within this many days is not sent again. */
  repeatListingDays: 90,
  compsRefreshDays: 30,
  subjectRecordMaxYears: 10,
  minComps: 3,
  marketDelta: Object.freeze({ minAbs: 3, minPct: 25, minDaysBetween: 30 }),
});

/** §7.3: "Reply STOP to opt out" again on an initiated message after this much silence. VERIFY. */
export const ISA_OPT_OUT_HINT_AFTER_SILENCE_MS = 7 * DAY_MS;

/** Q-ISA-20: handoff response deadlines in business minutes. VERIFY. `normal` is the end of the next business day. */
export const ISA_SLA_MINUTES = Object.freeze({ critical: 15, high: 120 });

/** The follow-up cadence enum (§3.2). */
export const ISA_CADENCES = ['1d', '3d', '7d', '14d', '30d'] as const;
export type IsaCadence = (typeof ISA_CADENCES)[number];
export const CADENCE_MS: Readonly<Record<IsaCadence, number>> = Object.freeze({ '1d': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS, '14d': 14 * DAY_MS, '30d': 30 * DAY_MS });
