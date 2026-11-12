// Read side of api/transactions (PHASE2_3_PLAN §5.4 #31; R-TXN-2, R-TXN-3, R-TXN-4, R-ACC-6; finding 8).
//
//   milestonesOfDeal   the deal's dates (status, contract date, stored instants, responsible, due_version, basis with
//                      the rule, the non-business-day note and the review state), each confirmed date's risk state from
//                      core milestoneRisk over the stored fields, and each named recipient's update status: scheduled,
//                      sent, blocked with the reason, drafted, skipped with its visible reason, or why nothing was
//                      planned (no approved Milestone updates playbook, a role the step does not name, a contact with
//                      no owner). Plus the deal's open milestone_at_risk items the caller may read (exceptions_select:
//                      tenant-wide roles, the deal owner, that owner's Team Lead; none for a TC or a co-agent).
//   board              the TC board: the caller's open deals (RLS: a TC sees the deals they are on) with proposed,
//                      upcoming and at-risk dates, in one query; at risk from milestoneRisk, not from exception_items.
// Everything is read under the caller's own RLS. No confidence, score or tenant id fields.
import { formatDue, triggerStepFor } from '@realty/core/assistant';
import { type Instant, instantFromDate } from '@realty/core/foundation';
import { type MilestoneRisk, drivesUpdates, milestoneRisk } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { storedDecisionView } from '../comms/gateInput.js';
import { approvedTriggerPlaybooks } from '../nurture/repos.js';
import { offeredTemplates } from './plan.js';
import * as R from './repos.js';
import { DEFAULT_CALENDAR_NOTE, KIND_TEXT, TRANSACTION_UPDATES } from './types.js';

const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' ? x : null);

export type UpdateStatus = 'scheduled' | 'sent' | 'blocked' | 'drafted' | 'skipped' | 'failed' | 'not_planned' | 'waiting';

export interface RecipientUpdate {
  contactId: string;
  name: string | null;
  roles: string[];
  status: UpdateStatus;
  /** plain sentence: why, when, or what happened */
  text: string;
  at: string | null;
}

export interface RiskView {
  state: 'overdue' | 'due_soon_unassigned';
  /** e.g. "Overdue", "Due within 48 h, nobody responsible" */
  text: string;
  evidence: string;
}

function riskView(r: MilestoneRisk | null): RiskView | null {
  if (r === null) return null;
  const overdue = r.predicates.includes('overdue');
  const unassigned = r.predicates.includes('due_soon_unassigned');
  const text = overdue ? (unassigned ? 'Overdue, nobody responsible' : 'Overdue') : 'Due within 48 h, nobody responsible';
  return { state: overdue ? 'overdue' : 'due_soon_unassigned', text, evidence: r.evidence };
}

interface RunInfo {
  contact_id: string;
  status: string;
  scheduled_for: Date;
  v: string | null;
  skip_text: string | null;
  message_status: string | null;
  message_reason: string | null;
  gate_decision_id: string | null;
  updated_at: Date;
}

/** The approved transaction_updates playbook's step roles (null: no approved version). */
async function playbookRoles(tx: Tx): Promise<{ approved: boolean; roles: string[]; playbookId: string | null }> {
  const p = (await approvedTriggerPlaybooks(tx)).find((x) => x.templateKey === TRANSACTION_UPDATES.templateKey && x.ref.scope === TRANSACTION_UPDATES.scope);
  if (!p) return { approved: false, roles: [], playbookId: null };
  return { approved: true, roles: [...(triggerStepFor(p.content, 'deal_date_upcoming')?.roles ?? [])], playbookId: p.ref.playbookId };
}

const ROLE_TEXT: Record<string, string> = { buyer: 'buyer', seller: 'seller', co_buyer: 'co-buyer', co_seller: 'co-seller', other: 'other', lender: 'lender', title: 'title', attorney: 'attorney' };

