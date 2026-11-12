// Response and body schemas of module 48's routes. No confidence field and no tenant id anywhere (R-AST-13, R-TEN-3).
import { z } from 'zod';

const Iso = z.string();
const Reason = z.object({ code: z.string(), sentence: z.string() });

export const AnsweringResponse = z.object({
  state: z.enum(['dark', 'off', 'on']),
  reasons: z.array(Reason),
  pack: z.object({ version: z.string().nullable(), reviewedByCounselAt: Iso.nullable(), vendorReady: z.boolean(), cleared: z.boolean() }),
  playbook: z.object({ id: z.uuid(), approvedVersionId: z.uuid().nullable(), state: z.string() }).nullable(),
  enabled: z.object({ on: z.boolean(), sentence: z.string() }),
  settings: z.object({ answerAfterSeconds: z.number().int(), answerWhen: z.enum(['missed_and_after_hours', 'after_hours_only']), version: z.number().int() }),
  provider: z.object({ configured: z.boolean(), statusText: z.string() }),
  transfers: z.string(),
  attestationText: z.string(),
});

export const AnsweringSettingsBody = z
  .object({
    answerAfterSeconds: z.number().int().min(10).max(60),
    answerWhen: z.enum(['missed_and_after_hours', 'after_hours_only']),
    version: z.number().int().min(0),
    attestation: z.string().max(500).optional(),
  })
  .strict();

export const EnableBody = z.object({ attestation: z.string().max(500) }).strict();
export const DisableBody = z.object({}).strict();

export const CallVoiceResponse = z.object({
  callId: z.uuid(),
  state: z.enum(['in_progress', 'ended', 'recovered', 'not_answered']),
  sentence: z.string(),
  takeoverAt: Iso.nullable(),
  outcome: z.string().nullable(),
  outcomeSentence: z.string().nullable(),
  endReason: z.string().nullable(),
  transferOutcome: z.string().nullable(),
  ledger: z.array(z.object({ seq: z.number().int(), tool: z.string(), args: z.record(z.string(), z.string()), decision: z.enum(['allow', 'deny']), reasonCode: z.string(), occurredAt: Iso })),
  unlogged: z.array(z.object({ seq: z.number().int(), reason: z.string(), at: Iso })),
  handbackId: z.uuid().nullable(),
});

export const TestCallBody = z.object({ script: z.string().regex(/^[a-zA-Z]{1,40}$/), versionId: z.uuid().optional() }).strict();
export const TestCallResponse = z.object({
  sentence: z.string(),
  lines: z.array(z.object({ source: z.string(), text: z.string() })),
  ledger: z.array(z.object({ seq: z.number().int(), tool: z.string().nullable(), decision: z.enum(['allow', 'deny']), reasonCode: z.string() })),
  handback: z.object({ outcome: z.string(), endReason: z.string(), critical: z.boolean(), messageTopics: z.array(z.string()), noPhoneCallback: z.boolean(), confirmationChannel: z.string().nullable() }),
});
