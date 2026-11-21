// The timing-cue scan over call transcripts: the same question the 90-day notes pilot asked of agent notes ("does this
// person say when they plan to buy or sell?"), asked of the call itself, so a call with no typed note still feeds the
// nudge list. Deterministic and local: no model, no network. A local-model pass may refine it later; this is the floor.
import type { Instant } from '../foundation/index.js';
import type { MoveIntent, Segment, TimingCue, TimingScanInput } from './types.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SEASON_START: Record<string, number> = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 };
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };

const BUY = /\b(buy|buying|bought|purchas\w*|pre-?approv\w*|looking (for|at) (a |another )?(home|house|place|condo)|find (a |our )?(home|house|place))\b/i;
const SELL = /\b(sell|selling|sold|list|listing|put (it|the house|our house|the home) on the market)\b/i;
const MOVE = /\b(mov(e|ing)|relocat\w*|pcs|orders)\b/i;
const LEASE = /\b(rent|renting|rental|lease|leasing|landlord|tenant)\b/i;
const NEGATED = /\b(not|never|no plans? to|don'?t|aren'?t|isn'?t|won'?t)\b(\s+\w+){0,3}\s+(buy|buying|sell|selling|list|listing|mov(e|ing))\b/i;

interface Window {
  match: string;
  index: number;
  months: number | null;
}

function monthOf(t: Instant): { month: number; year: number } {
  const d = new Date(t);
  return { month: d.getUTCMonth(), year: d.getUTCFullYear() };
}

function monthsUntil(callAt: Instant, targetMonth: number, targetYear: number | null): number {
  const { month, year } = monthOf(callAt);
  if (targetYear !== null) return Math.max(0, (targetYear - year) * 12 + (targetMonth - month));
  return (targetMonth - month + 12) % 12;
}

/** Every timing phrase in one piece of text, with months-from-the-call when it has a start. */
export function timingWindows(text: string, callAt: Instant): Window[] {
  const out: Window[] = [];
  const add = (re: RegExp, f: (m: RegExpExecArray) => number | null) => {
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) out.push({ match: m[0], index: m.index, months: f(m as RegExpExecArray) });
  };
  add(/\b(right away|asap|as soon as possible|immediately|this month|in the next (few|couple( of)?) weeks)\b/, () => 0);
  add(/\bin (?:the next |about |around )?(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple(?: of)?|a few) (week|month|year)s?\b/, (m) => {
    const raw = m[1]!.toLowerCase().replace(/^a (couple|few).*$/, '$1');
    const n = /^\d+$/.test(raw) ? Number(raw) : (NUM[raw] ?? null);
    if (n === null) return null;
    const unit = m[2]!.toLowerCase();
    return unit === 'week' ? Math.floor((n * 7) / 30) : unit === 'month' ? n : n * 12;
  });
  add(/\b(next|this) (month|year|spring|summer|fall|autumn|winter)\b/, (m) => {
    const which = m[1]!.toLowerCase();
    const what = m[2]!.toLowerCase();
    const { month } = monthOf(callAt);
    if (what === 'month') return which === 'next' ? 1 : 0;
    if (what === 'year') return which === 'next' ? 12 - month : 0;
    const start = SEASON_START[what]!;
    const until = (start - month + 12) % 12;
    // "next spring" said in spring means a year out; "this spring" said in late spring is now
    return which === 'next' && until === 0 ? 12 : until;
  });
  add(/\b(?:end of (?:the |this )?year|after the holidays|first of the year|new year)\b/, (m) => {
    const { month } = monthOf(callAt);
    return /end of/i.test(m[0]) ? Math.max(0, 11 - month) : 12 - month;
  });
  add(new RegExp(`\\b(?:by|in|around|before|after|until|end of|early|late|mid)\\s+(${MONTHS.join('|')})(?:,?\\s+(20\\d{2}))?\\b`), (m) =>
    monthsUntil(callAt, MONTHS.indexOf(m[1]!.toLowerCase()), m[2] ? Number(m[2]) : null),
  );
  add(/\b(?:in|by|early|late|mid)\s+(20\d{2})\b/, (m) => {
    const { year, month } = monthOf(callAt);
    const y = Number(m[1]);
    return y <= year ? 0 : (y - year) * 12 - month;
  });
  return out.sort((a, b) => a.index - b.index);
}

export function intentOf(text: string): MoveIntent | null {
  if (NEGATED.test(text) && !BUY.test(text.replace(NEGATED, '')) && !SELL.test(text.replace(NEGATED, ''))) return null;
  const buy = BUY.test(text);
  const sell = SELL.test(text);
  if (buy && sell) return 'both';
  if (buy) return 'buy';
  if (sell) return 'sell';
  return MOVE.test(text) ? 'unclear' : null;
}

/** Which segments the scan reads: the client's own words when the recording separates speakers, otherwise all of them. */
export function scannedSegments(segments: readonly Segment[]): Segment[] {
  const labelled = segments.some((s) => s.speaker === 'client');
  return segments.filter((s) => !labelled || s.speaker === 'client');
}

/**
 * Timing cues in one call. A cue needs a timing phrase AND a buy/sell/move statement in the same segment or the one
 * just before it from the same speaker ("We're thinking about selling." / "Probably next spring."). One cue per segment
 * (the earliest window). Lease talk is kept but flagged and never counts as a buy or sell cue.
 */
export function timingCues(input: TimingScanInput): TimingCue[] {
  const segs = scannedSegments(input.segments);
  const out: TimingCue[] = [];
  segs.forEach((s, i) => {
    const windows = timingWindows(s.text, input.callAt);
    if (windows.length === 0) return;
    const prev = i > 0 && segs[i - 1]!.speaker === s.speaker ? segs[i - 1]!.text : '';
    const own = intentOf(s.text);
    const before = prev ? intentOf(prev) : null;
    // a bare "once the orders come through" is a move; the buy/sell the same speaker just stated is more specific
    const intent = own === null || (own === 'unclear' && before !== null) ? before : own;
    if (intent === null) return;
    const leaseContext = LEASE.test(s.text) || (prev !== '' && LEASE.test(prev) && intentOf(s.text) === null);
    const known = windows.filter((w) => w.months !== null);
    const horizon = known.length > 0 ? Math.min(...known.map((w) => w.months!)) : null;
    out.push({
      quote: s.text.trim(),
      startMs: s.startMs,
      endMs: s.endMs,
      speaker: s.speaker,
      intent: leaseContext && intent !== 'sell' && intent !== 'both' ? 'unclear' : intent,
      horizonMonths: horizon,
      withinSixMonths: !leaseContext && horizon !== null && horizon <= 6,
      leaseContext,
    });
  });
  return out;
}

/** The single cue the nudge list ranks a call by: the nearest buy/sell window within six months, else null. */
export function nearestActionableCue(cues: readonly TimingCue[]): TimingCue | null {
  const ok = cues.filter((c) => c.withinSixMonths && c.intent !== 'unclear');
  return ok.reduce<TimingCue | null>((best, c) => (best === null || c.horizonMonths! < best.horizonMonths! ? c : best), null);
}