function recipientStatus(
  d: R.DateRow,
  c: R.DealRecipient,
  pb: { approved: boolean; roles: string[] },
  runs: RunInfo[],
  decisions: Map<string, string>,
  zone: Parameters<typeof formatDue>[2],
): Omit<RecipientUpdate, 'contactId' | 'name' | 'roles'> {
  const named = c.roles.some((r) => pb.roles.includes(r));
  const mine = runs.filter((r) => r.contact_id === c.contactId).sort((a, b) => Number(b.v) - Number(a.v) || b.updated_at.getTime() - a.updated_at.getTime());
  const cur = mine.find((r) => Number(r.v) === d.due_version) ?? null;
  if (cur !== null) {
    const at = cur.updated_at.toISOString();
    switch (cur.status) {
      case 'scheduled':
        if (cur.message_status === 'blocked') return { status: 'blocked', text: `Not sent: ${decisions.get(cur.gate_decision_id ?? '') ?? cur.message_reason ?? 'blocked at send'}`, at };
        return cur.message_status === null
          ? { status: 'scheduled', text: `Update planned for ${formatDue(instantFromDate(cur.scheduled_for), false, zone)}.`, at: cur.scheduled_for.toISOString() }
          : { status: 'scheduled', text: 'Update queued to send.', at };
      case 'sent':
        return { status: 'sent', text: 'Update sent.', at };
      case 'converted_to_draft':
        return { status: 'drafted', text: 'Update drafted: it waits for the contact owner to review it.', at };
      case 'failed':
        return { status: 'failed', text: 'The update could not be delivered.', at };
      case 'canceled_paused':
        return { status: 'skipped', text: 'Not sent: they replied, so automatic updates are paused.', at };
      default:
        if (cur.message_status === 'blocked' || cur.gate_decision_id !== null) return { status: 'blocked', text: `Not sent: ${decisions.get(cur.gate_decision_id ?? '') ?? cur.message_reason ?? 'blocked at send'}`, at };
        return { status: 'skipped', text: `Not sent: ${cur.skip_text ?? 'skipped'}`, at };
    }
  }
  if (d.status === 'proposed') return { status: 'not_planned', text: 'No update until a person confirms this date.', at: null };
  if (d.status === 'waived') return { status: 'not_planned', text: 'Waived: no update.', at: null };
  if (d.completed_at !== null) return { status: 'not_planned', text: 'Done: no update.', at: null };
  if (!named) return { status: 'not_planned', text: `No update: the Milestone updates playbook does not name the ${c.roles.map((r) => ROLE_TEXT[r] ?? r).join(' / ')} role.`, at: null };
  if (!c.live) return { status: 'not_planned', text: 'No update: this contact was merged into another record or removed.', at: null };
  if (c.ownerUserId === null) return { status: 'not_planned', text: 'No update: this contact has no owner (updates go only to owned contacts).', at: null };
  const pass = (d.basis['reminderPass'] ?? null) as { dueVersion?: unknown; reason?: unknown; at?: unknown } | null;
  if (pass !== null && num(pass.dueVersion) === d.due_version && pass.reason === 'NO_APPROVED_PLAYBOOK') {
    return { status: 'not_planned', text: 'No update was planned: no Milestone updates playbook was approved when the reminder came due.', at: str(pass.at) };
  }
  if (!pb.approved) return { status: 'not_planned', text: 'No update: the Milestone updates playbook is not approved.', at: null };
  if (d.reminder_at !== null) return { status: 'waiting', text: `Update planned for ${formatDue(instantFromDate(d.reminder_at), false, zone)}.`, at: d.reminder_at.toISOString() };
  if (d.basis['reminderRule'] === null || d.basis['reminderRule'] === undefined) return { status: 'not_planned', text: 'No reminder is set for this date.', at: null };
  return { status: 'not_planned', text: 'No update is planned for this version of the date.', at: null };
}

