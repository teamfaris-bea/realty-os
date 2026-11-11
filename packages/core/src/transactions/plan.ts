// Milestone plans from templates (PHASE2_3_PLAN module 30; R-TXN-1, R-TXN-6, E95).
//
// planMilestones turns an acceptance date and a tenant template into PROPOSALS. A proposal drives
// nothing (no reminder, no risk, no client update) until a person confirms it (R-TXN-1; the DB
// CHECK `deal_dates_confirmed_by_human` agrees). Each proposal shows the rule it came from, and a
// date that lands on a weekend or holiday is flagged, never silently moved (E95).
//
// Templates are tenant data (`tenant_settings.milestone_templates`), parsed here, shown as
// unreviewed until counsel reviewed them; no state's contract defaults are hard-coded (R-TXN-6,
// **VERIFY WITH COUNSEL**, C9).
import { z } from 'zod';
import { type LocalDate, fail, localDate, ok, type Result } from '../foundation/index.js';
import { MAX_OFFSET_DAYS, addBusinessDays, addCalendarDays, nonBusinessDay } from './dates.js';
import type { BusinessDayCalendar, DealSide, MilestoneKind, MilestoneTemplate, ProposedDate, TemplateBasis, TemplateRule } from './types.js';
import { MILESTONE_KINDS, RESPONSIBLE_PARTIES } from './types.js';

const KIND_LABEL: Record<MilestoneKind, string> = {
  acceptance: 'Acceptance',
  inspection: 'Inspection',
  appraisal: 'Appraisal',
  financing: 'Financing',
  closing: 'Closing',
  possession: 'Possession',
  custom: 'Milestone',
};

const RuleSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    kind: z.enum(MILESTONE_KINDS as [MilestoneKind, ...MilestoneKind[]]),
    label: z.string().trim().min(1).max(80).optional(),
    offsetDays: z.number().int().min(0).max(MAX_OFFSET_DAYS),
    dayCount: z.enum(['calendar', 'business']),
    responsible: z.enum(RESPONSIBLE_PARTIES as [string, ...string[]]).optional(),
    reminderDaysBefore: z.number().int().min(0).max(60).optional(),
  })
  .strict()
  .refine((r) => r.kind !== 'custom' || r.label !== undefined, { message: 'a custom milestone needs a label' })
  // the anchor itself is entered, never proposed from the template
  .refine((r) => r.kind !== 'acceptance', { message: 'the acceptance date is the anchor, not a rule' });

export const MilestoneTemplateSchema = z
  .object({
    id: z.string().min(1).max(64),
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(120),
    side: z.enum(['buy', 'sell', 'dual', 'lease']),
    jurisdiction: z.string().trim().min(1).max(32),
    // Absent means unreviewed: review is recorded, never assumed (R-TXN-6).
    reviewed: z.boolean().default(false),
    rules: z.array(RuleSchema).min(1).max(40),
  })
  .strict()
  .refine((t) => new Set(t.rules.map((r) => r.key)).size === t.rules.length, { message: 'rule keys must be unique' });

/**
 * Parses `tenant_settings.milestone_templates` (a jsonb array). Invalid entries are reported, not
 * dropped silently, so the admin page can say which template is broken.
 */
export function parseMilestoneTemplates(raw: unknown): { templates: MilestoneTemplate[]; invalid: { index: number; error: string }[] } {
  const templates: MilestoneTemplate[] = [];
  const invalid: { index: number; error: string }[] = [];
  if (!Array.isArray(raw)) return { templates, invalid: [{ index: -1, error: 'milestone_templates is not an array' }] };
  raw.forEach((entry, index) => {
    const r = MilestoneTemplateSchema.safeParse(entry);
    if (r.success) templates.push(r.data as MilestoneTemplate);
    else invalid.push({ index, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  });
  return { templates, invalid };
}

/** The templates for a deal's side and jurisdiction (exact match; a dual deal also sees buy and sell). */
export function templatesFor(templates: readonly MilestoneTemplate[], side: DealSide, jurisdiction: string): MilestoneTemplate[] {
  const sides: DealSide[] = side === 'dual' ? ['dual', 'buy', 'sell'] : [side];
  return templates.filter((t) => sides.includes(t.side) && t.jurisdiction === jurisdiction);
}

function ruleSentence(rule: TemplateRule, anchor: LocalDate): string {
  if (rule.offsetDays === 0) return `on the acceptance date (${anchor})`;
  const unit = rule.dayCount === 'business' ? 'business day' : 'day';
  return `${rule.offsetDays} ${unit}${rule.offsetDays === 1 ? '' : 's'} after acceptance (${anchor})`;
}

/**
 * Proposed dates for every rule of the template, ordered by due date then rule order. The returned
 * proposals carry `status: 'proposed'`; nothing is confirmed here (R-TXN-1).
 */
export function planMilestones(
  anchor: { kind: 'acceptance'; date: LocalDate },
  t: MilestoneTemplate,
  cal: BusinessDayCalendar,
): Result<{ proposals: ProposedDate[] }, 'TEMPLATE_INVALID', { error: string }> {
  const parsed = MilestoneTemplateSchema.safeParse(t);
  if (!parsed.success) return fail('TEMPLATE_INVALID', { error: parsed.error.issues.map((i) => i.message).join('; ') });
  const date = localDate(anchor.date);
  const proposals = t.rules.map((rule, order): ProposedDate & { order: number } => {
    const dueOn = rule.dayCount === 'business' ? addBusinessDays(date, rule.offsetDays, cal) : addCalendarDays(date, rule.offsetDays);
    const basis: TemplateBasis = {
      kind: 'template',
      templateId: t.id,
      templateVersion: t.version,
      templateReviewed: t.reviewed === true,
      ruleKey: rule.key,
      rule: ruleSentence(rule, date),
      anchorDate: date,
      offsetDays: rule.offsetDays,
      dayCount: rule.dayCount,
      ...(rule.dayCount === 'business' ? { calendarSource: cal.source, calendarReviewed: cal.reviewed } : {}),
    };
    return {
      order,
      status: 'proposed',
      source: 'template',
      ruleKey: rule.key,
      kind: rule.kind,
      label: rule.label ?? KIND_LABEL[rule.kind],
      dueOn,
      responsible: rule.responsible ?? null,
      reminderDaysBefore: rule.reminderDaysBefore ?? null,
      basis,
      nonBusinessDay: nonBusinessDay(dueOn, cal),
    };
  });
  proposals.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.order - b.order));
  return ok({ proposals: proposals.map(({ order: _order, ...p }) => p) });
}
