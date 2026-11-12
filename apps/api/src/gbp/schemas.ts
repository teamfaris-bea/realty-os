// Zod response and request schemas of module 53 (snapshotted in gbp/snapshots.test.ts: no tenant id, no confidence,
// no reviewer matching, no contact field).
import { z } from 'zod';

export const LocationStatus = z.object({ connectionId: z.uuid(), displayName: z.string(), sentence: z.string() });
export const StatusResponse = z.object({
  status: z.object({
    state: z.enum(['not_cleared', 'not_set_up', 'not_connected', 'connected']),
    sentence: z.string(),
    locations: z.array(LocationStatus),
  }),
});

const GuardCode = z.enum(['REVIEWER_NAME', 'MONEY', 'ADDRESS', 'DATE', 'CONTACT', 'DEAL', 'FAIR_HOUSING', 'LENGTH']);
export const ReviewSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  rating: z.number().int().min(1).max(5).nullable(),
  body: z.string().nullable(),
  reviewerDisplay: z.string().nullable(),
  reviewedAt: z.string(),
  state: z.enum(['needs_reply', 'draft_waiting', 'posting', 'checking', 'replied', 'replied_outside', 'removed']),
  stateLabel: z.string(),
  draft: z.object({ actionId: z.uuid(), text: z.string(), guard: z.array(GuardCode), byAssistant: z.boolean() }).nullable(),
});
export const ReviewsQuery = z.object({ connectionId: z.uuid().optional(), filter: z.enum(['needs_reply', 'all']).default('needs_reply') }).strict();
export const ReviewsResponse = z.object({ reviews: z.object({ state: z.enum(['not_cleared', 'ready']), sentence: z.string(), reviews: z.array(ReviewSchema) }) });
export const ReviewParams = z.object({ id: z.uuid() });
export const DraftBody = z.object({ mode: z.enum(['assistant', 'manual']), text: z.string().max(5000).optional() }).strict();
export const ReplyBody = z.object({ actionId: z.uuid(), text: z.string().min(1).max(5000) }).strict();
export const DiscardBody = z.object({ actionId: z.uuid() }).strict();
export const ReviewResponse = z.object({ review: ReviewSchema });
export const ReplyResponse = z.object({ review: ReviewSchema, outcome: z.enum(['replied', 'failed', 'unknown']), sentence: z.string() });