export async function milestonesOfDeal(tx: Tx, dealId: string, now: Instant) {
  const deal = await R.dealHead(tx, dealId);
  if (!deal) return null;
  const s = await R.txnSettings(tx);
  const [rows, recips, pb] = await Promise.all([R.datesOfDeal(tx, dealId), R.dealRecipients(tx, [dealId]), playbookRoles(tx)]);
  const recipients = recips.get(dealId) ?? [];
  const runs = await sql<RunInfo & { date_id: string }>`
    SELECT r.trigger_ref->'ref'->>'dealDateId' AS date_id, r.contact_id, r.status, r.scheduled_for, r.trigger_ref->'ref'->>'dueVersion' AS v,
           r.trigger_ref->'skip'->>'text' AS skip_text, m.status AS message_status, m.status_reason AS message_reason,
           COALESCE(m.gate_decision_id, r.last_gate_decision_id) AS gate_decision_id, r.updated_at
      FROM playbook_step_runs r LEFT JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
     WHERE r.tenant_id = app.tenant_id() AND r.enrollment_id IS NULL AND r.trigger_ref->>'trigger' = 'deal_date_upcoming'
       AND r.contact_id = ANY (${recipients.map((c) => c.contactId)}::uuid[]) AND r.trigger_ref->'ref'->>'dealId' = ${dealId}`.execute(tx);
  const decisions = new Map<string, string>();
  for (const id of new Set(runs.rows.map((r) => r.gate_decision_id).filter((x): x is string => x !== null))) {
    const v = await storedDecisionView(tx, id);
    if (v) decisions.set(id, v.explanation);
  }
  // R-ACC-6 items the caller may read (exceptions_select): none for a TC or a co-agent (the policy is not widened)
  const items = await sql<{ id: string; dedupe_key: string; detected_at: Date; cleared: boolean; evidence: unknown }>`
    SELECT e.id, e.dedupe_key, e.detected_at, e.condition_cleared_at IS NOT NULL AS cleared, e.evidence FROM exception_items e
      LEFT JOIN LATERAL (SELECT ev.action FROM exception_events ev WHERE ev.tenant_id = e.tenant_id AND ev.exception_dedupe_key = e.dedupe_key
                          ORDER BY ev.occurred_at DESC, ev.id DESC LIMIT 1) le ON true
     WHERE e.tenant_id = app.tenant_id() AND e.item_type = 'milestone_at_risk'
       AND e.dedupe_key = ANY (${rows.map((r) => `milestone:${r.id}:${r.due_version}`)}::text[])
       AND (le.action IS NULL OR le.action NOT IN ('resolved','verified'))
     ORDER BY e.detected_at, e.id`.execute(tx);
  const acceptance = rows.find((r) => r.kind === 'acceptance' && r.status !== 'waived');
  const anchor = rows.map((r) => str(r.basis['anchorDate'])).find((x) => x !== null) ?? null;
  return {
    deal: { id: deal.id, name: deal.name, side: deal.side, stage: deal.stage, ownerUserId: deal.ownerUserId },
    acceptanceDate: acceptance?.due_on ?? anchor,
    templates: offeredTemplates(s.templates, deal.side, s.jurisdictions).map((t) => ({ id: t.id, version: t.version, name: t.name, side: t.side, jurisdiction: t.jurisdiction, reviewed: t.reviewed === true })),
    calendar: { note: DEFAULT_CALENDAR_NOTE, reviewed: false as const },
    updates: { approved: pb.approved, roles: pb.roles },
    dates: rows.map((d) => {
      const core = R.coreDate(d);
      const rule = d.basis['reminderRule'] as { daysBefore?: unknown } | null | undefined;
      return {
        id: d.id,
        kind: d.kind,
        label: d.label ?? KIND_TEXT[d.kind],
        status: d.status,
        source: d.source,
        dueOn: d.due_on,
        dueAt: isoOrNull(d.due_at),
        reminderAt: isoOrNull(d.reminder_at),
        completedAt: isoOrNull(d.completed_at),
        responsible: d.responsible,
        dueVersion: d.due_version,
        confirmedByUserId: d.confirmed_by_user_id,
        drivesUpdates: drivesUpdates(core),
        basis: {
          kind: str(d.basis['kind']) ?? 'manual',
          rule: str(d.basis['rule']),
          nonBusinessDayNote: str(d.basis['nonBusinessDayNote']),
          calendarNote: d.basis['dayCount'] === 'business' ? (str(d.basis['calendarNote']) ?? DEFAULT_CALENDAR_NOTE) : null,
          templateId: str(d.basis['templateId']),
          templateVersion: num(d.basis['templateVersion']),
          templateReviewed: d.basis['kind'] === 'template' ? d.basis['templateReviewed'] === true : null,
          calendarReviewed: d.basis['dayCount'] === 'business' ? d.basis['calendarReviewed'] === true : null,
          anchorDate: str(d.basis['anchorDate']),
          zone: str(d.basis['zone']),
          reminderDaysBefore: rule && typeof rule.daysBefore === 'number' ? rule.daysBefore : num(d.basis['reminderDaysBefore']),
        },
        risk: riskView(milestoneRisk({ ...core, label: d.label ?? KIND_TEXT[d.kind] }, now)),
        updates: recipients.map((c) => ({
          contactId: c.contactId,
          name: c.name,
          roles: c.roles,
          ...recipientStatus(d, c, pb, runs.rows.filter((r) => r.date_id === d.id), decisions, s.zone),
        })),
      };
    }),
    riskItems: items.rows.map((e) => {
      const ev = Array.isArray(e.evidence) ? (e.evidence as { sourceType?: string; sourceId?: string; explanation?: string }[]) : [];
      const dd = ev.find((x) => x.sourceType === 'deal_date');
      return { id: e.id, dedupeKey: e.dedupe_key, dealDateId: dd?.sourceId ?? null, conditionCleared: e.cleared, detectedAt: e.detected_at.toISOString(), text: dd?.explanation ?? 'Milestone at risk' };
    }),
  };
}

