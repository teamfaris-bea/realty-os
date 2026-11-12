// Zod schemas of api/nurture's routes (snapshot-tested: no confidence* fields, no tenant id fields).
import { z } from 'zod';

const Id = z.uuid();

export const TriggerRunSchema = z.object({
  id: Id,
  playbookId: Id,
  playbookName: z.string(),
  trigger: z.string(),
  status: z.string(),
  scheduledFor: z.string(),
  updatedAt: z.string(),
  /** the fact the alert is about: what, from where (mls | team | deal | home_valuation | deal_date), when */
  fact: z.object({ text: z.string(), source: z.string(), at: z.string() }).nullable(),
  /** a skipped run says why, in plain words (never a silent drop) */
  skip: z.object({ reason: z.string(), text: z.string() }).nullable(),
  messageId: Id.nullable(),
  assistantActionId: Id.nullable(),
});
export const TriggerRunsResponse = z.object({ runs: z.array(TriggerRunSchema) });

export const TriggerKindsResponse = z.object({
  /** `note`: what holds a kind back, in words (home values: counsel review, or no vendor on this platform) */
  triggers: z.array(z.object({ trigger: z.string(), availability: z.enum(['available', 'not_available_yet']), label: z.string(), note: z.string().nullable() })),
  templates: z.array(z.object({ key: z.string(), name: z.string(), scope: z.enum(['team', 'agent']), triggers: z.array(z.string()) })),
});

export const NURTURE_RESPONSE_SCHEMAS = { TriggerRunsResponse, TriggerKindsResponse } as const;
export const NURTURE_REQUEST_SCHEMAS = {} as const;
