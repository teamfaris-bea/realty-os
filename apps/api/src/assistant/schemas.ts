// Zod request/response schemas of api/assistant. No input schema carries a tenant id (R-TEN-3) and no
// response carries a confidence field (R-AST-13): asserted by architecture.test.ts (snapshot of keys).
// Every assistant card carries its explanation and its claims with evidence (A2).
import { z } from 'zod';

const Id = z.uuid();

export const EvidenceSchema = z.object({
  sourceType: z.string(),
  sourceId: Id,
  locator: z.record(z.string(), z.unknown()),
  snippet: z.string().nullable(),
  verified: z.boolean(),
  sourceAvailable: z.boolean(),
  label: z.string(),
});

export const ClaimSchema = z.object({
  id: Id,
  kind: z.string(),
  text: z.string(),
  needsReview: z.boolean(),
  reviewStatus: z.string(),
  due: z.object({ at: z.string(), display: z.string(), allDay: z.boolean() }).nullable(),
  evidence: z.array(EvidenceSchema),
});

export const ActionSchema = z.object({
  id: Id,
  kind: z.string(),
  category: z.string(),
  status: z.string(),
  contactId: Id.nullable(),
  contactName: z.string().nullable(),
  explanation: z.string(),
  primaryAction: z.enum(['send', 'acknowledge']),
  draft: z.object({ channel: z.enum(['sms', 'email']), subject: z.string().nullable(), body: z.string() }).nullable(),
  claims: z.array(ClaimSchema),
  createdAt: z.string(),
});

export const InboxResponse = z.object({ items: z.array(ActionSchema) });
export const ActionResponse = z.object({ action: ActionSchema });

const DecisionSchema = z.object({
  id: Id.nullable(),
  outcome: z.string(),
  reasons: z.array(z.string()),
  explanation: z.string(),
  phase: z.string(),
});

export const ApproveBody = z.strictObject({
  commandId: Id,
  editedPayload: z
    .strictObject({
      channel: z.enum(['sms', 'email']).optional(),
      subject: z.string().trim().min(1).max(300).optional(),
      body: z.string().trim().min(1).max(10_000).optional(),
      recommendation: z.string().trim().min(1).max(2_000).optional(),
    })
    .optional(),
  reviewedInboundSeq: z.number().int().min(0).optional(),
});
export const ApproveResponse = z.object({
  actionId: Id,
  status: z.string(),
  result: z.string(),
  messageId: Id.nullable(),
  decision: DecisionSchema.nullable(),
});
export const RejectResponse = z.object({ actionId: Id, status: z.string() });

export const ClaimReviewBody = z.strictObject({
  status: z.enum(['confirmed', 'corrected', 'rejected']),
  corrected: z
    .strictObject({
      text: z.string().trim().min(1).max(300).optional(),
      dueAt: z.iso.datetime({ offset: true }).optional(),
      allDay: z.boolean().optional(),
    })
    .optional(),
});
export const ClaimReviewResponse = z.object({ claimId: Id, reviewStatus: z.string() });

export const DraftRequestBody = z.strictObject({ commandId: Id });

// ---- playbooks ----

const StepsInput = z.array(z.unknown()).min(1).max(50);
export const CreatePlaybookBody = z.strictObject({
  templateKey: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  kind: z.enum(['new_lead_response', 'nurture', 'post_closing', 'booking_confirmation', 'reminder', 'document_chase']).optional(),
  scope: z.enum(['team', 'agent']).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  steps: StepsInput.optional(),
  tone: z.record(z.string(), z.unknown()).optional(),
});
export const CreateVersionBody = z.strictObject({ steps: StepsInput, tone: z.record(z.string(), z.unknown()).optional() });
export const VersionDecisionBody = z.strictObject({
  attestation: z.string().trim().min(10).max(500),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const VersionSchema = z.object({
  id: Id,
  versionNo: z.number().int(),
  status: z.string(),
  contentSha256: z.string(),
  steps: z.array(z.unknown()),
  tone: z.record(z.string(), z.unknown()),
  issues: z.array(z.object({ index: z.number().int(), stepKey: z.string().optional(), code: z.string(), detail: z.string().optional() })),
  createdAt: z.string(),
});
export const PlaybookSchema = z.object({
  id: Id,
  kind: z.string(),
  scope: z.enum(['team', 'agent']),
  ownerUserId: Id.nullable(),
  name: z.string(),
  templateKey: z.string().nullable(),
  approvedVersionId: Id.nullable(),
  versions: z.array(VersionSchema),
});
export const PlaybookResponse = z.object({ playbook: PlaybookSchema });
export const PlaybooksResponse = z.object({ playbooks: z.array(PlaybookSchema) });

// ---- enrollments ----

export const EnrollBody = z.strictObject({
  playbookId: Id,
  confirmReplace: z.boolean().optional(),
  anchor: z.strictObject({ kind: z.enum(['deal', 'appointment', 'task']), id: Id }).optional(),
});
export const EnrollmentSchema = z.object({
  id: Id,
  playbookId: Id,
  versionId: Id,
  contactId: Id,
  state: z.string(),
  pauseReason: z.string().nullable(),
  currentStep: z.number().int(),
  nextStepDueAt: z.string().nullable(),
});
export const EnrollmentResponse = z.object({ enrollment: EnrollmentSchema });

// ---- saved searches ----

const Criteria = z.record(z.string(), z.unknown());
export const ApproveSearchBody = z.strictObject({
  checked: z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).max(20),
  removed: z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).max(20).optional(),
  edits: Criteria.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  alertChannel: z.enum(['email', 'sms']).optional(),
  alertFrequency: z.enum(['instant', 'daily', 'weekly']).optional(),
});
export const ListingSchema = z.object({
  id: Id,
  addressLine1: z.string(),
  city: z.string(),
  postalCode: z.string(),
  status: z.string(),
  listPriceCents: z.number().nullable(),
  beds: z.number().nullable(),
  bathsX10: z.number().nullable(),
  sqft: z.number().nullable(),
  propertyType: z.string().nullable(),
});
export const SearchSchema = z.object({
  id: Id,
  contactId: Id,
  name: z.string(),
  status: z.string(),
  criteria: Criteria,
  criterionEvidence: z.record(z.string(), z.string()),
  unchecked: z.array(z.string()),
  prefill: Criteria,
  alertChannel: z.string(),
  alertFrequency: z.string(),
  matches: z.array(ListingSchema),
});
export const SearchResponse = z.object({ search: SearchSchema });
export const SearchesResponse = z.object({ searches: z.array(SearchSchema) });

export const ASSISTANT_REQUEST_SCHEMAS = { ApproveBody, ClaimReviewBody, DraftRequestBody, CreatePlaybookBody, CreateVersionBody, VersionDecisionBody, EnrollBody, ApproveSearchBody } as const;
export const ASSISTANT_RESPONSE_SCHEMAS = { InboxResponse, ActionResponse, ApproveResponse, RejectResponse, ClaimReviewResponse, PlaybookResponse, PlaybooksResponse, EnrollmentResponse, SearchResponse, SearchesResponse } as const;
