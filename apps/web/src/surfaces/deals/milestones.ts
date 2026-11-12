// Milestone types and pure helpers of the deals surface (module 39; PHASE2_3_PLAN §5.4 #31 read routes). Unit-tested.
// The server reads everything under the caller's RLS; nothing here infers a date, a rule or a risk on its own.

export type MilestoneStatus = 'proposed' | 'confirmed' | 'waived';
export type UpdateStatus = 'scheduled' | 'sent' | 'blocked' | 'drafted' | 'skipped' | 'failed' | 'not_planned' | 'waiting';

export interface RecipientUpdate {
  contactId: string;
  name: string | null;
  roles: string[];
  status: UpdateStatus;
  text: string;
  at: string | null;
}

export interface MilestoneRisk {
  state: 'overdue' | 'due_soon_unassigned';
  text: string;
  evidence: string;
}

export interface MilestoneDate {
  id: string;
  kind: string;
  label: string;
  status: MilestoneStatus;
  source: 'manual' | 'template' | 'document' | 'import';
  dueOn: string;
  dueAt: string | null;
  reminderAt: string | null;
  completedAt: string | null;
  responsible: string | null;
  dueVersion: number;
  confirmedByUserId: string | null;
  drivesUpdates: boolean;
  basis: {
    kind: string;
    rule: string | null;
    nonBusinessDayNote: string | null;
    calendarNote: string | null;
    templateId: string | null;
    templateVersion: number | null;
    templateReviewed: boolean | null;
    calendarReviewed: boolean | null;
    anchorDate: string | null;
    zone: string | null;
    reminderDaysBefore: number | null;
  };
  risk: MilestoneRisk | null;
  updates: RecipientUpdate[];
}

export interface TemplateRef {
  id: string;
  version: number;
  name: string;
  side: string;
  jurisdiction: string;
  reviewed: boolean;
}

export interface DealMilestones {
  deal: { id: string; name: string; side: string; stage: string; ownerUserId: string };
  acceptanceDate: string | null;
  templates: TemplateRef[];
  calendar: { note: string; reviewed: false };
  /** teamRoles: the step roles this deal's side can reach (K1: the other side's clients never get the team's updates) */
  updates: { approved: boolean; roles: string[]; teamRoles: string[]; side: 'buy' | 'sell' | 'dual' | 'lease' };
  dates: MilestoneDate[];
  riskItems: { id: string; dedupeKey: string; dealDateId: string | null; conditionCleared: boolean; detectedAt: string; text: string }[];
}

export interface BoardDate {
  id: string;
  kind: string;
  label: string;
  status: MilestoneStatus;
  dueOn: string;
  dueAt: string | null;
  responsible: string | null;
  rule: string | null;
  nonBusinessDayNote: string | null;
  risk: MilestoneRisk | null;
}

export interface BoardDeal {
  id: string;
  name: string;
  side: string;
  stage: string;
  ownerUserId: string;
  proposed: number;
  atRisk: number;
  dates: BoardDate[];
}

export const ROLE_LABEL: Record<string, string> = {
  buyer: 'buyer',
  seller: 'seller',
  co_buyer: 'co-buyer',
  co_seller: 'co-seller',
  other: 'other',
  lender: 'lender',
  title: 'title',
  attorney: 'attorney',
};

export const RESPONSIBLE_LABEL: Record<string, string> = { buyer: 'Buyer', seller: 'Seller', lender: 'Lender', title: 'Title', agent: 'Agent', tc: 'TC', other: 'Other' };

/** The chip a date shows: what state it is in, in plain words. */
export function statusLabel(d: Pick<MilestoneDate, 'status' | 'completedAt'>): string {
  if (d.completedAt) return 'Done';
  return d.status === 'proposed' ? 'Proposed' : d.status === 'waived' ? 'Waived' : 'Confirmed';
}

const OTHER_SIDE: Record<'buy' | 'sell', string> = { buy: 'The seller side is not this team\'s client on a buy deal, so they get none.', sell: 'The buyer side is not this team\'s client on a sell deal, so they get none.' };

/**
 * "Client updates" line: honest about whether anything is sent at all, to whom, and (K1, b8 deals ui/F1-K1) why the
 * other side of the deal gets nothing: only the roles this deal's side can reach are named.
 */
export function updatesLine(u: DealMilestones['updates']): string {
  if (!u.approved) return 'Client updates are off: the Milestone updates playbook is not approved, so no update is sent.';
  const who = u.teamRoles.map((r) => ROLE_LABEL[r] ?? r).join(', ');
  if (u.side === 'lease') {
    return u.teamRoles.length === 0
      ? 'No automatic client updates on lease deals: nobody on this deal is sent milestone updates.'
      : `Updates go to the ${who} when a confirmed date's reminder comes due. Lease clients get no automatic updates.`;
  }
  if (u.teamRoles.length === 0) return 'No client updates on this deal: the Milestone updates playbook names no role this team represents here.';
  const line = `Client updates go to the ${who} when a confirmed date's reminder comes due.`;
  return u.side === 'dual' ? `${line} The team represents both sides on this deal.` : `${line} ${OTHER_SIDE[u.side]}`;
}

/** The counsel-review warnings a plan shows (R-TXN-6, C9): never assume reviewed. */
export function reviewWarnings(m: Pick<DealMilestones, 'templates' | 'calendar'>, templateId: string | null): string[] {
  const out: string[] = [];
  const t = m.templates.find((x) => x.id === templateId) ?? null;
  if (t && !t.reviewed) out.push(`The template "${t.name}" is not reviewed by counsel. Check every date against the contract.`);
  if (!m.calendar.reviewed) out.push(m.calendar.note);
  return out;
}

/** Proposed dates first by date, then the rest by date (the timeline order). */
export function timelineOrder(dates: readonly MilestoneDate[]): MilestoneDate[] {
  return [...dates].sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.id.localeCompare(b.id)));
}

export const MILESTONE_ERROR_MESSAGES: Record<string, string> = {
  MILESTONE_TEMPLATE_NOT_FOUND: 'That template is not available for this deal any more. Pick another one.',
  MILESTONE_PLAN_OPEN: 'Another template’s proposed dates are still open on this deal. Confirm them first.',
  DATE_COMPLETED: 'This date is already marked done.',
  DATE_WAIVED: 'This date was waived.',
  DATE_HUMAN_CONFIRMATION: 'Only a person can confirm a date, as themselves.',
  REMINDER_INVALID: 'The reminder must be 0 to 60 days before the date.',
  TEMPLATE_INVALID: 'The template has an error. An Owner or Admin can fix it under Milestone templates.',
};
