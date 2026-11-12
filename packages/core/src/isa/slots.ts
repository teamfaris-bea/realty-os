// The appointment boundary, core part (R-ISA-13; E495, E508, E528, E529, E531; docs/AI_ISA.md §4.6).
//
//   computeOffer     up to 3 slots on different half-days from the agent's opt-in windows (their zone), the busy
//                    set read just now (live free/busy plus in-app scheduled or held appointments, each widened by
//                    the buffer), minimum notice, horizon, the client window in EVERY client zone, and nothing
//                    after `inactivity_release_at`. Plus the offer's expiry (24 h, or the first slot's notice time).
//   renderOffer      the server-rendered offer message (no model text): numbered slots with the zone label always
//                    shown, both zones when the client's explicit zone differs from the agent's.
//   matchSlotChoice  the client's own words against the offered slots: an index, a matching weekday AND time, or a
//                    matching date AND time, mapping to exactly one slot. "yes" with several slots open, "sometime
//                    Tuesday", a different time, a refusal or a reaction are ambiguous: one clarification, then
//                    `uncertain` (the machine counts).
// Core never books: the API's booking job does, with a live calendar read (§4.6 item 4).
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  type IanaZone,
  type Instant,
  instant,
  localDateOf,
  localSecondsOf,
  localTimeFromSeconds,
  localWindowContains,
  type LocalTime,
  resolveLocal,
  startOfLocalDay,
  weekdayOf,
  addLocalDays,
} from '../foundation/index.js';
import { ISA_BOOKING_DEFAULTS } from './constants.js';
import { lowerFold } from './ownText.js';
import type { IsaSlot } from './types.js';

export interface AvailabilityWindow {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** Seconds after local midnight, in the agent's zone. */
  startSec: number;
  endSec: number;
}

export interface OfferInput {
  now: Instant;
  agentZone: IanaZone;
  availability: readonly AvailabilityWindow[];
  /** Busy intervals read just now: the live calendar plus in-app scheduled and held appointments. */
  busy: readonly IsaSlot[];
  /** The conservative client zone set (`aiIsaRecipientZones`). */
  clientZones: readonly IanaZone[];
  inactivityReleaseAt: Instant | null;
  durationMinutes?: number;
  minNoticeHours?: number;
  horizonDays?: number;
  bufferMinutes?: number;
  maxSlots?: number;
  offerTtlHours?: number;
  clientWindow?: { startSec: number; endSec: number };
  /** Candidate start times step (minutes past the hour). Default 30. */
  stepMinutes?: number;
}

export interface Offer {
  slots: IsaSlot[];
  expiresAt: Instant;
}

function overlaps(a: IsaSlot, b: IsaSlot): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/** Whether [start, end) lies inside the window in every zone (the end is tested one millisecond before). */
function insideEveryZone(s: IsaSlot, zones: readonly IanaZone[], w: { startSec: number; endSec: number }): boolean {
  return zones.every((z) => localWindowContains(s.startsAt, z, w.startSec as LocalTime, w.endSec as LocalTime) && localWindowContains(instant(s.endsAt - 1), z, w.startSec as LocalTime, w.endSec as LocalTime));
}

/**
 * The slots to offer, or null when none fits (the machine raises `booking_unavailable`). Deterministic: the
 * earliest slot of each half-day (agent-local), in time order, at most `maxSlots`.
 */
