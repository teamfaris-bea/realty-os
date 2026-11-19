// Zod request/response schemas of api/accountability (BUILD_PLAN module 15).
//
// R-TEN-3: no input carries a tenant id (bodies are strict, so an extra `tenant_id` is a 422).
// R-AST-13: no response carries a confidence field; exceptions explain themselves with evidence (source,
// locator, short explanation) and needs-review flags. R-ACC-4: every count travels with its denominator.
// Snapshot-tested in schemas.test.ts.
import { EXCEPTION_TYPES, TEAM_QUEUE_GROUPS } from '@realty/core/priority';
import { z } from 'zod';
import { DEDUPE_KEY_PATTERN } from './exceptions.js';
import { RANGE_KEYS } from './scoreboard.js';

const uuid = z.uuid();
const note = z.string().trim().min(1).max(500);
const ExceptionTypeSchema = z.enum(EXCEPTION_TYPES as unknown as ['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome', 'milestone_at_risk']);

// ---- exceptions ---------------------------------------------------------------------------------------

export const QueueQuery = z.strictObject({
  type: ExceptionTypeSchema.optional(),
  /** a member id, or `me` */
  owner: z.union([uuid, z.literal('me')]).optional(),
  state: z.enum(['live', 'handled', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const KeyParams = z.object({ dedupeKey: z.string().regex(new RegExp(DEDUPE_KEY_PATTERN)) });

export const ResolveBody = z.strictObject({ note, commandId: uuid.optional() });
export const VerifyBody = z.strictObject({ note: note.optional(), commandId: uuid.optional() });
export const ReopenBody = z.strictObject({ note: note.optional(), commandId: uuid.optional() });
export const ReassignBody = z.strictObject({ toUserId: uuid, note: note.optional(), commandId: uuid, expectedSeq: z.number().int().min(1).optional() });

const EvidenceLinkSchema = z.object({
  kind: z.enum(['contact', 'message', 'call', 'task', 'appointment', 'deal']),
  id: uuid,
  contactId: uuid.nullable(),
  offsetMs: z.number().int().min(0).nullable(),
});
export const EvidenceItemSchema = z.object({
  sourceType: z.string(),
  sourceId: z.string(),
  explanation: z.string().min(1),
  at: z.string().nullable(),
  locator: z.record(z.string(), z.unknown()).nullable(),
  snippet: z.string().nullable(),
  needsReview: z.boolean(),
  link: EvidenceLinkSchema.nullable(),
});
const Person = z.object({ userId: uuid, name: z.string().nullable() });
export const ExceptionEventSchema = z.object({
  action: z.enum(['resolved', 'reassigned', 'verified', 'reopened']),
  note: z.string().nullable(),
  actor: Person,
  at: z.string(),
});
export const ExceptionItemSchema = z.object({
  id: uuid,
  dedupeKey: z.string(),
  itemType: ExceptionTypeSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  contact: z.object({ id: uuid, name: z.string() }).nullable(),
  /** milestone_at_risk (b8 deals ui/F7): the deal the date belongs to, and the date's label and contract date */
  deal: z.object({ id: uuid, name: z.string(), dateLabel: z.string(), dueOn: z.string() }).nullable(),
  owner: Person.nullable(),
  detectedAt: z.string(),
  dueAt: z.string().nullable(),
  ageSeconds: z.number().int().min(0),
  conditionClearedAt: z.string().nullable(),
  live: z.boolean(),
  /** untouched_lead: the current definitions make this period no item (batch 6 review F2, F5): never live, never "fixed late" */
  withdrawn: z.boolean(),
  evidence: z.array(EvidenceItemSchema).min(1),
  /**
   * untouched_lead: whether the missed ownership period is still the lead's current one, and whether the lead left
   * its owner since (not current and not moved on: a re-inquiry started the same owner's next period, E68)
   */
  period: z.object({ current: z.boolean(), movedOn: z.boolean() }).nullable(),
  /** the contact's ownership ledger head (the reassign fence: send it back as expectedSeq) */
  contactOwnershipSeq: z.number().int().nullable(),
  latestEvent: ExceptionEventSchema.nullable(),
  actions: z.object({ resolve: z.boolean(), reassign: z.boolean(), verify: z.boolean(), reopen: z.boolean() }),
});
export const QueueResponse = z.object({
  items: z.array(ExceptionItemSchema),
  counts: z.object({
    live: z.number().int().min(0),
    byType: z.object({
      untouched_lead: z.number().int(),
      overdue_promise: z.number().int(),
      failed_send: z.number().int(),
      missing_outcome: z.number().int(),
      milestone_at_risk: z.number().int(),
    }),
  }),
  generatedAt: z.string(),
});
export const ItemResponse = z.object({ item: ExceptionItemSchema, events: z.array(ExceptionEventSchema) });

// ---- scoreboard and momentum ---------------------------------------------------------------------------

const RangeKeySchema = z.enum(RANGE_KEYS as unknown as ['today', '7d', '30d', '90d']);
export const ScoreboardQuery = z.strictObject({ userId: uuid.optional(), range: RangeKeySchema.optional() });
export const TeamScoreboardQuery = z.strictObject({ range: RangeKeySchema.optional() });

const count = z.number().int().min(0);
export const ScoreboardSchema = z.object({
  userId: uuid,
  name: z.string().nullable(),
  speedToLead: z.object({ medianSeconds: z.number().int().min(0).nullable(), withinSla: count, total: count, responded: count, pending: count }),
  touches: z.object({ count, calls: count, textsAndEmails: count, days: count }),
  appointmentsSet: z.object({ count, days: count }),
  appointmentsHeld: z.object({ count, of: count }),
  agreementsSigned: z.object({ count, days: count }),
});
const RangeSchema = z.object({ key: RangeKeySchema, from: z.string(), to: z.string(), days: count, zone: z.string() });
export const ScoreboardResponse = z.object({ range: RangeSchema, scoreboard: ScoreboardSchema });
export const TeamScoreboardResponse = z.object({ range: RangeSchema, members: z.array(ScoreboardSchema) });

const Norm = z.object({ medianDays: z.number().min(0), sample: count, enough: z.boolean() });
export const MomentumResponse = z.object({
  rule: z.object({ factor: z.number(), minSample: count, windowDays: count }),
  norms: z.array(Norm.extend({ stage: z.string() })),
  agents: z.array(
    z.object({
      userId: uuid,
      name: z.string().nullable(),
      openDeals: count,
      slowDeals: count,
      stages: z.array(
        z.object({
          stage: z.string(),
          slow: count,
          norm: Norm.nullable(),
          deals: z.array(z.object({ dealId: uuid, name: z.string(), stageEnteredAt: z.string(), dwellDays: z.number().min(0), slow: z.boolean() })),
        }),
      ),
    }),
  ),
  generatedAt: z.string(),
});

// ---- the team work queue (b19 team-queue lane; R-TEAMQ-1..6) -------------------------------------------------

/** GET /team/queue takes no input: the caller's role and teams decide the rows (R-TEN-3: never a tenant id). */
export const TeamQueueQuery = z.strictObject({});

const QueueOwnerSchema = z.object({
  kind: z.enum(['owner', 'on_offer', 'pond', 'unassigned']),
  userId: uuid.nullable(),
  name: z.string().nullable(),
  pondId: uuid.nullable(),
  label: z.string().min(1),
});
export const TeamQueueRowSchema = z.object({
  key: z.string(),
  contact: z.object({ id: uuid, name: z.string() }),
  source: z.string().nullable(),
  owner: QueueOwnerSchema,
  why: z.string().min(1),
  since: z.string(),
  waitingSeconds: count,
  staffedSeconds: count.nullable(),
  offHours: z.boolean(),
});
export const TeamQueueResponse = z.object({
  groups: z.array(
    z.object({
      key: z.enum(TEAM_QUEUE_GROUPS as unknown as ['new_lead', 'unanswered_reply', 'due_promise', 'overdue_follow_up', 'appointment_outcome']),
      label: z.string(),
      empty: z.string(),
      rows: z.array(TeamQueueRowSchema),
      total: count,
      more: count,
      atLeast: z.boolean(),
    }),
  ),
  staffedHours: z.object({ open: z.string(), close: z.string(), zone: z.string() }),
  windows: z.object({ newLeadDays: count, replyDays: count, taskDays: count, appointmentDays: count }),
  generatedAt: z.string(),
});

/** Every response schema of the module (snapshot-tested: no confidence, no tenant id). */
export const ACCOUNTABILITY_RESPONSE_SCHEMAS = {
  QueueResponse,
  ItemResponse,
  ScoreboardResponse,
  TeamScoreboardResponse,
  MomentumResponse,
  TeamQueueResponse,
} as const;