export type DealMilestones = NonNullable<Awaited<ReturnType<typeof milestonesOfDeal>>>;

/** Days ahead the board lists confirmed dates as upcoming. */
export const BOARD_UPCOMING_DAYS = 14;

/** The TC board, in one query: the caller's open deals (RLS) with proposed, upcoming and at-risk dates. */
export async function board(tx: Tx, now: Instant) {
  const nowIso = new Date(now).toISOString();
  const r = await sql<{ deal_id: string; deal_name: string; side: string; stage: string; owner_user_id: string; id: string; kind: R.DateRow['kind']; label: string | null; due_on: string; status: R.DateRow['status']; due_at: Date | null; completed_at: Date | null; responsible: R.DateRow['responsible']; due_version: number; source: R.DateRow['source']; basis: Record<string, unknown> }>`
    SELECT d.id AS deal_id, d.name AS deal_name, d.side, d.stage, d.owner_user_id, dd.id, dd.kind, dd.label, dd.due_on::text AS due_on, dd.status, dd.due_at,
           dd.completed_at, dd.responsible, dd.due_version, dd.source, dd.basis
      FROM deals d JOIN deal_dates dd ON dd.tenant_id = d.tenant_id AND dd.deal_id = d.id
     WHERE d.tenant_id = app.tenant_id() AND d.stage NOT IN ('closed','lost') AND dd.completed_at IS NULL
       AND (dd.status = 'proposed'
            OR (dd.status = 'confirmed' AND (dd.due_at IS NULL OR dd.due_at <= ${nowIso}::timestamptz + make_interval(days => ${BOARD_UPCOMING_DAYS}))))
     ORDER BY d.expected_close_date NULLS LAST, d.id, dd.due_on, dd.id
     LIMIT 1000`.execute(tx);
  type BoardDate = { id: string; kind: string; label: string; status: R.DateRow['status']; dueOn: string; dueAt: string | null; responsible: R.DateRow['responsible']; rule: string | null; nonBusinessDayNote: string | null; risk: RiskView | null };
  const deals = new Map<string, { id: string; name: string; side: string; stage: string; ownerUserId: string; proposed: number; atRisk: number; dates: BoardDate[] }>();
  for (const x of r.rows) {
    const deal = deals.get(x.deal_id) ?? { id: x.deal_id, name: x.deal_name, side: x.side, stage: x.stage, ownerUserId: x.owner_user_id, proposed: 0, atRisk: 0, dates: [] };
    const risk = riskView(milestoneRisk({ id: x.id as never, status: x.status, completedAt: null, dueAt: x.due_at ? instantFromDate(x.due_at) : null, dueVersion: x.due_version, responsible: x.responsible, label: x.label ?? KIND_TEXT[x.kind] }, now));
    if (x.status === 'proposed') deal.proposed += 1;
    if (risk) deal.atRisk += 1;
    deal.dates.push({ id: x.id, kind: x.kind, label: x.label ?? KIND_TEXT[x.kind], status: x.status, dueOn: x.due_on, dueAt: isoOrNull(x.due_at), responsible: x.responsible, rule: str(x.basis['rule']), nonBusinessDayNote: str(x.basis['nonBusinessDayNote']), risk });
    deals.set(x.deal_id, deal);
  }
  return { deals: [...deals.values()], upcomingDays: BOARD_UPCOMING_DAYS };
}
