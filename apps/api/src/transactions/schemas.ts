// Zod schemas of api/transactions. Strict bodies (no tenant id is ever accepted, R-TEN-3); response schemas carry no
// confidence, score or tenant id fields (R-AST-13).
import { z } from 'zod';

const uuid = z.uuid();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const Responsible = z.enum(['buyer', 'seller', 'lender', 'title', 'agent', 'tc', 'other']);
const Role = z.string();

export const IdParams = z.object({ id: uuid });

export const PlanBody = z.strictObject({
  acceptanceDate: localDate,
  templateId: z.string().min(1).max(64),
  templateVersion: z.number().int().min(1),
});

export const ConfirmBody = z.strictObject({
  /** a different date moves it (a confirmed date's due_version bumps) */
  dueOn: localDate.optional(),
  responsible: Responsible.nullable().optional(),
  /** absent: the reminder the proposal showed (basis.reminderDaysBefore), or the last confirm's */
  reminderDaysBefore: z.number().int().min(0).max(60).nullable().optional(),
});

const RiskSchema = z.object({ state: z.enum(['overdue', 'due_soon_unassigned']), text: z.string(), evidence: z.string() }).nullable();

const UpdateSchema = z.object({
  contactId: uuid,
  name: z.string().nullable(),
  roles: z.array(Role),
  status: z.enum(['scheduled', 'sent', 'blocked', 'drafted', 'skipped', 'failed', 'not_planned', 'waiting']),
  text: z.string(),
  at: z.string().nullable(),
});

const TemplateRef = z.object({ id: z.string(), version: z.number().int(), name: z.string(), side: z.string(), jurisdiction: z.string(), reviewed: z.boolean() });

export const MilestoneDateSchema = z.object({
  id: uuid,
  kind: z.string(),
  label: z.string(),
  status: z.enum(['proposed', 'confirmed', 'waived']),
  source: z.enum(['manual', 'template', 'document', 'import']),
  dueOn: z.string(),
  dueAt: z.string().nullable(),
  reminderAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  responsible: Responsible.nullable(),
  dueVersion: z.number().int(),
  confirmedByUserId: uuid.nullable(),
  drivesUpdates: z.boolean(),
  basis: z.object({
    kind: z.string(),
    rule: z.string().nullable(),
    nonBusinessDayNote: z.string().nullable(),
    calendarNote: z.string().nullable(),
    templateId: z.string().nullable(),
    templateVersion: z.number().nullable(),
    templateReviewed: z.boolean().nullable(),
    calendarReviewed: z.boolean().nullable(),
    anchorDate: z.string().nullable(),
    zone: z.string().nullable(),
    reminderDaysBefore: z.number().nullable(),
  }),
  risk: RiskSchema,
  updates: z.array(UpdateSchema),
});

export const MilestonesResponse = z.object({
  deal: z.object({ id: uuid, name: z.string(), side: z.string(), stage: z.string(), ownerUserId: uuid }),
  acceptanceDate: z.string().nullable(),
  templates: z.array(TemplateRef),
  calendar: z.object({ note: z.string(), reviewed: z.literal(false) }),
  updates: z.object({ approved: z.boolean(), roles: z.array(Role), /** K1: the step roles this deal's side can reach (the team's side only; none on a lease deal) */ teamRoles: z.array(Role) }),
  dates: z.array(MilestoneDateSchema),
  riskItems: z.array(z.object({ id: uuid, dedupeKey: z.string(), dealDateId: z.string().nullable(), conditionCleared: z.boolean(), detectedAt: z.string(), text: z.string() })),
});

export const PlanResponse = z.object({
  template: TemplateRef,
  calendar: z.object({ source: z.string(), note: z.string(), reviewed: z.literal(false) }),
  acceptanceDate: z.string(),
  proposals: z.array(
    z.object({
      dateId: uuid,
      ruleKey: z.string(),
      kind: z.string(),
      label: z.string(),
      dueOn: z.string(),
      responsible: z.string().nullable(),
      reminderDaysBefore: z.number().nullable(),
      rule: z.string(),
      nonBusinessDayNote: z.string().nullable(),
      status: z.enum(['proposed', 'confirmed']),
    }),
  ),
  noLongerInTemplate: z.array(z.object({ dateId: uuid, ruleKey: z.string().nullable(), label: z.string(), dueOn: z.string() })),
});

export const BoardResponse = z.object({
  upcomingDays: z.number().int(),
  deals: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      side: z.string(),
      stage: z.string(),
      ownerUserId: uuid,
      proposed: z.number().int(),
      atRisk: z.number().int(),
      dates: z.array(
        z.object({
          id: uuid,
          kind: z.string(),
          label: z.string(),
          status: z.enum(['proposed', 'confirmed', 'waived']),
          dueOn: z.string(),
          dueAt: z.string().nullable(),
          responsible: Responsible.nullable(),
          rule: z.string().nullable(),
          nonBusinessDayNote: z.string().nullable(),
          risk: RiskSchema,
        }),
      ),
    }),
  ),
});

export const TemplatesResponse = z.object({
  templates: z.array(z.unknown()),
  parsed: z.array(z.object({ id: z.string(), version: z.number().int(), name: z.string(), side: z.string(), jurisdiction: z.string(), reviewed: z.boolean(), rules: z.number().int() })),
  invalid: z.array(z.object({ index: z.number().int(), error: z.string() })),
  jurisdictions: z.array(z.string()),
});

export const PutTemplatesBody = z.strictObject({ templates: z.array(z.unknown()).max(100) });

export const TRANSACTION_RESPONSE_SCHEMAS = { MilestonesResponse, PlanResponse, BoardResponse, TemplatesResponse };
