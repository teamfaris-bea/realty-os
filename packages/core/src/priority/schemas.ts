// Zod schemas of core/priority outputs: what the API stores (priority_feed_items, exception_items)
// and serializes (GET /feed, GET /team/exceptions). They mirror the DB CHECKs (score 0..100,
// ≥ 1 reason, ≥ 1 evidence) and contain no confidence fields and no tenant id (R-AST-13, R-TEN-3).
import { z } from 'zod';
import { SOURCE_TYPES } from '../assistant/index.js';
import { EXCEPTION_TYPES, FEED_ITEM_TYPES } from './types.js';

const id = z.string().min(1);
const instantMs = z.number().int();

export const FeedReasonSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1).max(300),
  points: z.number().int().min(-100).max(100).optional(),
});

const note = z.string().min(1).max(300).optional();

export const OneTapActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept_offer'), label: z.string(), contactId: id, offerId: id }),
  z.object({ kind: z.literal('decline_offer'), label: z.string(), contactId: id, offerId: id }),
  z.object({ kind: z.literal('claim'), label: z.string(), contactId: id, pondId: id }),
  z.object({ kind: z.literal('call'), label: z.string(), contactId: id, note }),
  z.object({ kind: z.literal('text'), label: z.string(), contactId: id, draftActionId: id.optional(), note }),
  z.object({ kind: z.literal('email'), label: z.string(), contactId: id, draftActionId: id.optional(), note }),
  z.object({ kind: z.literal('reply_chat'), label: z.string(), contactId: id }),
  z.object({ kind: z.literal('send_draft'), label: z.string(), actionId: id, note }),
  z.object({ kind: z.literal('edit_draft'), label: z.string(), actionId: id }),
  z.object({ kind: z.literal('review_handback'), label: z.string(), actionId: id }),
  z.object({ kind: z.literal('complete_task'), label: z.string(), taskId: id }),
  z.object({ kind: z.literal('open_task'), label: z.string(), taskId: id }),
  z.object({ kind: z.literal('log_outcome'), label: z.string(), appointmentId: id }),
  z.object({ kind: z.literal('open_deal'), label: z.string(), dealId: id }),
  z.object({ kind: z.literal('complete_deal_date'), label: z.string(), dealDateId: id }),
  z.object({ kind: z.literal('review_search'), label: z.string(), savedSearchId: id }),
  z.object({ kind: z.literal('open_contact'), label: z.string(), contactId: id }),
  z.object({ kind: z.literal('open_listing'), label: z.string(), listingId: id }),
  z.object({ kind: z.literal('show_details'), label: z.string() }),
]);

export const FeedItemSchema = z.object({
  itemType: z.enum(FEED_ITEM_TYPES as [string, ...string[]]),
  band: z.enum(['pinned', 'scored']),
  score: z.number().int().min(0).max(100),
  scoreVersion: z.number().int().min(1),
  reasons: z.array(FeedReasonSchema).min(1),
  dueAt: instantMs.nullable(),
  dedupeKey: z.string().min(1).max(200),
  primaryAction: OneTapActionSchema,
  alternatives: z.array(OneTapActionSchema),
  contactId: id.nullable(),
  subjectType: z.enum(['contact', 'assistant_action', 'task', 'deal_date', 'appointment', 'saved_search', 'message', 'call']),
  subjectId: id,
  assistantActionId: id.nullable(),
  createdAt: instantMs,
});

const LocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transcript_offset'), startMs: z.number().int().min(0), endMs: z.number().int().min(0) }),
  z.object({ kind: z.literal('message') }),
  z.object({ kind: z.literal('char_range'), start: z.number().int().min(0), end: z.number().int().min(0) }),
  z.object({ kind: z.literal('field'), name: z.string().min(1) }),
]);

export const ExceptionEvidenceSchema = z.object({
  sourceType: z.enum(['ownership_period', 'message_status', 'deal_date', ...SOURCE_TYPES]),
  sourceId: id,
  explanation: z.string().min(1).max(300),
  at: instantMs.optional(),
  locator: LocatorSchema.optional(),
  snippet: z.string().min(1).max(500).optional(),
  predicate: z.enum(['overdue', 'unassigned']).optional(),
});

export const ExceptionItemSpecSchema = z.object({
  itemType: z.enum(EXCEPTION_TYPES as [string, ...string[]]),
  subjectType: z.enum(['contact', 'task', 'message', 'appointment', 'deal_date']),
  subjectId: id,
  contactId: id.nullable(),
  ownerUserId: id.nullable(),
  detectedAt: instantMs,
  dueAt: instantMs.nullable(),
  evidence: z.array(ExceptionEvidenceSchema).min(1),
  conditionClearedAt: instantMs.nullable(),
  ruleVersion: z.number().int().min(1),
  dedupeKey: z.string().regex(/^(untouched|promise|send|appt|milestone):/),
  withdrawnAt: instantMs.nullable().optional(),
});

export const SpeedToLeadSummarySchema = z.object({
  medianSeconds: z.number().int().min(0).nullable(),
  withinSla: z.number().int().min(0),
  total: z.number().int().min(0),
  responded: z.number().int().min(0),
  pending: z.number().int().min(0),
});
