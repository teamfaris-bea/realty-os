// POST /deals/:id/milestones/plan (PHASE2_3_PLAN §5.4 #31; R-TXN-1, R-TXN-6, E95).
//
// The acceptance date and a tenant template (id + version, from tenant_settings.milestone_templates) become
// PROPOSALS: deal_dates rows with status proposed, source template, the rule in basis and the responsible party.
// A proposal drives nothing until a person confirms it (R-TXN-1). Templates are offered for the deal's side and the
// tenant's operating jurisdictions (core templatesFor): a jurisdiction is never inferred from an address.
//
// Business days use core businessDayCalendar() defaults (Monday to Friday, no holidays, unreviewed) until counsel
// (C9) and the owner decide on tenant holiday lists; the basis says so. A date that lands on a non-business day keeps
// its date and carries the note (E95).
//
// Re-planning never deletes or waives (app_user has no DELETE on deal_dates; waived means the parties waived the
// milestone): the same template updates its still-proposed rows in place (matched by basis.templateId and
// basis.ruleKey) and inserts new rules; a proposal whose rule is gone stays and is listed as no longer in the
// template; a confirmed date is never touched. Another template's open proposals refuse the plan (MILESTONE_PLAN_OPEN).
// The acceptance anchor is kept in each proposal's basis (anchorDate), never written as a new confirmed date
// (finding 11b: it is always in the past, so a confirmed acceptance row would be overdue at once).
import type { IdGenerator, LocalDate } from '@realty/core/foundation';
import { type MilestoneTemplate, businessDayCalendar, parseMilestoneTemplates, planMilestones, templatesFor } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import * as R from './repos.js';
import { DEFAULT_CALENDAR_NOTE, DEFAULT_CALENDAR_SOURCE } from './types.js';

export interface PlanInput {
  acceptanceDate: string;
  templateId: string;
  templateVersion: number;
}

export interface PlannedRow {
  dateId: string;
  ruleKey: string;
  kind: string;
  label: string;
  dueOn: string;
  responsible: string | null;
  reminderDaysBefore: number | null;
  rule: string;
  nonBusinessDayNote: string | null;
  /** 'proposed': written or updated as a proposal now; 'confirmed': a person already confirmed it (not touched) */
  status: 'proposed' | 'confirmed';
}

export interface PlanResult {
  template: { id: string; version: number; name: string; side: string; jurisdiction: string; reviewed: boolean };
  calendar: { source: string; note: string; reviewed: false };
  acceptanceDate: string;
  proposals: PlannedRow[];
  /** proposals of this template whose rule is no longer in it (they stay: nothing can delete or withdraw them) */
  noLongerInTemplate: { dateId: string; ruleKey: string | null; label: string; dueOn: string }[];
}

