// Zod request/response schemas of api/comms. No input schema carries tenant_id (R-TEN-3); no response
// carries a confidence field (R-AST-13) — both asserted by schemas.test.ts.
import { z } from 'zod';

/**
 * A send-time (or preview) gate decision (core-compliance/2.0.0): allow | deny with the reasons and a
 * human explanation. `id` names the stored blocked-send row; allowed sends and previews are not stored.
 */
export const DecisionSchema = z.object({
  id: z.uuid().nullable(),
  outcome: z.enum(['allow', 'deny']),
  reasons: z.array(z.string()),
  explanation: z.string(),
  phase: z.enum(['preview', 'send']),
});

export const MessageSchema = z.object({
  id: z.uuid(),
  channel: z.enum(['sms', 'mms', 'email']),
  status: z.string(),
  statusReason: z.string().nullable(),
  purpose: z.enum(['marketing', 'informational']).nullable(),
  body: z.string(),
  subject: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
});

export const ComposeBody = z.strictObject({
  channel: z.enum(['sms', 'email']),
  body: z.string().trim().min(1).max(10_000),
  subject: z.string().trim().min(1).max(300).optional(),
  scheduleAt: z.iso.datetime({ offset: true }).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,100}$/),
  toPointId: z.uuid().optional(),
});

export const PreviewBody = z.strictObject({
  channel: z.enum(['sms', 'email']),
  body: z.string().trim().min(1).max(10_000),
  subject: z.string().trim().min(1).max(300).optional(),
  toPointId: z.uuid().optional(),
});

export const ComposeResponse = z.object({
  message: MessageSchema.nullable(),
  decision: DecisionSchema.nullable(),
  result: z.string(),
});

export const PreviewResponse = z.object({ decision: DecisionSchema, body: z.string() });

export const SendExistingBody = z.strictObject({});

export const CallBody = z.strictObject({ toPointId: z.uuid().optional() });
export const CallResponse = z.object({
  result: z.enum(['dialing', 'gate', 'failed']),
  callId: z.uuid().nullable(),
  bridgeToken: z.string().nullable(),
  reason: z.string().nullable(),
  decision: DecisionSchema,
});

export const OutcomeBody = z.strictObject({
  outcome: z.enum(['connected', 'left_voicemail', 'no_answer', 'wrong_number', 'bad_number', 'do_not_call_request', 'callback_requested']),
});
export const OutcomeResponse = z.object({ callId: z.uuid(), outcome: z.string(), recordedAs: z.enum(['call', 'task_for_current_owner']) });

export const ConsentBody = z.strictObject({
  kind: z.enum(['record', 'revoke']),
  pointId: z.uuid(),
  channel: z.enum(['sms', 'voice', 'email']),
  purpose: z.enum(['marketing', 'informational', 'all']),
  level: z.literal('express').optional(),
  evidence: z.strictObject({
    note: z.string().max(500).optional(),
    callId: z.uuid().optional(),
    callOffsetMs: z.number().int().min(0).max(36_000_000).optional(),
  }),
});
const ConsentStateSchema = z.object({ channel: z.string(), purpose: z.string(), status: z.string(), level: z.string() });
export const ConsentResponse = z.object({ eventId: z.uuid(), state: z.array(ConsentStateSchema), explanation: z.string() });

export const NotOptOutBody = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export const NotOptOutResponse = z.object({ restored: z.array(ConsentStateSchema) });

export const LiftBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export const LiftResponse = z.object({ id: z.uuid(), liftedAt: z.string() });

export const ResumeResponse = z.object({ resumedEnrollments: z.number().int() });

export const StreamTokenBody = z.strictObject({ purpose: z.enum(['play', 'download']).default('play') });
export const StreamTokenResponse = z.object({ token: z.string(), expiresAt: z.string(), url: z.string() });
export const TranscriptResponse = z.object({
  status: z.string(),
  language: z.string().nullable(),
  segments: z.array(z.object({ startMs: z.number(), endMs: z.number(), speaker: z.string().nullable(), text: z.string() })),
});

const NumberSchema = z.object({
  id: z.uuid(),
  e164: z.string(),
  purpose: z.string(),
  numberType: z.string(),
  assignedUserId: z.uuid().nullable(),
  registrationId: z.uuid().nullable(),
  registrationStatus: z.string().nullable(),
  smsCapable: z.boolean(),
  voiceCapable: z.boolean(),
  releasedAt: z.string().nullable(),
});
export const NumberResponse = z.object({ number: NumberSchema });
export const NumbersResponse = z.object({ numbers: z.array(NumberSchema) });
export const AcquireBody = z.strictObject({
  purpose: z.enum(['team_main', 'agent_direct', 'pond', 'tracking']),
  areaCode: z.string().regex(/^[2-9][0-9]{2}$/).optional(),
  assignedUserId: z.uuid().optional(),
  registrationId: z.uuid().optional(),
});
export const AttachRegistrationBody = z.strictObject({ registrationId: z.uuid().nullable() });

const RegistrationSchema = z.object({ id: z.uuid(), kind: z.string(), status: z.string(), useCase: z.string(), statusChangedAt: z.string() });
export const RegistrationResponse = z.object({ registration: RegistrationSchema });
export const RegistrationBody = z.strictObject({
  kind: z.enum(['a2p_campaign', 'toll_free_verification']),
  useCase: z.string().trim().min(3).max(200),
  sampleMessages: z.array(z.string().min(1).max(320)).min(1).max(5),
  optInDescription: z.string().trim().min(10).max(1000),
  providerCampaignRef: z.string().max(100).optional(),
});

export const DomainBody = z.strictObject({ domain: z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/) });
export const DomainResponse = z.object({
  domain: z.object({
    id: z.uuid(),
    domain: z.string(),
    spf: z.string(),
    dkim: z.string(),
    dmarc: z.string(),
    verifiedAt: z.string().nullable(),
    records: z.array(z.object({ type: z.string(), name: z.string(), value: z.string() })),
  }),
});
export const IdentityBody = z.strictObject({
  fromAddress: z.email(),
  displayName: z.string().trim().min(1).max(100),
  userId: z.uuid().optional(),
  domainId: z.uuid().optional(),
});
export const IdentityResponse = z.object({
  identity: z.object({ id: z.uuid(), fromAddress: z.string(), displayName: z.string(), userId: z.uuid().nullable(), domainId: z.uuid().nullable() }),
});

/** Every response schema of the module (snapshot-tested: no confidence*, no tenant id). */
export const COMMS_RESPONSE_SCHEMAS = {
  ComposeResponse,
  PreviewResponse,
  CallResponse,
  OutcomeResponse,
  ConsentResponse,
  NotOptOutResponse,
  LiftResponse,
  ResumeResponse,
  StreamTokenResponse,
  TranscriptResponse,
  NumberResponse,
  NumbersResponse,
  RegistrationResponse,
  DomainResponse,
  IdentityResponse,
};

/** Every request schema of the module (snapshot-tested: no tenant id input). */
export const COMMS_REQUEST_SCHEMAS = {
  ComposeBody,
  PreviewBody,
  SendExistingBody,
  CallBody,
  OutcomeBody,
  ConsentBody,
  NotOptOutBody,
  LiftBody,
  StreamTokenBody,
  AcquireBody,
  AttachRegistrationBody,
  RegistrationBody,
  DomainBody,
  IdentityBody,
};
