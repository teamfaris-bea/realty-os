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
  updates: { approved: boolean; roles: string[] };
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

/** "Client updates" line: honest about whether anything is sent at all, and to whom. */
export function updatesLine(u: DealMilestones['updates']): string {
  if (!u.approved) return 'Client updates are off: the Milestone updates playbook is not approved, so no update is sent.';
  return `Client updates go to the ${u.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')} when a confirmed date's reminder comes due.`;
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
