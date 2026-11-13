// Pure helpers of the AI ISA booking path (ISA-2b items 8–9; R-ISA-13; docs/AI_ISA.md §4.6). No I/O.
//
//   offerWindows   Q2: the agent's opt-in availability clipped to the team's routing hours (both in the agent's zone);
//                  with no opt-in windows, routing hours Monday–Friday. computeOffer then keeps 08:00–20:00 in every
//                  client zone. VERIFY (the defaults are engineering choices, one constant each).
//   capsClearAt    the first instant the person's rolling 24 h AI and automated counts are below the caps.
//   nextSendAt     the first instant at which the caps have cleared, the minimum gap since the last AI outbound has
//                  passed AND the send window is open (checked at that instant, not at `now`: caps that clear at
//                  20:30 wait for 08:00; batch 13 audit ISA2B-02). confirmationInTime (core) compares it with the slot's
//                  notice time (§4.6 item 3).
import type { Instant } from '@realty/core/foundation';
import type { AvailabilityWindow } from '../coreSeam.js';

/** Q2 default: with no opt-in windows, routing hours on these ISO weekdays. VERIFY. */
export const OFFER_FALLBACK_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

export interface OptInWindow {
  weekday: number;
  /** "HH:MM" in the agent's zone */
  start: string;
  end: string;
}

export const hhmmToSec = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60;
};

/** The windows computeOffer may use (Q2). Empty when the clip leaves nothing (NO_FREE_SLOT follows). */
export function offerWindows(optIn: readonly OptInWindow[], routing: { startSec: number; endSec: number }): AvailabilityWindow[] {
  const base: AvailabilityWindow[] = optIn.length > 0
    ? optIn.map((w) => ({ weekday: w.weekday, startSec: hhmmToSec(w.start), endSec: hhmmToSec(w.end) }))
    : OFFER_FALLBACK_WEEKDAYS.map((weekday) => ({ weekday, startSec: routing.startSec, endSec: routing.endSec }));
  return base
    .map((w) => ({ weekday: w.weekday, startSec: Math.max(w.startSec, routing.startSec), endSec: Math.min(w.endSec, routing.endSec) }))
    .filter((w) => w.weekday >= 1 && w.weekday <= 7 && w.endSec > w.startSec)
    .sort((a, b) => a.weekday - b.weekday || a.startSec - b.startSec);
}

const DAY = 86_400_000;

/** The first instant at or after `now` at which fewer than `cap` of `sentAt` lie in the rolling 24 h before it. */
export function capsClearAt(sentAt: readonly Instant[], cap: number, now: Instant): Instant {
  const recent = sentAt.filter((t) => t > now - DAY).sort((a, b) => a - b);
  if (recent.length < cap) return now;
  // the (len - cap)th oldest must age out: then len - cap - 1 … remain, i.e. cap - 1 < cap
  return (recent[recent.length - cap]! + DAY) as Instant;
}

export interface NextSendInput {
  now: Instant;
  /** The send window's first instant at or after `at` (aiIsaSendWindow for the confirmation, a reply); null: never. */
  windowAt: (at: Instant) => Instant | null;
  aiSentAt: readonly Instant[];
  automatedSentAt: readonly Instant[];
  caps: { ai24h: number; automated24h: number; minGapSeconds: number };
  lastAiOutboundAt: Instant | null;
}

/**
 * When a confirmation queued now could go out (null when never). Pure. The window is evaluated at the instant the
 * caps clear and the gap has passed, and the caps again at the window's opening, until both hold at one instant
 * (counts only fall as time passes, so this settles in two rounds; a value that does not settle is treated as never,
 * the conservative side: CONFIRMATION_TOO_LATE).
 */
export function nextSendAt(i: NextSendInput): Instant | null {
  let t = Math.max(i.now, i.lastAiOutboundAt === null ? i.now : i.lastAiOutboundAt + i.caps.minGapSeconds * 1000) as Instant;
  for (let k = 0; k < 8; k += 1) {
    const clear = Math.max(t, capsClearAt(i.aiSentAt, i.caps.ai24h, t), capsClearAt(i.automatedSentAt, i.caps.automated24h, t)) as Instant;
    const open = i.windowAt(clear);
    if (open === null) return null;
    if (open === clear) return open;
    t = open;
  }
  return null;
}
