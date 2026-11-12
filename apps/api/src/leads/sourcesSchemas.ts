// Response and body schemas of the Lead sources routes (module 22; DATA_MODEL R-LSRC-1..5). No confidence or score
// field and no tenant id in any response (R-AST-13, R-TEN-3; matrix.test.ts checks LEAD_SOURCES_RESPONSE_SCHEMAS).
import { z } from 'zod';
import { ConsentDisclosureInput } from './schemas.js';

const Id = z.uuid();
const Iso = z.string();

export const PathState = z.enum(['on', 'off', 'not_available']);

export const SourceOverview = z.object({
  id: Id,
  name: z.string(),
  kind: z.string(),
  active: z.boolean(),
  createdAt: Iso,
  /** active_changed_at while the source is off */
  offSince: Iso.nullable(),
  lastLeadAt: Iso.nullable(),
  leadsLast30Days: z.number().int(),
  heldEmails: z.number().int(),
  forwardingConfirmations: z.number().int(),
  /** partner-feed leads skipped because the source was off, in the last 30 days (R-LSRC-2, E597) */
  skippedWhileOffLast30Days: z.number().int(),
  paths: z.object({
    email: z.object({ state: PathState, address: z.string().nullable(), lastEmailAt: Iso.nullable() }),
    webhook: z.object({ hasToken: z.boolean(), ownSecret: z.boolean(), secretCreatedAt: Iso.nullable() }),
    googleLeadForm: z.object({
      state: PathState,
      createdAt: Iso.nullable(),
      inquiryType: z.string().nullable(),
      citesSourceDisclosure: z.boolean().nullable(),
      lastTestAt: Iso.nullable(),
      lastUnreadableAt: Iso.nullable(),
      unreadableCount: z.number().int(),
    }),
    trackingNumbers: z.array(z.object({ id: Id, e164: z.string() })),
    partnerFeeds: z.array(z.object({ kind: z.string(), status: z.string() })),
    webChats: z.array(z.object({ status: z.string() })),
  }),
  hasConsentText: z.boolean(),
});
export const OverviewResponse = z.object({ sources: z.array(SourceOverview), deployment: z.object({ inboundEmail: z.boolean(), publicHttps: z.boolean() }) });

export const SourceView = z.object({ id: Id, name: z.string(), kind: z.string(), active: z.boolean(), offSince: Iso.nullable(), hasToken: z.boolean(), createdAt: Iso });
export const SourceResponse = z.object({ source: SourceView });
export const OnOffResponse = z.object({
  source: SourceView,
  /** off: every path that stops, in words; on: every path that works again */
  paths: z.array(z.string()),
  sentence: z.string(),
});
export const WebhookRotatedResponse = z.object({ intakeUrl: z.string(), signingSecret: z.string(), createdAt: Iso });

export const PatchBody = z.strictObject({ name: z.string().trim().min(1).max(80).optional(), consentDisclosure: ConsentDisclosureInput.optional() });

export const PreviewBody = z.strictObject({
  inquiryType: z.enum(['buy', 'sell', 'rent', 'value', 'general']).optional(),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/).optional(),
  priceMinCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  priceMaxCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const PreviewResponse = z.object({
  rule: z.object({ id: Id, name: z.string() }).nullable(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('offer'), userId: Id, name: z.string() }),
    z.object({ kind: z.literal('pond'), pondId: Id, pondName: z.string(), reason: z.string() }),
  ]),
  considered: z.array(z.object({ userId: Id, name: z.string(), eligible: z.boolean(), reason: z.string().nullable() })),
  sentence: z.string(),
  firstResponse: z.enum(['queued', 'off']),
});

export const LEAD_SOURCES_RESPONSE_SCHEMAS = { OverviewResponse, SourceResponse, OnOffResponse, WebhookRotatedResponse, PreviewResponse };