export function computeOffer(i: OfferInput): Offer | null {
  const dur = (i.durationMinutes ?? ISA_BOOKING_DEFAULTS.durationMinutes) * MINUTE_MS;
  const notice = (i.minNoticeHours ?? ISA_BOOKING_DEFAULTS.minNoticeHours) * HOUR_MS;
  const horizonEnd = i.now + (i.horizonDays ?? ISA_BOOKING_DEFAULTS.horizonDays) * DAY_MS;
  const buffer = (i.bufferMinutes ?? ISA_BOOKING_DEFAULTS.bufferMinutes) * MINUTE_MS;
  const maxSlots = i.maxSlots ?? ISA_BOOKING_DEFAULTS.maxSlots;
  const step = (i.stepMinutes ?? 30) * 60;
  const clientWindow = i.clientWindow ?? ISA_BOOKING_DEFAULTS.clientWindow;
  if (i.clientZones.length === 0 || maxSlots <= 0) return null;
  const busy = i.busy.map((b) => ({ startsAt: instant(b.startsAt - buffer), endsAt: instant(b.endsAt + buffer) }));
  const earliest = i.now + notice;
  const chosen: IsaSlot[] = [];
  const halfDays = new Set<string>();
  const days = Math.ceil((horizonEnd - i.now) / DAY_MS) + 1;
  const firstDay = startOfLocalDay(i.now, i.agentZone);
  for (let d = 0; d <= days && chosen.length < maxSlots; d++) {
    const dayStart = addLocalDays(firstDay, d, i.agentZone);
    const date = localDateOf(dayStart, i.agentZone);
    const wd = weekdayOf(dayStart, i.agentZone);
    const windows = i.availability.filter((w) => w.weekday === wd).sort((a, b) => a.startSec - b.startSec);
    for (const w of windows) {
      for (let sec = Math.ceil(w.startSec / step) * step; sec + dur / 1000 <= w.endSec; sec += step) {
        const startsAt = resolveLocal(date, localTimeFromSeconds(sec), i.agentZone, 'later');
        // a DST gap can move the start: keep only starts that land on the intended wall time
        if (localSecondsOf(startsAt, i.agentZone) !== sec) continue;
        const slot: IsaSlot = { startsAt, endsAt: instant(startsAt + dur) };
        if (slot.startsAt < earliest || slot.endsAt > horizonEnd) continue;
        if (i.inactivityReleaseAt !== null && slot.endsAt > i.inactivityReleaseAt) continue;
        if (busy.some((b) => overlaps(b, slot))) continue;
        if (!insideEveryZone(slot, i.clientZones, clientWindow)) continue;
        const half = `${date}:${sec < 12 * 3600 ? 'am' : 'pm'}`;
        if (halfDays.has(half)) continue;
        halfDays.add(half);
        chosen.push(slot);
        if (chosen.length >= maxSlots) break;
      }
      if (chosen.length >= maxSlots) break;
    }
  }
  if (chosen.length === 0) return null;
  chosen.sort((a, b) => a.startsAt - b.startsAt);
  const slots = chosen.slice(0, maxSlots);
  const ttl = i.now + (i.offerTtlHours ?? ISA_BOOKING_DEFAULTS.offerTtlHours) * HOUR_MS;
  const firstNotice = (slots[0] as IsaSlot).startsAt - notice;
  return { slots, expiresAt: instant(Math.min(ttl, Math.max(i.now, firstNotice))) };
}

// ---- rendering ------------------------------------------------------------------------------------------------

const US_ZONE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'America/New_York': 'ET',
  'America/Detroit': 'ET',
  'America/Indiana/Indianapolis': 'ET',
  'America/Kentucky/Louisville': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Boise': 'MT',
  'America/Phoenix': 'MT (Arizona)',
  'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT',
  'Pacific/Honolulu': 'HT',
});

/** A short zone label: "ET", "PT" … for US zones, else the ICU short name ("GMT+10"). */
export function zoneLabel(z: IanaZone, at: Instant): string {
  const us = US_ZONE_LABEL[z];
  if (us !== undefined) return us;
  const part = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
  return part?.value ?? z;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(at: Instant, z: IanaZone): { h12: number; mm: string; ampm: 'AM' | 'PM' } {
  const s = localSecondsOf(at, z);
  const h = Math.floor(s / 3600);
  return { h12: h % 12 === 0 ? 12 : h % 12, mm: String(Math.floor((s % 3600) / 60)).padStart(2, '0'), ampm: h < 12 ? 'AM' : 'PM' };
}

/** "Tue Nov 17, 3:00–3:30 PM ET" in `z`. */
export function formatSlot(s: IsaSlot, z: IanaZone): string {
  const date = localDateOf(s.startsAt, z);
  const [, m, d] = date.split('-');
  const a = clock(s.startsAt, z);
  const b = clock(instant(s.endsAt), z);
  const range = a.ampm === b.ampm ? `${a.h12}:${a.mm}–${b.h12}:${b.mm} ${b.ampm}` : `${a.h12}:${a.mm} ${a.ampm}–${b.h12}:${b.mm} ${b.ampm}`;
  return `${DOW[weekdayOf(s.startsAt, z) - 1]} ${MON[Number(m) - 1]} ${Number(d)}, ${range} ${zoneLabel(z, s.startsAt)}`;
}

/** The display zones: the agent's, plus the client's explicit zone when it differs. */
export function displayZones(agentZone: IanaZone, clientExplicitZone: IanaZone | null): IanaZone[] {
  return clientExplicitZone !== null && clientExplicitZone !== agentZone ? [agentZone, clientExplicitZone] : [agentZone];
}

/** One numbered slot line, with both zones when they differ: "1) Tue Nov 17, 3:00–3:30 PM ET (12:00–12:30 PM PT)". */
export function slotLine(index: number, s: IsaSlot, zones: readonly IanaZone[]): string {
  const [first, ...rest] = zones;
  const main = formatSlot(s, first as IanaZone);
  const extra = rest.map((z) => formatSlot(s, z).replace(/^\w{3} \w{3} \d{1,2}, /, ''));
  return `${index + 1}) ${main}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`;
}

/** The offer message body (server-rendered; no model text, §4.6 item 2). */
export function renderOffer(i: { slots: readonly IsaSlot[]; agentFirstName: string; zones: readonly IanaZone[]; kindLabel: string }): string {
  const lines = i.slots.map((s, k) => slotLine(k, s, i.zones));
  return [`Here are times ${i.agentFirstName.trim()} is free for a ${i.kindLabel}:`, ...lines, 'Reply with the number that works for you.'].join('\n');
}

/** The confirmation (category `ai_isa_confirmation`, §4.6 item 7). No location is promised. */
export function renderConfirmation(i: { slot: IsaSlot; agentFirstName: string; zones: readonly IanaZone[]; kindLabel: string }): string {
  const when = slotLine(0, i.slot, i.zones).replace(/^1\) /, '');
  const a = i.agentFirstName.trim();
  return `You're set with ${a} on ${when} (${i.kindLabel}). ${a} will confirm the details.`;
}

