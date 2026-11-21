// The ranked internal nudge list per agent (DATA_MODEL R-TCUE-6, R-TCUE-7), exactly the notes pilot's Monday list:
// classified against TODAY (the caller's local date in the team's zone), never stored, so a window that was live last
// week is a check-in this week without a re-scan. Internal only: it names the agent's own people for the agent to
// call; nothing here sends, assigns or changes a stage. Pure.
import type { CueEvidence, CueIntent, MoveWindow, NudgeClass, NudgeDrop } from './types.js';
import { addMonths } from './window.js';

/** LIVE reaches this many months past today (the pilot: "now through about 6 months out"). */
export const LIVE_HORIZON_MONTHS = 6;
/** A PAST_WINDOW check-in is offered while the window ended at most this many months ago (the pilot's 18-month scan). */
export const PAST_WINDOW_LOOKBACK_MONTHS = 18;

/** contacts.stage values that take a person off the list (the pilot's Trash / Closed / under-contract filter). */
const DROP_STAGE: Record<string, NudgeDrop> = { closed: 'closed', lost: 'lost', under_contract: 'under_contract' };

export interface NudgeCueInput {
  contactId: string;
  /** first name only: the list never carries last names, numbers, emails or addresses */
  firstName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  /** contacts.stage */
  stage: string;
  /** the person asked not to be contacted (contacts.do_not_contact_at) */
  doNotContact: boolean;
  /** a deal or listing reached listed / under contract / closed AFTER the words were written */
  laterTransaction: boolean;
  /** contacts.last_human_touch_at as ISO text, or null: notes, drafts, automated, assistant and bulk mail never count (R-OWN-14) */
  lastHumanTouchAt: string | null;
  /** the source of the cue (a note id) */
  sourceId: string;
  /** the day the words were written, 'YYYY-MM-DD' in the team's zone */
  writtenOn: string;
  intent: CueIntent;
  evidence: CueEvidence;
  snippet: string;
  window: Pick<MoveWindow, 'start' | 'end' | 'label' | 'precision'>;
}

export type Classified = { drop: NudgeDrop } | { cls: NudgeClass };

/** R-TCUE-6: one person's class today. Drops first, then STALE (it already happened), then the window against today. */
export function classifyCue(i: Pick<NudgeCueInput, 'stage' | 'doNotContact' | 'laterTransaction' | 'window'>, today: string): Classified {
  const stageDrop = DROP_STAGE[i.stage];
  if (stageDrop) return { drop: stageDrop };
  if (i.doNotContact) return { drop: 'do_not_contact' };
  if (i.laterTransaction) return { cls: 'STALE' };
  if (i.window.end < today) return { cls: i.window.end >= addMonths(today, -PAST_WINDOW_LOOKBACK_MONTHS) ? 'PAST_WINDOW' : 'EXPIRED' };
  if (i.window.start <= addMonths(today, LIVE_HORIZON_MONTHS)) return { cls: 'LIVE' };
  return { cls: 'LATER' };
}

const INTENT_ORDER: Record<CueIntent, number> = { sell: 0, both: 1, buy: 2, unknown: 3 };

export interface NudgeItem {
  contactId: string;
  firstName: string | null;
  intent: CueIntent;
  evidence: CueEvidence;
  snippet: string;
  window: { start: string; end: string; label: string; inWindowNow: boolean };
  writtenOn: string;
  sourceId: string;
  lastHumanTouchAt: string | null;
  stage: string;
  /** LIVE: call today; PAST_WINDOW: ask whether the plan still stands; STALE: nothing (shown so the agent sees why) */
  ask: 'call_today' | 'check_in' | 'none';
}

export interface AgentNudges {
  ownerUserId: string | null;
  ownerName: string | null;
  live: NudgeItem[];
  pastWindow: NudgeItem[];
  stale: NudgeItem[];
}

export interface NudgeList {
  today: string;
  horizonEnd: string;
  counts: { people: number; live: number; pastWindow: number; stale: number; later: number; expired: number; dropped: Record<NudgeDrop, number> };
  /** agents with at least one LIVE or PAST_WINDOW person: most LIVE first, then most check-ins, then name */
  agents: AgentNudges[];
}

