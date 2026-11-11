// Pure display helpers shared by the agent surfaces: countdowns, times, money, labels, and the
// mapping from API evidence to the design system's EvidenceRefView. No clock is read here; callers
// pass `now` (useNow), so every function is deterministic and unit-tested.
import type { ClaimView, EvidenceRefView, EvidenceSourceType } from '../../../design/index.js';
import type { ClaimApiView, DealStage, EvidenceApiView, WorkspaceEvidence } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4:59", "0:07", "1:02:03"; null once the deadline has passed. Rounds up so 0:00 means "now". */
export function formatCountdown(dueAtMs: number, nowMs: number): string | null {
  const left = dueAtMs - nowMs;
  if (left <= 0) return null;
  const total = Math.ceil(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Screen-reader form of a countdown, said in words ("4 minutes 59 seconds left"). */
export function countdownWords(dueAtMs: number, nowMs: number): string {
  const left = Math.max(0, Math.ceil((dueAtMs - nowMs) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (h === 0 && (s > 0 || parts.length === 0)) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return `${parts.join(' ')} left`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; future instants read "in 5 min". */
export function relativeTime(atMs: number, nowMs: number): string {
  const d = nowMs - atMs;
  const abs = Math.abs(d);
  const fmt = (n: number, unit: string) => (d >= 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (abs < MINUTE) return d >= 0 ? 'just now' : 'in under a minute';
  if (abs < HOUR) return fmt(Math.floor(abs / MINUTE), 'min');
  if (abs < DAY) return fmt(Math.floor(abs / HOUR), 'h');
  return fmt(Math.floor(abs / DAY), 'd');
}

/** "Thu, Nov 12, 4:00 PM" in the viewer's zone (or `zone` when given). */
export function formatDateTime(iso: string, zone?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(d);
}

/** "Nov 12" for a local date "2026-11-12" (no timezone shift). */
export function formatLocalDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Whole dollars: 42500000 → "$425,000". */
export function formatMoney(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(cents / 100));
}

/** A tel: link for an E.164 number (shown only for the agent's own reference; calls go through the bridge). */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const ITEM_LABEL: Record<string, string> = {
  lead_offer: 'New lead for you',
  first_touch_due: 'First contact due',
  unanswered_inbound: 'Waiting for your reply',
  handback: 'Replied to the assistant',
  assistant_draft: 'Draft ready',
  task_due: 'Task',
  promise_due: 'You promised this',
  deal_date: 'Contract date',
  appointment_outcome: 'How did it go?',
  reinquiry: 'Asked again',
  inactivity_warning: 'No contact in a while',
  pond_new: 'New in the pond',
  saved_search_review: 'Saved search to review',
  missed_call: 'Missed call',
  // Phase 2/3 cards, written by their owning modules (core/priority FOREIGN_CARD_LABEL, module 18a)
  seller_update: 'Seller update to review',
  marketing_review: 'Marketing to review',
  weekly_plan: 'Your plan this week',
  coaching_fix: "Today's coaching tip",
  likely_to_move: 'May be thinking of moving',
};

export function itemLabel(itemType: string): string {
  return ITEM_LABEL[itemType] ?? 'For you';
}

export const STAGE_LABEL: Record<DealStage, string> = {
  prospect: 'Prospect',
  agreement_signed: 'Agreement signed',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
};

export const STAGE_ORDER: DealStage[] = ['prospect', 'agreement_signed', 'active', 'under_contract', 'closed'];

export const INTENT_LABEL: Record<string, string> = {
  buyer: 'Buyer',
  seller: 'Seller',
  buyer_seller: 'Buyer and seller',
  renter: 'Renter',
  landlord: 'Landlord',
  investor: 'Investor',
};

export function intentLabel(intent: string | null): string | null {
  return intent ? (INTENT_LABEL[intent] ?? intent.replace(/_/g, ' ')) : null;
}

const SOURCE_TYPES = new Set<EvidenceSourceType>([
  'call',
  'message',
  'email',
  'note',
  'listing',
  'import',
  'behavior_event',
  'deal',
  'task',
  'appointment',
  'ownership_period',
  'message_status',
]);

/**
 * API evidence → the design system's EvidenceRefView. The server already formatted `label`; when the
 * snippet is withheld (transcript scope) or the source was removed under retention (E49) the label
 * becomes the explanation so the agent reads why, never an empty line.
 */
export function evidenceView(e: EvidenceApiView | WorkspaceEvidence, contactId?: string | null): EvidenceRefView {
  const sourceType = (SOURCE_TYPES.has(e.sourceType as EvidenceSourceType) ? e.sourceType : 'note') as EvidenceSourceType;
  const loc = e.locator as { kind?: string; startMs?: number; endMs?: number; start?: number; end?: number; name?: string };
  const locator =
    loc.kind === 'transcript_offset' && typeof loc.startMs === 'number'
      ? { kind: 'transcript_offset' as const, startMs: loc.startMs, endMs: typeof loc.endMs === 'number' ? loc.endMs : loc.startMs }
      : loc.kind === 'char_range' && typeof loc.start === 'number'
        ? { kind: 'char_range' as const, start: loc.start, end: typeof loc.end === 'number' ? loc.end : loc.start }
        : loc.kind === 'field' && typeof loc.name === 'string'
          ? { kind: 'field' as const, name: loc.name }
          : { kind: 'message' as const };
  const withheld = !e.sourceAvailable || e.snippet === null || e.snippet.trim() === '';
  return {
    sourceType,
    sourceId: e.sourceId,
    contactId: contactId ?? null,
    locator,
    ...(withheld ? { explanation: e.sourceAvailable ? e.label : 'Source removed under retention policy' } : { snippet: e.snippet! }),
    verified: e.verified,
  };
}

/** An API claim as the design system's ClaimView (needs-review claims stay visible, flagged). */
export function claimView(c: ClaimApiView, contactId?: string | null): ClaimView {
  const text = c.due ? `${c.text} (${c.due.display})` : c.text;
  return { text, needsReview: c.needsReview, evidence: c.evidence.map((e) => evidenceView(e, contactId)) };
}

/** First name for copy such as "Jane replied since this was drafted". */
export function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim().split(/\s+/)[0];
  return n && n.length > 0 ? n : 'They';
}

export const CALL_OUTCOMES = [
  { value: 'connected', label: 'Talked' },
  { value: 'left_voicemail', label: 'Left voicemail' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'callback_requested', label: 'Call back later' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'bad_number', label: 'Number not working' },
  { value: 'do_not_call_request', label: 'Asked not to be called' },
] as const;

export const APPOINTMENT_RESULTS = [
  { value: 'agreement_signed', label: 'Signed' },
  { value: 'follow_up', label: 'Follow up' },
  { value: 'no_decision', label: 'No decision' },
  { value: 'not_a_fit', label: 'Not a fit' },
  { value: 'no_show', label: "Didn't show" },
] as const;
