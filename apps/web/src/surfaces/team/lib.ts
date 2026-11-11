// Pure helpers of the Team surface (exception queue, scoreboard, momentum). Unit-tested.
import type { EvidenceRefView, EvidenceSourceType } from '../../design/index.js';
import { formatDays, formatDuration, formatStamp, plural } from '../admin/lib/format.js';
import type { ExceptionEvidence, ExceptionItem, ExceptionType, MomentumNorm, Scoreboard } from '../admin/lib/types.js';

export const TYPE_LABEL: Record<ExceptionType, string> = {
  untouched_lead: 'Untouched lead',
  overdue_promise: 'Overdue promise',
  failed_send: 'Message not delivered',
  missing_outcome: 'Consult missing an outcome',
};

export const TYPE_PLURAL: Record<ExceptionType, string> = {
  untouched_lead: 'Untouched leads',
  overdue_promise: 'Overdue promises',
  failed_send: 'Not delivered',
  missing_outcome: 'Missing outcomes',
};

export const TYPES: readonly ExceptionType[] = ['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome'];

const SOURCE_TYPES = new Set<EvidenceSourceType>(['call', 'message', 'email', 'note', 'listing', 'import', 'behavior_event', 'deal', 'task', 'appointment', 'ownership_period', 'message_status']);

/**
 * An untouched lead's facts belong to one ownership period: its owner's. Once the lead moved on (reassigned,
 * released), the card labels them as that owner's earlier period, so nothing reads as the new owner's.
 */
export function periodLabel(item: Pick<ExceptionItem, 'itemType' | 'owner' | 'period'>): string | null {
  if (item.itemType !== 'untouched_lead' || !item.period) return null;
  const who = item.owner?.name ?? (item.owner ? 'A former member' : 'No owner');
  return item.period.current ? `${who}'s ownership period` : `${who}'s earlier ownership period (the lead has moved on since)`;
}

/** The server's period lines, said about the period's owner (the period label already says when it ended). */
const PERIOD_LINE: Record<string, (owner: string) => string> = {
  'Lead became theirs': (o) => `Lead became ${o}'s`,
  'No human call, text or email by the first-contact deadline; the lead later left this agent': () => 'No human call, text or email by the first-contact deadline',
};

/**
 * Exception evidence (source + locator + snippet + short explanation, PII-free unless quoted) as the
 * design system's EvidenceRefView. The instant the evidence refers to is part of the explanation, so
 * "First touch was due · Nov 10, 2:14 PM" reads on its own. No score of any kind is carried over.
 * `owner`: an untouched lead's period owner, named in its period lines.
 */
export function exceptionEvidenceView(e: ExceptionEvidence, o: { owner?: string | null } = {}): EvidenceRefView {
  const sourceType = (SOURCE_TYPES.has(e.sourceType as EvidenceSourceType) ? e.sourceType : 'note') as EvidenceSourceType;
  const loc = (e.locator ?? {}) as { kind?: unknown; startMs?: unknown; endMs?: unknown; name?: unknown };
  const offset = e.link?.offsetMs ?? null;
  const locator =
    loc.kind === 'transcript_offset' && typeof loc.startMs === 'number'
      ? { kind: 'transcript_offset' as const, startMs: loc.startMs, endMs: typeof loc.endMs === 'number' ? loc.endMs : loc.startMs }
      : offset !== null
        ? { kind: 'transcript_offset' as const, startMs: offset, endMs: offset }
        : loc.kind === 'field' && typeof loc.name === 'string'
          ? { kind: 'field' as const, name: loc.name }
          : { kind: 'message' as const };
  const snippet = e.snippet?.trim();
  // an explanation that only restates the quote (the server labels quoted evidence with its quote line)
  // would show the same words twice; the quote line already says where it is from
  const restates = snippet ? e.explanation.includes(snippet) : false;
  const said = e.sourceType === 'ownership_period' && o.owner ? (PERIOD_LINE[e.explanation]?.(o.owner) ?? e.explanation) : e.explanation;
  const explanation = restates ? null : e.at ? `${said} · ${formatStamp(e.at)}` : said;
  return {
    sourceType,
    sourceId: e.link?.id ?? e.sourceId,
    contactId: e.link?.contactId ?? null,
    locator,
    ...(explanation ? { explanation } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/** "Ava Agent's · detected 3 h ago" style owner line. */
export function ownerName(item: Pick<ExceptionItem, 'owner'>): string {
  return item.owner?.name ?? (item.owner ? 'A former member' : 'No owner');
}

/** The verb a latest event is shown with. */
export const EVENT_LABEL = { resolved: 'Resolved', reassigned: 'Reassigned', verified: 'Verified', reopened: 'Reopened' } as const;

// ---- scoreboard (R-ACC-4: every number travels with its denominator) -----------------------------

/** One displayed metric: the number, what it is out of, and the words around it. */
export interface MetricLine {
  label: string;
  /** e.g. "12 of 14 within the first-touch window", "34 in 7 days" */
  text: string;
  /** a second, smaller line (e.g. the split of touches) */
  detail?: string;
}

export function daysWord(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The scoreboard as display lines. Every count says what it is out of: a share says "x of y", a
 * count over a period says "in N days", and a median says how many first touches it is the median of.
 */
export function scoreboardLines(s: Scoreboard): MetricLine[] {
  const stl = s.speedToLead;
  const median = stl.medianSeconds === null ? 'No first touches yet' : `Median ${formatDuration(stl.medianSeconds)} (of ${plural(stl.responded, 'first touch', 'first touches')})`;
  return [
    {
      label: 'Speed to lead',
      text: `${stl.withinSla} of ${stl.total} within the first-touch window`,
      detail: stl.pending > 0 ? `${median} · ${stl.pending} still waiting` : median,
    },
    { label: 'Touches', text: `${s.touches.count} in ${daysWord(s.touches.days)}`, detail: `${plural(s.touches.calls, 'call')} · ${s.touches.textsAndEmails} texts and emails` },
    { label: 'Appointments set', text: `${s.appointmentsSet.count} in ${daysWord(s.appointmentsSet.days)}` },
    { label: 'Appointments held', text: `${s.appointmentsHeld.count} of ${s.appointmentsHeld.of} held` },
    { label: 'Agreements signed', text: `${s.agreementsSigned.count} in ${daysWord(s.agreementsSigned.days)}` },
  ];
}

/** "Usually 9 days here (median of 12 deals)", or why there is no comparison yet. */
export function normLine(norm: MomentumNorm | null, minSample: number): string {
  if (!norm || !norm.enough) return `Not enough team history to compare yet (${norm?.sample ?? 0} of ${minSample} deals needed)`;
  return `Team median ${formatDays(norm.medianDays)} (of ${plural(norm.sample, 'deal')})`;
}