/** The most recent cue per person (the latest words win; a later note supersedes an earlier plan). */
function latestPerPerson(cues: readonly NudgeCueInput[]): NudgeCueInput[] {
  const by = new Map<string, NudgeCueInput>();
  for (const c of cues) {
    const prev = by.get(c.contactId);
    if (!prev || c.writtenOn > prev.writtenOn || (c.writtenOn === prev.writtenOn && c.sourceId > prev.sourceId)) by.set(c.contactId, c);
  }
  return [...by.values()];
}

/** R-TCUE-7 LIVE order: open now first, then the soonest start, sellers before both before buyers, then the longest since a human touch (never touched first). */
export function compareLive(today: string) {
  return (a: NudgeCueInput, b: NudgeCueInput): number => {
    const ao = a.window.start <= today ? 0 : 1;
    const bo = b.window.start <= today ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (ao === 1 && a.window.start !== b.window.start) return a.window.start < b.window.start ? -1 : 1;
    if (INTENT_ORDER[a.intent] !== INTENT_ORDER[b.intent]) return INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent];
    if (a.lastHumanTouchAt !== b.lastHumanTouchAt) {
      if (a.lastHumanTouchAt === null) return -1;
      if (b.lastHumanTouchAt === null) return 1;
      return a.lastHumanTouchAt < b.lastHumanTouchAt ? -1 : 1;
    }
    return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
  };
}

/** PAST_WINDOW and STALE order: the most recent words first. */
function compareRecent(a: NudgeCueInput, b: NudgeCueInput): number {
  if (a.writtenOn !== b.writtenOn) return a.writtenOn > b.writtenOn ? -1 : 1;
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
}

function item(c: NudgeCueInput, today: string, ask: NudgeItem['ask']): NudgeItem {
  return {
    contactId: c.contactId,
    firstName: c.firstName,
    intent: c.intent,
    evidence: c.evidence,
    snippet: c.snippet,
    window: { start: c.window.start, end: c.window.end, label: c.window.label, inWindowNow: c.window.start <= today && today <= c.window.end },
    writtenOn: c.writtenOn,
    sourceId: c.sourceId,
    lastHumanTouchAt: c.lastHumanTouchAt,
    stage: c.stage,
    ask,
  };
}

/** Builds today's list from every stored cue the reader may see. */
export function buildNudgeList(i: { today: string; cues: readonly NudgeCueInput[] }): NudgeList {
  const dropped: Record<NudgeDrop, number> = { closed: 0, lost: 0, under_contract: 0, do_not_contact: 0 };
  const counts = { people: 0, live: 0, pastWindow: 0, stale: 0, later: 0, expired: 0, dropped };
  const groups = new Map<string, { ownerUserId: string | null; ownerName: string | null; live: NudgeCueInput[]; past: NudgeCueInput[]; stale: NudgeCueInput[] }>();
  for (const c of latestPerPerson(i.cues)) {
    counts.people++;
    const k = classifyCue(c, i.today);
    if ('drop' in k) {
      dropped[k.drop]++;
      continue;
    }
    if (k.cls === 'LATER') {
      counts.later++;
      continue;
    }
    if (k.cls === 'EXPIRED') {
      counts.expired++;
      continue;
    }
    const key = c.ownerUserId ?? '';
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ownerUserId: c.ownerUserId, ownerName: c.ownerName, live: [], past: [], stale: [] }));
    if (k.cls === 'LIVE') {
      counts.live++;
      g.live.push(c);
    } else if (k.cls === 'PAST_WINDOW') {
      counts.pastWindow++;
      g.past.push(c);
    } else {
      counts.stale++;
      g.stale.push(c);
    }
  }
  const agents: AgentNudges[] = [...groups.values()]
    .filter((g) => g.live.length + g.past.length > 0)
    .map((g) => ({
      ownerUserId: g.ownerUserId,
      ownerName: g.ownerName,
      live: [...g.live].sort(compareLive(i.today)).map((c) => item(c, i.today, 'call_today')),
      pastWindow: [...g.past].sort(compareRecent).map((c) => item(c, i.today, 'check_in')),
      stale: [...g.stale].sort(compareRecent).map((c) => item(c, i.today, 'none')),
    }))
    .sort((a, b) => b.live.length - a.live.length || b.pastWindow.length - a.pastWindow.length || (a.ownerName ?? '\uffff').localeCompare(b.ownerName ?? '\uffff') || (a.ownerUserId ?? '').localeCompare(b.ownerUserId ?? ''));
  return { today: i.today, horizonEnd: addMonths(i.today, LIVE_HORIZON_MONTHS), counts, agents };
}