/** The templates a deal may be planned with: its side, the tenant's operating jurisdictions (never inferred). */
export function offeredTemplates(raw: unknown, side: R.DealHead['side'], jurisdictions: readonly string[]): MilestoneTemplate[] {
  const { templates } = parseMilestoneTemplates(raw);
  const seen = new Set<string>();
  const out: MilestoneTemplate[] = [];
  for (const j of jurisdictions) {
    for (const t of templatesFor(templates, side, j)) {
      const k = `${t.id}@${t.version}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out;
}

export function defaultCalendar() {
  return businessDayCalendar({ source: DEFAULT_CALENDAR_SOURCE, reviewed: false });
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

export async function planInTx(tx: Tx, ids: IdGenerator, dealId: string, i: PlanInput): Promise<PlanResult> {
  const deal = await R.dealHead(tx, dealId);
  if (!deal) throw new AppError('NOT_FOUND');
  const s = await R.txnSettings(tx);
  const t = offeredTemplates(s.templates, deal.side, s.jurisdictions).find((x) => x.id === i.templateId && x.version === i.templateVersion);
  if (!t) throw new AppError('MILESTONE_TEMPLATE_NOT_FOUND', { templateId: i.templateId, templateVersion: i.templateVersion });
  const cal = defaultCalendar();
  let planned: ReturnType<typeof planMilestones>;
  try {
    planned = planMilestones({ kind: 'acceptance', date: i.acceptanceDate as LocalDate }, t, cal);
  } catch {
    throw new AppError('VALIDATION_FAILED', { reason: 'INVALID_DATE' });
  }
  if (!planned.ok) throw new AppError('TEMPLATE_INVALID', { templateId: t.id });

  // the deal's date rows, locked: re-plans of one deal serialize
  await sql`SELECT id FROM deals WHERE tenant_id = app.tenant_id() AND id = ${dealId} FOR UPDATE`.execute(tx);
  const rows = await R.datesOfDeal(tx, dealId);
  const otherOpen = rows.find((r) => r.status === 'proposed' && r.source === 'template' && str(r.basis['templateId']) !== null && str(r.basis['templateId']) !== t.id);
  if (otherOpen) throw new AppError('MILESTONE_PLAN_OPEN', { templateId: str(otherOpen.basis['templateId']) });
  const mine = rows.filter((r) => r.source === 'template' && str(r.basis['templateId']) === t.id);

  const out: PlannedRow[] = [];
  for (const p of planned.proposals) {
    const basis = {
      ...p.basis,
      calendarNote: DEFAULT_CALENDAR_NOTE,
      reminderDaysBefore: p.reminderDaysBefore,
      nonBusinessDayNote: p.nonBusinessDay?.note ?? null,
    };
    const row = { ruleKey: p.ruleKey, kind: p.kind, label: p.label, dueOn: p.dueOn, responsible: p.responsible, reminderDaysBefore: p.reminderDaysBefore, rule: p.basis.rule, nonBusinessDayNote: p.nonBusinessDay?.note ?? null };
    const existing = mine.find((r) => str(r.basis['ruleKey']) === p.ruleKey);
    if (existing && existing.status !== 'proposed') {
      // confirmed (or waived) by a person: never touched by a plan
      out.push({ ...row, dateId: existing.id, dueOn: existing.due_on, status: 'confirmed' });
      continue;
    }
    if (existing) {
      await sql`
        UPDATE deal_dates SET kind = ${p.kind}, label = ${p.label}, due_on = ${p.dueOn}::date, responsible = ${p.responsible}, basis = ${JSON.stringify(basis)}::jsonb, updated_at = now()
         WHERE tenant_id = app.tenant_id() AND id = ${existing.id} AND status = 'proposed'`.execute(tx);
      out.push({ ...row, dateId: existing.id, status: 'proposed' });
      continue;
    }
    const id = ids.next<'DealDateId'>();
    await sql`
      INSERT INTO deal_dates (tenant_id, id, deal_id, kind, label, due_on, source, status, responsible, basis)
      VALUES (app.tenant_id(), ${id}, ${dealId}, ${p.kind}, ${p.label}, ${p.dueOn}::date, 'template', 'proposed', ${p.responsible}, ${JSON.stringify(basis)}::jsonb)`.execute(tx);
    out.push({ ...row, dateId: id, status: 'proposed' });
  }
  const ruleKeys = new Set(planned.proposals.map((p) => p.ruleKey));
  const gone = mine.filter((r) => r.status === 'proposed' && !ruleKeys.has(str(r.basis['ruleKey']) ?? ''));
  return {
    template: { id: t.id, version: t.version, name: t.name, side: t.side, jurisdiction: t.jurisdiction, reviewed: t.reviewed === true },
    calendar: { source: cal.source, note: DEFAULT_CALENDAR_NOTE, reviewed: false },
    acceptanceDate: i.acceptanceDate,
    proposals: out,
    noLongerInTemplate: gone.map((r) => ({ dateId: r.id, ruleKey: str(r.basis['ruleKey']), label: r.label ?? r.kind, dueOn: r.due_on })),
  };
}