// ---- matching the client's choice -------------------------------------------------------------------------------

export type SlotChoice = { kind: 'unique'; index: number } | { kind: 'ambiguous'; reason: SlotAmbiguity } | { kind: 'none' };
export type SlotAmbiguity = 'several_open' | 'no_match' | 'several_match' | 'declined' | 'reaction' | 'weekday_only' | 'several_indexes';

const ORDINALS: Readonly<Record<string, number>> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, one: 1, two: 2, three: 3 };
const WEEKDAY_RE: readonly [RegExp, number][] = [
  [/\bmon(?:day)?\b/u, 1],
  [/\btue(?:s(?:day)?)?\b/u, 2],
  [/\bwed(?:nesday)?\b/u, 3],
  [/\bthu(?:r(?:s(?:day)?)?)?\b/u, 4],
  [/\bfri(?:day)?\b/u, 5],
  [/\bsat(?:urday)?\b/u, 6],
  [/\bsun(?:day)?\b/u, 7],
];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})\/(\d{1,2})\b/u;
const DECLINE_RE = /\b(?:none|neither)\b|\b(?:doesn'?t|does\s+not|don'?t|do\s+not|won'?t|can'?t|cannot|not)\s+(?:\w+\s+)?work\b|\bnot\s+(?:good|great|free|available)\b|\bbusy\b|\bother\s+times?\b|\bdifferent\s+time\b/u;
const YES_RE = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|sounds\s+good|that\s+works|works(?:\s+for\s+me)?|perfect|great)[\s.!]*$/u;

/** A time the text names: hour 1–12 (+ optional am/pm) or 0–23 with minutes. */
function namedTimes(t: string): { h: number; m: number; ampm: 'am' | 'pm' | null }[] {
  const out: { h: number; m: number; ampm: 'am' | 'pm' | null }[] = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d/])/gu;
  for (const m of t.matchAll(re)) {
    const h = Number(m[1]);
    const mm = m[2] === undefined ? 0 : Number(m[2]);
    const ap = m[3] === undefined ? null : m[3].startsWith('a') ? 'am' : 'pm';
    // a bare digit with no ":" and no am/pm right after a weekday or "at" is a time; alone it is an index (handled before)
    if (m[2] === undefined && ap === null && !/\b(?:at|@|around|by)\s*$/u.test(t.slice(0, m.index)) && !/\b(?:mon|tue|wed|thu|fri|sat|sun)\w*\s*$/u.test(t.slice(0, m.index))) continue;
    if (h > 23 || mm > 59) continue;
    out.push({ h, m: mm, ampm: ap });
  }
  return out;
}

function timeMatches(slot: IsaSlot, z: IanaZone, want: { h: number; m: number; ampm: 'am' | 'pm' | null }): boolean {
  const s = localSecondsOf(slot.startsAt, z);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (mm !== want.m) return false;
  if (want.ampm === null) return want.h > 12 ? h === want.h : h % 12 === want.h % 12;
  const h24 = (want.h % 12) + (want.ampm === 'pm' ? 12 : 0);
  return h === h24;
}

/**
 * The slot the client's own words agree to (R-ISA-13). `zones` are the offer's display zones (what the client saw).
 * `reaction` marks a reaction to the offer message (never agreement, E529). Pure.
 */
