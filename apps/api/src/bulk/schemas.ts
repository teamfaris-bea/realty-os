// Zod schemas of the bulk routes (parity module 63). No tenant ids (R-TEN-3), no confidence (R-AST-13).
import { BULK_KINDS } from '@realty/core/parity/bulk';
import { z } from 'zod';

export const Kind = z.enum(BULK_KINDS as unknown as ['tag', 'untag', 'stage', 'assign', 'enroll', 'email', 'text']);

/** resolveSelection's input (PARITY_PLAN §4.2): people picked by id, a saved smart list, or an unsaved definition (a tag chip view). */
export const Selection = z.union([
  z.strictObject({ contactIds: z.array(z.uuid()).min(1).max(10_001) }),
  z.strictObject({ listId: z.uuid() }),
  z.strictObject({ definition: z.record(z.string(), z.unknown()) }),
]);

/** The list people picked by id came from (a saved list, or an unsaved definition): for a send or a plan the server reads its audience rule itself (R-PAR-8). */
export const AudienceSource = z.union([z.strictObject({ listId: z.uuid() }), z.strictObject({ definition: z.record(z.string(), z.unknown()) })]);

export const CreateBody = z.strictObject({
  kind: Kind,
  selection: Selection,
  audienceSource: AudienceSource.optional(),
  audienceTagIds: z.array(z.uuid()).max(20).optional(),
  tagId: z.uuid().optional(),
  stage: z.string().max(20).optional(),
  toUserId: z.uuid().optional(),
  playbookId: z.uuid().optional(),
  templateId: z.uuid().optional(),
  idempotencyKey: z.string().min(8).max(60).regex(/^[A-Za-z0-9_:.-]+$/),
});

const CountsSchema = z.object({
  selected: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  blocked: z.number().int(),
  failed: z.number().int(),
  canceled: z.number().int(),
  pending: z.number().int(),
  byReason: z.record(z.string(), z.number().int()),
});

export const ActionSchema = z.object({
  id: z.uuid(),
  kind: Kind,
  status: z.enum(['draft', 'confirmed', 'running', 'completed', 'canceled', 'failed']),
  mine: z.boolean(),
  selected: z.number().int(),
  targetCount: z.number().int(),
  preflight: z.record(z.string(), z.number().int()),
  sharedAddresses: z.number().int(),
  counts: CountsSchema,
  templateId: z.uuid().nullable(),
  templateVersion: z.number().int().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const ActionResponse = z.object({ action: ActionSchema });
export const ActionsResponse = z.object({ actions: z.array(ActionSchema) });

export const BatchTextBody = z.strictObject({ enabled: z.boolean(), attestation: z.string().max(300).optional() });
export const BatchTextResponse = z.object({ batchText: z.object({ enabled: z.boolean(), counselText: z.string(), attestation: z.string(), maxRecipients: z.number().int() }) });

export const RESPONSE_SCHEMAS = { ActionResponse, ActionsResponse, BatchTextResponse };