export function matchSlotChoice(text: string, slots: readonly IsaSlot[], zones: readonly IanaZone[], o: { reaction?: boolean } = {}): SlotChoice {
  if (slots.length === 0) return { kind: 'none' };
  if (o.reaction === true) return { kind: 'ambiguous', reason: 'reaction' };
  const t = lowerFold(text).trim();
  if (t === '') return { kind: 'none' };
  if (DECLINE_RE.test(t)) return { kind: 'ambiguous', reason: 'declined' };
  // 1. an index: "2", "#2", "option 2", "number 2", "2 works", "the second one"
  const idxRe = /(?:^|\b(?:option|number|no\.?|slot|choice|#)\s*|#)\s*([1-9])(?![\d:/])(?!\s*(?:am|pm|a\.m|p\.m|:))|\b(first|1st|second|2nd|third|3rd)\b|^\s*(one|two|three)\b/gu;
  const idxs = new Set<number>();
  for (const m of t.matchAll(idxRe)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const n = /^\d$/.test(raw as string) ? Number(raw) : (ORDINALS[raw as string] as number);
    // a lone digit at the start counts; a digit elsewhere must follow an index word or "#"
    idxs.add(n);
  }
  const anyDay = WEEKDAY_RE.some(([re]) => re.test(t)) || MONTH_RE.test(t);
  if (!anyDay) for (const m of t.matchAll(/(?<![\d:/$#])\b([1-9])\b(?![\d:/]|\s*(?:am|pm|a\.m|p\.m|:))/gu)) idxs.add(Number(m[1]));
  const loneDigit = /^\s*#?\s*([1-9])\s*(?:[.!)]|works?|is\s+(?:good|great|fine|best)|please|pls|thanks?|for\s+me|sounds\s+good)?[\s.!]*$/u.exec(t);
  if (loneDigit !== null) idxs.add(Number(loneDigit[1]));
  const times = namedTimes(t);
  const weekdays = WEEKDAY_RE.filter(([re]) => re.test(t)).map(([, n]) => n);
  const date = MONTH_RE.exec(t);
  if (idxs.size > 1) return { kind: 'ambiguous', reason: 'several_indexes' };
  if (idxs.size === 1 && times.length === 0 && weekdays.length === 0 && date === null) {
    const n = [...idxs][0] as number;
    return n >= 1 && n <= slots.length ? { kind: 'unique', index: n - 1 } : { kind: 'ambiguous', reason: 'no_match' };
  }
  // 2. weekday AND time, or date AND time
  if (times.length > 0 && (weekdays.length > 0 || date !== null)) {
    const hits = new Set<number>();
    slots.forEach((s, k) => {
      for (const z of zones) {
        const dayOk = weekdays.length > 0 ? weekdays.includes(weekdayOf(s.startsAt, z)) : dateMatches(s, z, date as RegExpExecArray);
        if (dayOk && times.some((w) => timeMatches(s, z, w))) hits.add(k);
      }
    });
    if (hits.size === 1) {
      const k = [...hits][0] as number;
      // an index that disagrees with the named time is not agreement
      if (idxs.size === 1 && [...idxs][0] !== k + 1) return { kind: 'ambiguous', reason: 'several_match' };
      return { kind: 'unique', index: k };
    }
    return { kind: 'ambiguous', reason: hits.size === 0 ? 'no_match' : 'several_match' };
  }
  if (weekdays.length > 0 || date !== null) return { kind: 'ambiguous', reason: 'weekday_only' };
  if (times.length > 0) return { kind: 'ambiguous', reason: 'no_match' };
  if (YES_RE.test(t)) return slots.length === 1 ? { kind: 'unique', index: 0 } : { kind: 'ambiguous', reason: 'several_open' };
  if (idxs.size === 1) return { kind: 'ambiguous', reason: 'several_match' };
  return { kind: 'none' };
}

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dateMatches(s: IsaSlot, z: IanaZone, m: RegExpExecArray): boolean {
  const [, mo, d] = localDateOf(s.startsAt, z).split('-').map(Number) as [number, number, number];
  if (m[1] !== undefined) {
    const idx = MONTHS3.indexOf((m[1] === 'sept' ? 'sep' : m[1]).slice(0, 3));
    return idx + 1 === mo && Number(m[2]) === d;
  }
  return Number(m[3]) === mo && Number(m[4]) === d;
}

/** Whether the confirmation can go out ahead of the slot's notice: now inside the window, or the next window start. */
export function confirmationInTime(i: { slot: IsaSlot; nextSendAt: Instant | null; minNoticeHours?: number }): boolean {
  if (i.nextSendAt === null) return false;
  const notice = (i.minNoticeHours ?? ISA_BOOKING_DEFAULTS.minNoticeHours) * HOUR_MS;
  return i.nextSendAt <= i.slot.startsAt - notice;
}
